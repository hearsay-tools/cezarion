import { reportsIndex } from '../artifacts/reports-index.ts';
import { projectPaths } from '../project-paths.ts';
import { prepareHomeLifecycle } from '../home/entry.ts';
import { defined } from '../core/defined.ts';
import { ArchiveOnMergeCoordinator } from './archive-on-merge.ts';
import { CompletionActionCoordinator } from './completion-actions.ts';
import { resolveArchiveOnMerge } from '../archive-on-merge-setting.ts';
import { createWorkspaceProjects, createWorkspaceProjectContexts, createTaskWebhooks } from './workspace-projects.ts';
import { localTimeZone } from '@open-mercato/cezar-contract/zoned-time';
import type { AutomationStore } from '../automations/store.ts';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { GithubPoller } from '../automations/github-poller.ts';
import { githubRepository, type GithubRepository } from '../automations/github-repository.ts';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { AutomationProjectUnavailableError } from '../automations/schedule-runner.ts';
import { launchAutomationRun, launchScheduledRun, rebaselineIdleAutomations, reconcileAutomationReceipts } from '../automations/task-template.ts';
import type { Server } from 'node:http';
import { basename } from 'node:path';
import { getRequestListener, serve, type ServerType } from '@hono/node-server';
import type { RunManager } from '../workflows/run.ts';
import { getBranchHead, getRepoInfo } from './git.ts';
import { loadConfig } from '../config.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { armPreview, projectWarmupEnabled, sweepRegisteredPreviewLeftovers } from './project-context.ts';
import { resolveCapabilities } from './capabilities.ts';
import { createSocketHub, socketHubRoute } from './ws.ts';
import { attachUpgradeRouter } from './upgrade-router.ts';
import { createPreviewSockets } from './preview-sockets.ts';
import { forgeRepositoryUrl, resolveForge, forgeWebRoot, resolveForgeRoot } from './forge/index.ts';
import { withProjectAdmission } from './cockpit-ownership.ts';
import { closingSignal, prepareBeforeTicks, prepareProject, prepareProjects } from '../project-migration/auto.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { cockpitOriginFor } from './server-deps.ts';
import { createApp, WorkspaceEventBus, verifyWsUpgrade, type ServerDeps } from './server.ts';

