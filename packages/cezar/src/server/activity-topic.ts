import type { ActivityDemand } from '../activity/demand.ts';
import { createActivityPublisher, type ActivityPublisherDeps } from '../activity/publisher.ts';
import { createProjectTopicPublisher, type ProjectEvent } from './activity-project-topic.ts';
import type { createActivitySources, LoadedProject } from './activity-sources.ts';
import { ProjectContextError } from './project-context.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';
import type { SocketHub } from './ws.ts';

/** The topic family of one project's activity: `activity:project:<projectId>`. */
export const ACTIVITY_PROJECT_TOPIC_PREFIX = 'activity:project:';
/** Every project's activity, for the global view. */
export const ACTIVITY_WORKSPACE_TOPIC = 'activity:workspace';

export interface ActivityTopicDeps {
  sources: ReturnType<typeof createActivitySources>;
  workspaceProjects: { resolveLiveProject(id: string): Promise<LoadedProject> } & Pick<WorkspaceProjects, 'projectFailure'>;
  /** The scope changes of the workspace topic: a project built, added or removed. */
  onProjectsChange: (listener: () => void) => () => void;
  /** The registry's project-added and project-removed events, for the project topics. */
  onProjectEvent: (listener: (event: ProjectEvent, projectId: string) => void) => () => void;
  demand: ActivityDemand;
  publisher: ActivityPublisherDeps;
}

/**
 * Register the activity topics (spec 2026-11-05-live-activity-view, Live transport). Both keep the
 * default `loopbackReadable: false`: they carry run titles, tool titles and request text. A
 * project id the registry does not know answers the hub's unknown-topic error. A known project
 * whose context cannot build yet gets a topic that sends that failure and binds once the project
 * resolves. A project topic follows the registry: a removed project sends
 * one unavailable frame and stops its work, and a re-added one binds to its new context, retrying
 * a failed resolution when the project's context gets built or a subscriber arrives. A project
 * id never holds a colon, so the names cannot collide.
 */
export function registerActivityTopics(hub: SocketHub, deps: ActivityTopicDeps): void {
  hub.registerTopicFamily(ACTIVITY_PROJECT_TOPIC_PREFIX, async (projectId) => {
    let start: Parameters<typeof createProjectTopicPublisher>[0];
    try {
      start = { project: await deps.workspaceProjects.resolveLiveProject(projectId) };
    } catch (error) {
      // Only an id the registry does not know names no topic. A known project whose context
      // cannot build now (folder missing, store unavailable) starts unbound with that failure.
      const unavailable = deps.workspaceProjects.projectFailure(error, projectId);
      if (unavailable.status === 404) return undefined;
      start = { projectId, unavailable };
    }
    return createProjectTopicPublisher(start, {
      sources: deps.sources,
      demand: deps.demand,
      publisher: deps.publisher,
      resolve: (id) => deps.workspaceProjects.resolveLiveProject(id),
      failure: (error, id) => deps.workspaceProjects.projectFailure(error, id),
      removedError: (id) => new ProjectContextError('unknown-project', id),
      onProjectEvent: deps.onProjectEvent,
    });
  });
  hub.registerTopic(ACTIVITY_WORKSPACE_TOPIC, createActivityPublisher({
    sources: () => deps.sources.workspace(),
    onScopeChange: deps.onProjectsChange,
    watch: () => deps.demand.watch(),
  }, deps.publisher));
}
