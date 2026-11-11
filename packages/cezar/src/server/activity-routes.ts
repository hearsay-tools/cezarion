import { logPrefix } from '../home/display.ts';
import { registerReportsTopic } from './reports-topic.ts';
import { Hono } from 'hono';
import type { ActivitySnapshot } from '@open-mercato/cezar-contract';
import { activityQuerySchema } from '@open-mercato/cezar-contract/activity';
import { ActivityDemand } from '../activity/demand.ts';
import type { ActivityChangeSource } from '../activity/publisher.ts';
import { buildActivitySnapshot, unreadableLogger, type ActivityDeps, type ActivityProjectSource, type CiProgressSource } from '../activity/read-model.ts';
import type { ToolActivityTracker } from '../activity/tool-activity.ts';
import type { CiProgressRegistry } from '../ci-wait/progress.ts';
import { createActivitySources, type ActivitySourceDeps, type LoadedProject } from './activity-sources.ts';
import { projectEventOf } from './activity-project-topic.ts';
import { registerActivityTopics } from './activity-topic.ts';
import { queryZodValidator } from './validators.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';
import type { SocketHub } from './ws.ts';

/** What the server process owns for the activity view (`ServerDeps` extends it). */
export interface ActivityServerDeps {
  /** The process's tool activity tracker: `serve` builds one and gives it to every run manager.
   *  Absent (an app built without boot's wiring), no run reports a tool. */
  toolActivity?: ToolActivityTracker | undefined;
}

export interface ActivityRouteDeps extends Omit<ActivitySourceDeps, 'ciOf'>, ActivityServerDeps {
  contexts: ActivitySourceDeps['contexts'] & { onContextBuilt?(listener: () => void): () => void };
  workspaceProjects: ActivitySourceDeps['workspaceProjects'] & Pick<WorkspaceProjects, 'resolveLiveProject'>;
  /** The projects activity readers watch: the HTTP route, the topics and every CI progress
   *  registry share this one instance. */
  demand?: ActivityDemand;
  /** The trackers (tool activity, CI progress) and the clock. Default CI progress: each loaded
   *  project's own manager's registry, which its CI watchers publish to. */
  activity?: Omit<ActivityDeps, 'onUnreadable'>;
  /** More change signals that wake the topics' publishers, besides the tool tracker and the CI
   *  progress registries. */
  changes?: readonly ActivityChangeSource[];
  /** The live server's socket hub: when present, the activity topics register on it too, and its
   *  close (the server's close path) releases what the route plugged into the CI registries. */
  socketHub?: SocketHub | undefined;
  /** Project added or removed (the workspace event bus). */
  workspaceEvents?: { on(listener: (event: string, data: unknown) => void): () => void };
}

/**
 * The CI progress registries the activity view reads (spec 2026-11-05-live-activity-view, CI check
 * progress). A project's registry is its own manager's, which need not be the boot manager's (each
 * workspace semaphore has its own). The first read of a project plugs its registry in once: the
 * registry gets the process's one activity demand, and its changes wake the topics' publishers.
 * `release` undoes every plug; the server's close path calls it. After it, a read that was still
 * in flight then plugs nothing: no demand or listener outlives the server.
 */
export function ciProgressPlugs(demand: ActivityDemand) {
  let closed = false;
  const plugged = new WeakSet<CiProgressRegistry>();
  const releases: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const changes: ActivityChangeSource = {
    onChange: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const progressOf = (project: LoadedProject): CiProgressSource | undefined => {
    // A manager test double may carry no registry.
    const registry: CiProgressRegistry | undefined = project.manager.ciProgress;
    if (registry && !closed && !plugged.has(registry)) {
      plugged.add(registry);
      releases.push(registry.useDemand(demand));
      releases.push(registry.onChange(() => { for (const listener of [...listeners]) listener(); }));
    }
    return registry;
  };
  const release = () => {
    closed = true;
    for (const undo of releases.splice(0)) undo();
  };
  return { progressOf, changes, release, closed: () => closed };
}

/**
 * `GET /workspace/activity` (spec 2026-11-05-live-activity-view, Live transport): the activity
 * snapshot of one project (`project`), or of every visible project. The global read never builds a
 * project context, which would recover its runs: a project this process has not loaded answers
 * `loaded: false` with empty lists. A loaded project whose store cannot open carries the failure
 * its project routes answer in `unavailable`. With a socket hub, the same snapshots also go out on
 * the topics `activity:project:<id>` and `activity:workspace`, whose subscribers hold the same
 * demand.
 */
export function createActivityRoutes(routeDeps: ActivityRouteDeps) {
  const { contexts, workspaceProjects, demand = new ActivityDemand(), activity = {}, socketHub, workspaceEvents, toolActivity } = routeDeps;
  const tools = activity.tools ?? toolActivity;
  const deps: ActivityDeps = { ...activity, ...(tools ? { tools } : {}), onUnreadable: unreadableLogger() };
  // An explicit `activity.ci` replaces every project's registry.
  const ci = ciProgressPlugs(demand);
  const sources = createActivitySources({ ...routeDeps, ciOf: (project) => (activity.ci ? undefined : ci.progressOf(project)) });
  // The publishers wake on the tool tracker's changes and on every plugged registry's changes.
  const changes: ActivityChangeSource[] = [...(routeDeps.changes ?? []), ...(toolActivity && !activity.tools ? [toolActivity] : []), ci.changes];
  if (socketHub) {
    socketHub.onClose(ci.release);
    registerReportsTopic(socketHub, workspaceProjects);
    registerActivityTopics(socketHub, {
      sources,
      workspaceProjects,
      demand,
      publisher: { ...deps, changes,
        onBuildError: (error) => console.warn(`${logPrefix()} activity snapshot failed; the next change retries it:`, error) },
      onProjectsChange: (listener) => {
        const offBuilt = contexts.onContextBuilt?.(listener);
        const offEvents = workspaceEvents?.on((event) => { if (event === 'project-added' || event === 'project-removed') listener(); });
        return () => { offBuilt?.(); offEvents?.(); };
      },
      onProjectEvent: (listener) => workspaceEvents?.on((event, data) => {
        const change = projectEventOf(event, data);
        if (change) listener(change.event, change.projectId);
      }) ?? (() => undefined),
    });
  }
  const snapshot = (projects: ActivityProjectSource[]): ActivitySnapshot => {
    const body = buildActivitySnapshot(projects, deps);
    // A read that answers after the server closed marks no demand.
    if (!ci.closed()) for (const project of body.projects) if (project.loaded && !project.unavailable) demand.markRead(project.projectId);
    return body;
  };
  return new Hono().get('/workspace/activity', queryZodValidator(activityQuerySchema), async (c) => {
    const { project: raw } = c.req.valid('query');
    if (raw !== undefined) {
      let project: LoadedProject;
      try {
        project = await workspaceProjects.resolveLiveProject(raw);
      } catch (error) {
        const failure = workspaceProjects.projectFailure(error, raw);
        return c.json({ error: failure.error }, failure.status);
      }
      if (project.store.unavailable) {
        const failure = workspaceProjects.projectFailure(project.store.unavailable, project.id);
        return c.json({ error: failure.error }, failure.status);
      }
      return c.json(snapshot([await sources.project(project)]), 200);
    }
    return c.json(snapshot(await sources.workspace()), 200);
  });
}
