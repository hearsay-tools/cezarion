import type { ActivityDemand } from '../activity/demand.ts';
import { createActivityPublisher, type ActivityPublisherDeps } from '../activity/publisher.ts';
import type { createActivitySources, LoadedProject } from './activity-sources.ts';
import type { SocketHub } from './ws.ts';

/** The topic family of one project's activity: `activity:project:<projectId>`. */
export const ACTIVITY_PROJECT_TOPIC_PREFIX = 'activity:project:';
/** Every project's activity, for the global view. */
export const ACTIVITY_WORKSPACE_TOPIC = 'activity:workspace';

export interface ActivityTopicDeps {
  sources: ReturnType<typeof createActivitySources>;
  workspaceProjects: { resolveLiveProject(id: string): Promise<LoadedProject> };
  /** The scope changes of the workspace topic: a project built, added or removed. */
  onProjectsChange: (listener: () => void) => () => void;
  demand: ActivityDemand;
  publisher: ActivityPublisherDeps;
}

/**
 * Register the activity topics (spec 2026-11-05-live-activity-view, Live transport). Both keep the
 * default `loopbackReadable: false`: they carry run titles, tool titles and request text. A
 * project id the workspace cannot resolve answers the hub's unknown-topic error; the project
 * routes answer its real failure. A project id never holds a colon, so the names cannot collide.
 */
export function registerActivityTopics(hub: SocketHub, deps: ActivityTopicDeps): void {
  hub.registerTopicFamily(ACTIVITY_PROJECT_TOPIC_PREFIX, async (projectId) => {
    let project: LoadedProject;
    try {
      project = await deps.workspaceProjects.resolveLiveProject(projectId);
    } catch {
      return undefined;
    }
    return createActivityPublisher({
      sources: async () => [await deps.sources.project(project)],
      watch: () => deps.demand.watch(project.id),
    }, deps.publisher);
  });
  hub.registerTopic(ACTIVITY_WORKSPACE_TOPIC, createActivityPublisher({
    sources: () => deps.sources.workspace(),
    onScopeChange: deps.onProjectsChange,
    watch: () => deps.demand.watch(),
  }, deps.publisher));
}
