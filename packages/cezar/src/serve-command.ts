import { projectPaths } from './project-paths.ts';
import { productName } from './home/display.ts';
import { npmPackageIdentity, scopedNpxCommand } from './home/identity.ts';
import { once } from 'node:events';
import { createHostDiscovery } from './discovery/catalog.ts';
import { DelegationController } from './delegation/provision.ts';
import type { WorkerCleanupFactory } from './delegation/service.ts';
import { ProviderAuthService } from './core/provider-auth.ts';
import { detectEnvironment } from './core/backend-detect.ts';
import { getRepoInfo } from './server/git.ts';
import { SWEEP_MIN_INTERVAL_MS, sweepMergedBranches } from './server/repo-branch-sweep.ts';
import { previewToolEnabled } from './ci-wait/tool-catalog.ts';
import { PreviewHost } from './preview/host.ts';
import { ToolActivityTracker } from './activity/tool-activity.ts';
import { TaskWebhooks } from './runs/webhook.ts';
import type { RunStore } from './runs/store.ts';
import type { Home } from './home/home.ts';
import { RunManager } from './workflows/run.ts';
import { acquireCiResources } from './ci-wait/resources.ts';
import { createRunner } from './core/runner-factory.ts';
import { startServer } from './server/start-server.ts';
import { cockpitOriginFor, WorkspaceEventBus } from './server/server.ts';
import { ProviderRuntimeAuthObserver } from './server/provider-auth-runtime.ts';
import { watchSupervisor } from './desktop-supervisor.ts';
import { checkForUpdate } from './update-check.ts';
import { WorkspaceSemaphore } from './workspace/semaphore.ts';
import { openUrl } from './open-url.ts';
import { reconcileServeWorktrees, recoverServeProject, warnServeBind, printServeBanner, stopServe } from './serve-boot.ts';
import { CockpitOwnership } from './server/cockpit-ownership.ts';
import { recoverProjectMigration } from './project-migration/recovery.ts';
import { moveProjectWhenIdle } from './project-migration/auto.ts';
import { acquireServeListener, onTerminal, ignoreHangupOffTerminal, waitForHealth } from './serve-listener.ts';

/** The new scoped package has no binary named after it, so npx needs its `hsq` binary named. */
function restartCommand(pkgName: string): string {
  const identity = npmPackageIdentity(pkgName);
  return identity?.npmPackage === pkgName ? scopedNpxCommand(identity, 'latest') : `npx ${pkgName}@latest`;
}

export const defaultServeDeps = {
  CockpitOwnership, recoverProjectMigration, moveProjectWhenIdle, acquireServeListener, WorkspaceSemaphore, TaskWebhooks, previewToolEnabled, PreviewHost,
  cockpitOriginFor, ToolActivityTracker, RunManager, createRunner, sweepMergedBranches, DelegationController,
  ProviderAuthService, createHostDiscovery, WorkspaceEventBus, ProviderRuntimeAuthObserver, detectEnvironment,
  getRepoInfo, reconcileServeWorktrees, recoverServeProject, checkForUpdate, warnServeBind, startServer, once, printServeBanner, stopServe, onTerminal, ignoreHangupOffTerminal,
  watchSupervisor, waitForHealth, openUrl, process, console,
};

export type ServeDeps = typeof defaultServeDeps & {
  initWorkspace: (repoRoot: string, home: Home) => Promise<string | undefined>;
  openBootStore: (repoRoot: string) => RunStore;
  readOwnName: () => string;
  readOwnVersion: () => string;
  /** The process entry's worker cleanup, so the cockpit's delegation can destroy workers. */
  workerCleanup: WorkerCleanupFactory;
};

