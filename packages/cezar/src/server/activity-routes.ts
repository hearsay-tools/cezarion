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
  /** The projects activity readers watch; the CI progress registry reads it. */
  demand?: ActivityDemand;
  /** The trackers (tool activity, CI progress) and the clock. Default CI progress: each loaded
   *  project's own manager's registry, which its CI watchers publish to. */
  activity?: Omit<ActivityDeps, 'onUnreadable'>;
  /** The trackers' change signals, which wake the topics' publishers. */
  changes?: readonly ActivityChangeSource[];
  /** The live server's socket hub: when present, the activity topics register on it too. */
  socketHub?: SocketHub | undefined;
  /** Project added or removed (the workspace event bus). */
  workspaceEvents?: { on(listener: (event: string, data: unknown) => void): () => void };
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
  const plugged = new WeakSet<CiProgressRegistry>();
  /**
   * The check progress of the project's own CI watchers: its manager's registry, which need not be
   * the boot manager's (each workspace semaphore has its own). Each registry gets this route's
   * demand once. An explicit `activity.ci` replaces them all.
   */
  const progressOf = (project: LoadedProject): CiProgressSource | undefined => {
    if (activity.ci) return undefined;
    // A manager test double may carry no registry.
    const registry: CiProgressRegistry | undefined = project.manager.ciProgress;
    if (registry && !plugged.has(registry)) {
      registry.useDemand(demand);
      plugged.add(registry);
    }
    return registry;
  };
  const sources = createActivitySources({ ...routeDeps, ciOf: progressOf });
  if (socketHub) {
    registerActivityTopics(socketHub, {
      sources,
      workspaceProjects,
      demand,
      publisher: { ...deps, ...(routeDeps.changes ? { changes: routeDeps.changes } : {}),
        onBuildError: (error) => console.warn('[cez] activity snapshot failed; the next change retries it:', error) },
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
    for (const project of body.projects) if (project.loaded && !project.unavailable) demand.markRead(project.projectId);
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