export function startServer(deps: ServerDeps, port: number, listener?: Server): ServerType & { shutdownForRestart: () => Promise<void> } {
  const attachHomeLifecycle = prepareHomeLifecycle(deps.home);
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  // The subscription hub rides the same HTTP server (one port, zero config):
  // createApp registers the topics, the `upgrade` hook below owns the socket.
  const socketHub = deps.socketHub ?? createSocketHub();
  // `cezar_preview_serve` refuses the cockpit's own port: the one the listener BOUND (`--port 0`).
  let listeningPort: number | undefined;
  const squawkPort = deps.squawkPort ?? (() => listeningPort);
  const workspaceProjects = deps.workspaceProjects ?? createWorkspaceProjects({ bootRoot: deps.repoRoot, bootProjectId: deps.bootProjectId, home: deps.home });
  const registeredProjects = () => workspaceProjects.listProjects();
  const automationCoordinator = new AutomationCoordinator({ listProjects: () => registeredProjects().then((projects) => prepareProjects(projects, { ownership: deps.ownership, homes: [deps.home] })) }); // projects arrive prepared
  const bootProjectId = deps.bootProjectId ?? 'default';
  const bootAutomationStore = () => automationCoordinator.store(bootProjectId, deps.repoRoot)!; // resolve after preparation
  const taskWebhooks = createTaskWebhooks(deps);
  // #774: the bound origin every agent env carries (`CEZ_COCKPIT_URL`), so `cez automation` calls
  // this cockpit instead of probing ports. Unset until `listening`; a project built after that is
  // addressed in `prepareManager`, before its recovery resumes anything.
  let cockpitOrigin: string | undefined;
  const addressManager = (project: { id: string; manager: Pick<RunManager, 'setCockpitAddress'> }) => {
    if (cockpitOrigin) project.manager.setCockpitAddress?.({ origin: cockpitOrigin, projectId: project.id });
  };
  const sharedContexts = createWorkspaceProjectContexts(deps, taskWebhooks, {
    ownership: deps.ownership,
    listProjects: registeredProjects,
    squawkPort,
    automationStore: (projectId, root) => automationCoordinator.store(projectId, root)!,
    addressManager,
  });
  const archiveDeps: import('./archive-on-merge.ts').ArchiveOnMergeDeps = prepareBeforeTicks({ ownership: deps.ownership, homes: [deps.home] }, {
    projects: async () => {
      const boot = { id: bootProjectId, root: deps.repoRoot, status: 'ok' as const };
      return [boot, ...(await registeredProjects()).filter(project => project.id !== bootProjectId && project.root !== deps.repoRoot)];
    },
    enabled: async project => resolveArchiveOnMerge(await loadConfig(project.root, deps.home), await loadWorkspaceConfig(deps.home.workspaceConfig)).enabled,
    repository: async project => {
      const repository = await resolveForgeRoot(project.root, deps.forgeFactory).discoverRepository();
      return repository.status === 'resolved' ? forgeRepositoryUrl('github', repository.handle.owner, repository.handle.name) : undefined;
    },
    withStore: (project, work) => withProjectAdmission(projectPaths(project.root).write, function admittedStore() {
      if (project.root === deps.repoRoot) return work(deps.store, id => deps.manager.isActive?.(id) ?? false, () => server.listening);
      return sharedContexts.withMaintenanceStore(project.id, (store, valid) =>
        work(store, id => sharedContexts.peek(project.id)?.manager.isActive(id) ?? false, valid));
    }, () => undefined),
    lookup: (root, identities, signal) => resolveForgeRoot(root, deps.forgeFactory).mergedPullRequests(identities, signal),
  });
  const archiveOnMerge = new ArchiveOnMergeCoordinator(archiveDeps);
  const completionActions = new CompletionActionCoordinator({
    projects: archiveDeps.projects,
    withStore: (project, work) => archiveDeps.withStore(project, (store, _active, valid) => work(store, valid)),
    forge: async project => {
      const info = await getRepoInfo(project.root);
      const driver = resolveForge(info, deps.forgeFactory);
      const repository = info?.remote ? forgeWebRoot(info.remote) : null;
      return driver && repository ? { driver, repository } : undefined;
    },
    head: (project, branch) => getBranchHead(project.root, branch),
  });
  // Injected contexts (tests) skip `prepareManager`.
  sharedContexts.onContextBuilt(addressManager);
  // #801: Automations can be disabled. Off, the flag must remove the BEHAVIOR and not merely
  // the UI — no scheduler, no GitHub polling, no launched runs — so every entry point into the
  // workspace scheduler below is gated on it. Read per call rather than captured, for the same
  // reason `capabilities()` is inside `createApp`: tests flip the variable between apps.
  const automationsEnabled = () => resolveCapabilities(process.env, deps.bindHost).automations;
  let rescheduleAutomations = () => {};
  const app = createApp({
    ...deps,
    taskWebhooks,
    contexts: sharedContexts,
    automationStore: bootAutomationStore,
    workspaceEvents,
    socketHub,
    squawkPort,
    workspaceProjects,
    archiveOnMergeChanged: () => archiveOnMerge.invalidate(),
    automationsChanged: () => rescheduleAutomations(),
  });
  // SECURITY: default to loopback. This server executes agents locally and its endpoints are
  // same-origin-trusted (only /api/health is CORS-open); binding to a non-loopback host would
  // expose an agent-executing box to the network. `bindHost` exists only for a deliberate
  // hosted/VPS deployment (which also flips CEZ_REMOTE to gate the local-handoff endpoints) —
  // The CLI passes it only when explicitly requested; normal startup stays on loopback.
  const serverOptions: Parameters<typeof serve>[0] = {
    fetch: (request, env) => app.fetch(request, env),
    port,
    hostname: deps.bindHost ?? '127.0.0.1',
  };
  // The CLI already owns this listener before recovery. Replace its temporary 503
  // handler without closing/rebinding; direct server callers retain normal startup.
  if (listener) {
    listener.removeAllListeners('request');
    listener.on('request', getRequestListener(serverOptions.fetch, defined({ hostname: serverOptions.hostname })));
  }
  const server = listener ?? serve(serverOptions);
  attachHomeLifecycle(server);
  // EVERY registered project, remote or not: a schedule needs none. `github` is present only for
  // a github.com remote, and only then does the project's handle poll.
  const automationProjects = new Map<string, { root: string; github?: GithubRepository }>();
  const rememberAutomationProject = async (id: string, root: string): Promise<void> => {
    const github = githubRepository(root, (await getRepoInfo(root))?.remote);
    automationProjects.set(id, { root, ...(github ? { github } : {}) });
  };
  const emitWorkspaceAutomationChange = (projectId: string) => (automationId: string, revision: number) =>
    workspaceEvents.emit('automation-change', { project: projectId, automationId, revision });
  /**
   * The boot brake for one project, at boot and for a project registered after it: an enabled
   * poll idle past its lookback is re-baselined rather than resumed from a stale cursor. Only a
   * project with a github.com remote: its polls are the only ones the timer arms, so a poll
   * without one never succeeds and would be re-baselined on every boot, forever.
   */
  const brakeIdleAutomations = (id: string, automationStore: AutomationStore | undefined): void => {
    if (!automationStore || !automationProjects.get(id)?.github) return;
    rebaselineIdleAutomations(automationStore, emitWorkspaceAutomationChange(id));
  };
  const automationScheduler = new WorkspaceAutomationScheduler({
    coordinator: automationCoordinator,
    handle: (projectId, store) => {
      const project = automationProjects.get(projectId);
      if (!project) return undefined;
      const timeZone = localTimeZone();
      const launchContext = async () => projectId === (deps.bootProjectId ?? 'default')
        ? { root: deps.repoRoot, manager: deps.manager, store: deps.store }
        : await sharedContexts.context(projectId);
      return {
        projectId,
        store,
        timeZone,
        ...(project.github ? { github: { ...project.github, poller: new GithubPoller() } } : {}),
        onChange: emitWorkspaceAutomationChange(projectId),
        // Building a lazy project's context reconciles on its own; the explicit call covers the
        // boot project and a context built before another process left the reservation.
        reconcileReceipts: async () => { reconcileAutomationReceipts(store, (await launchContext()).store); },
        // A run store that cannot open (#779) launches nothing. Firing anyway would count every
        // refusal towards the auto-pause, and the pause would outlive the restart that fixed it.
        ready: async () => {
          try {
            const { store: runs } = await launchContext();
            if (runs.unavailable) throw runs.unavailable;
          } catch (error) {
            if (error instanceof RunStoreOpenError) throw new AutomationProjectUnavailableError(error.message, { cause: error });
            throw error;
          }
        },
        launchSchedule: async (definition, occurrence, receiptId) => {
          const context = await launchContext();
          return launchScheduledRun({
            root: context.root,
            manager: context.manager,
            store: context.store,
            definition,
            occurrence,
            receiptId,
            projectName: basename(context.root),
            timeZone,
          });
        },
        launch: async (definition, candidate, receiptId) => {
          const context = await launchContext();
          return launchAutomationRun({
            root: context.root,
            manager: context.manager,
            store: context.store,
            definition,
            candidate,
            receiptId,
          });
        },
      };
    },
  });
  // The scheduler is inert until `start()` anyway (it constructs `stopped`), but the gate is
  // stated here rather than inherited from that detail: a definition saved while the flag is off
  // must not even ask the coordinator to refresh.
  rescheduleAutomations = () => {
    if (!automationsEnabled()) return;
    void automationScheduler.reschedule();
  };
  const unsubscribe = workspaceEvents.on((event, data) => {
    if (event === 'project-added') {
      const project = (data as { project?: { id?: unknown; root?: unknown; status?: unknown } }).project;
      if (project && typeof project.id === 'string' && typeof project.root === 'string' && project.status !== 'missing') {
        const { id, root } = project as { id: string; root: string };
        void prepareProject(root, { ownership: deps.ownership, homes: [deps.home] }).then(() => rememberAutomationProject(id, root)).then(() => {
          if (!automationsEnabled()) return;
          brakeIdleAutomations(id, automationCoordinator.store(id, root));
          return rescheduleAutomations();
        }).catch(() => undefined);
      }
    } else if (event === 'project-removed') {
      const id = (data as { id?: unknown }).id;
      if (typeof id === 'string') {
        automationCoordinator.remove(id);
        automationProjects.delete(id);
        rescheduleAutomations();
      }
    }
  });
  const lifecycle = closingSignal(server);
  const startBackgroundServices = () => {
    if (!deps.store.unavailable) reportsIndex(deps.store).start();
    void registeredProjects().then(async (projects) => {
      const all = projects.some((project) => project.root === deps.repoRoot)
        ? projects : [{ id: deps.bootProjectId ?? 'default', root: deps.repoRoot, status: 'ok' as const }, ...projects];
      await prepareProjects(all, { ownership: deps.ownership, homes: [deps.home], stopped: lifecycle.stopped }); // before any touch below
      if (!lifecycle.stopped()) { archiveOnMerge.start(); completionActions.start(); }
      // #781: every registered project's preview leftovers, not only the boot project's.
      void sweepRegisteredPreviewLeftovers(all, deps.previewHost).catch(() => 0);
      // #667: build every other project's context now, so the first click on one does not pay
      // its store open, worktree sweeps and recovery. The boot project is built already.
      // Not after a close that landed while the registry was being read: `disposeAll` has run, and
      // a warm-up started now would build contexts nothing will ever dispose.
      if (projectWarmupEnabled() && server.listening) {
        const bootId = deps.bootProjectId ?? 'default';
        void sharedContexts.warmAll(all.filter((project) => project.id !== bootId && project.root !== deps.repoRoot))
          .catch(() => undefined);
      }
      // No automation warmup while opted out, or after discovery outlives the listener; the final continuation also checks for close during Git inspection.
      if (!automationsEnabled() || !server.listening) return;
      void Promise.all(all.map(async (project) => {
        await rememberAutomationProject(project.id, project.root);
        if (!server.listening) return;
        const automationStore = automationCoordinator.store(project.id, project.root);
        const runStore = project.id === (deps.bootProjectId ?? 'default')
          ? deps.store
          : sharedContexts.peek(project.id)?.store;
        // A run store that could not open (#779) cannot say which receipts launched a run.
        if (automationStore && runStore && !runStore.unavailable) reconcileAutomationReceipts(automationStore, runStore);
        brakeIdleAutomations(project.id, automationStore);
      })).then(() => server.listening ? automationScheduler.start() : undefined).catch(() => undefined);
    }).catch(() => undefined);
  };
  if (server.listening) startBackgroundServices();
  else server.once('listening', startBackgroundServices);
  armPreview(deps.store, projectPaths(deps.repoRoot).write, deps.previewHost);
  const previewSockets = createPreviewSockets({
    host: deps.previewHost, cockpitOrigin: () => cockpitOrigin,
    verify: (req) => verifyWsUpgrade(req, deps.bindHost),
    resolveProject: (projectId) => workspaceProjects.lookupProject(projectId),
  });
  server.once('close', () => {
    unsubscribe(); archiveOnMerge.stop(); completionActions.stop(); automationScheduler.stop(); void sharedContexts.disposeAll(); void deps.delegation?.close();
    socketHub.close();
    previewSockets.close();
    void deps.previewHost?.close().catch(() => undefined);
  });
  // The one `upgrade` listener: the subscription bus and the preview's sockets (hearsay-tools/cezarion#781).
  attachUpgradeRouter(server, [socketHubRoute(socketHub, (req) => verifyWsUpgrade(req, deps.bindHost)), ...previewSockets.routes]);
  const shutdownForRestart = async (): Promise<void> => {
    lifecycle.stop(); archiveOnMerge.stop(); completionActions.stop();
    void sharedContexts.disposeAll(); // close every built secondary project before old process exits
    deps.store.flush();
    socketHub.close();
    // Dev servers run in their own process groups: they outlive Squawk unless stopped here.
    // A failed release must not abort the restart halfway, with the store flushed and the port still bound.
    await deps.previewHost?.close().catch(() => undefined);
    previewSockets.close();
    await deps.delegation?.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    // Last, with no request left to serve: write what is still pending and release every claim,
    // so the replacement process finds the live runs nobody's, as a clean stop leaves them (#779).
    deps.store.close();
  };
  // The task webhook's thread links name the port the listener BOUND (#594 review): `--port 0`
  // asks for an ephemeral one, so the requested number is not an address. Deliveries queue
  // behind this, so none goes out before it is set.
  const setTaskWebhookOrigin = () => {
    const address = server.address();
    const bound = address && typeof address === 'object' ? address.port : port;
    listeningPort = bound;
    cockpitOrigin = cockpitOriginFor(deps.bindHost, bound);
    taskWebhooks.setOrigin(cockpitOrigin);
    addressManager({ id: bootProjectId, manager: deps.manager });
    for (const id of sharedContexts.ids()) {
      const context = sharedContexts.peek(id);
      if (context) addressManager(context);
    }
  };
  if (server.listening) setTaskWebhookOrigin();
  else server.once('listening', setTaskWebhookOrigin);
  return Object.assign(server, { shutdownForRestart });
}