export async function serveCommand(
  home: Home,
  repoRoot: string,
  preferredPort: number,
  openBrowser: boolean,
  bindHost: string | undefined,
  restartExact: boolean,
  deps: ServeDeps,
): Promise<void> {
  const ownership = new deps.CockpitOwnership();
  deps.process.once('exit', () => ownership.releaseAll());
  // An unfinished project migration finishes before anything reads the project; the claim it
  // takes is the one boot keeps. A failure ends the boot with why.
  await deps.recoverProjectMigration(repoRoot, { ownership, keep: true });
  // With the release switch, an idle legacy project moves to .ai/squawk/ before anything serves it.
  await deps.moveProjectWhenIdle(repoRoot, { ownership, homes: [home] });
  await ownership.acquire(projectPaths(repoRoot).write);
  // Hold the real listener before workspace writes, recovery or background resources.
  // A probe followed by a later bind would allow another cwd to win in between.
  const listener = await deps.acquireServeListener(preferredPort, bindHost);
  const bootProjectId = await deps.initWorkspace(repoRoot, home);
  // ONE workspace semaphore for the whole process (spec 2026-07-20, step 2.5):
  // the boot manager and every lazily-built project context count their runs
  // against the same `resources.maxParallel`. The boot refresh() below is the
  // cache hook's first call; PUT /api/workspace/config (step 2.7) re-fires it.
  const semaphore = new deps.WorkspaceSemaphore({ home });
  await semaphore.refresh();
  // keepLive + recover() (#367): runs that were queued/running/waiting when
  // the previous process exited are re-queued or resumed instead of failed.
  const store = deps.openBootStore(repoRoot);
  // Before recovery (#589): the runs recovery re-queues, resumes or fails are exactly the
  // transitions an opted-in bot is waiting for. Deliveries wait until startServer knows its port.
  const taskWebhooks = new deps.TaskWebhooks({ home });
  taskWebhooks.attach({ id: bootProjectId ?? 'default', root: repoRoot, store });
  // ONE preview host for the whole process (#781), like the semaphore: ports are host-global, so
  // `port_held` must see every project's servers. Off unless `CEZ_PREVIEW=1`.
  const previewHost = deps.previewToolEnabled() ? new deps.PreviewHost({ home }) : undefined;
  // The port the cockpit bound, once `startServer` listens; the preview tool refuses it.
  let boundPort: number | undefined;
  const squawkPort = () => boundPort;
  // #774: the listener is already bound, so the boot manager knows its address before recovery
  // resumes anything; startServer re-sets the same value once it serves.
  const listenerAddress = listener.address();
  const cockpit = listenerAddress && typeof listenerAddress === 'object'
    ? { origin: deps.cockpitOriginFor(bindHost, listenerAddress.port), projectId: bootProjectId ?? 'default' }
    : undefined;
  // ONE tool activity tracker for the whole process (live activity view): run ids are unique
  // across projects, and the activity route reads every project's runs from it.
  const toolActivity = new deps.ToolActivityTracker();
  const manager: RunManager = new deps.RunManager(store, repoRoot, {
    home, createRunner: deps.createRunner, semaphore, preview: previewHost, squawkPort, cockpit, toolActivity, acquireCiResources,
    sweepBranches: (keep) => void deps.sweepMergedBranches({ root: repoRoot, store, manager, home }, { keep, minIntervalMs: SWEEP_MIN_INTERVAL_MS }),
  });
  const delegation = await deps.DelegationController.start(deps.workerCleanup);
  delegation.attachProject({ id: bootProjectId ?? 'default', root: repoRoot, store, manager, home });
  const providerAuth = new deps.ProviderAuthService();
  const discovery = deps.createHostDiscovery(repoRoot, providerAuth, home);
  delegation.service.setDiscovery(discovery);
  const workspaceEvents = new deps.WorkspaceEventBus();
  const providerRuntimeAuth = new deps.ProviderRuntimeAuthObserver(providerAuth, (status) => {
    workspaceEvents.emit('provider-status', status);
  }, undefined, home);
  const version = deps.readOwnVersion();

  const checks = await deps.detectEnvironment();
  const repo = await deps.getRepoInfo(repoRoot);

  await deps.reconcileServeWorktrees(repoRoot, repo, store, manager, previewHost, undefined, home);

  await deps.recoverServeProject(store, manager, providerRuntimeAuth, delegation, bootProjectId);

  // Update discovery (#368) — fire-and-forget; the banner prints whenever the
  // registry answers and /api/v1/health reports it as `latestVersion`.
  const pkgName = deps.readOwnName();
  const update: { latest?: string } = {};
  void deps.checkForUpdate(version).then((latest) => {
    if (!latest) return;
    update.latest = latest;
    deps.console.log(`\n  ⬆ ${productName('cezar')} ${latest} is available (running ${version}) — restart with: ${restartCommand(pkgName)}\n`);
  });

  const port = preferredPort;
  deps.warnServeBind(bindHost, port);
  const server = deps.startServer({
    home,
    createManager: (store, root, options) => new deps.RunManager(store, root, { ...options, acquireCiResources }),
    ownership,
    delegation,
    repoRoot,
    store,
    manager,
    version,
    update,
    bootProjectId,
    semaphore,
    bindHost,
    providerAuth,
    modelCatalog: discovery.models,
    providerRuntimeAuth,
    workspaceEvents,
    taskWebhooks,
    previewHost,
    squawkPort,
    toolActivity,
  }, port, listener);
  if (!server.listening) await deps.once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('cockpit TCP listener is unavailable');
  boundPort = address.port;
  const boundHost = address.address;
  // Releases v0.14.9 to v0.18.0 shipped a cockpit Update button. It starts the new version with
  // `--restart-exact` over an IPC channel and rolls back unless the new version reports this listener.
  if (restartExact && deps.process.send) {
    deps.process.send({ type: 'application-update-listening', host: boundHost, port: boundPort, repoRoot, version },
      () => deps.process.disconnect?.());
  }
  const url = `http://${boundHost.includes(':') ? `[${boundHost}]` : boundHost}:${boundPort}`;

  ownership.publishUrl(url);

  deps.printServeBanner(version, repoRoot, repo, checks, url);

  // One stop per process: a repeated signal must not start a second teardown over the first.
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    void deps.stopServe(server, signal, { store }).finally(() => deps.process.exit(0));
  };
  deps.process.on('SIGINT', () => shutdown('SIGINT'));
  deps.process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (deps.onTerminal()) deps.process.on('SIGHUP', () => shutdown('SIGHUP'));
  else deps.ignoreHangupOffTerminal();
  deps.watchSupervisor(() => shutdown('SIGTERM'));

  // Open the browser only once the server actually answers, so the first
  // paint is the cockpit and never a connection error.
  if (openBrowser) {
    const healthy = await deps.waitForHealth(`${url}/api/v1/health`, 5_000);
    if (healthy) deps.openUrl(url);
  }
}
