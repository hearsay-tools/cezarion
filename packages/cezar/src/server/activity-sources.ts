import { basename } from 'node:path';
import type { LiveActivitySource } from '../activity/publisher.ts';
import type { CiProgressSource } from '../activity/read-model.ts';
import type { ProjectContext } from './project-context.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

export type LoadedProject = Pick<ProjectContext, 'id' | 'root' | 'store' | 'manager'>;

export interface ActivitySourceDeps {
  bootContext: LoadedProject;
  contexts: { peek(projectId: string): LoadedProject | undefined };
  workspaceProjects: Pick<WorkspaceProjects, 'listVisibleProjects' | 'resolveBootProject' | 'projectFailure'>;
  /** The check progress of a loaded project's own CI watchers. */
  ciOf?: (project: LoadedProject) => CiProgressSource | undefined;
}

/**
 * The projects an activity read covers (spec 2026-11-05-live-activity-view), shared by the HTTP
 * route and the topics so both answer the same snapshot. The workspace read never builds a project
 * context, which would recover its runs: a project this process has not loaded has no store.
 */
export function createActivitySources({ bootContext, contexts, workspaceProjects, ciOf }: ActivitySourceDeps) {
  /** A store that cannot open never reads as empty (docs/areas/runs-store.md): it carries the failure. */
  const loadedSource = (project: LoadedProject, name: string): LiveActivitySource => ({
    projectId: project.id,
    name,
    ...(project.store.unavailable
      ? { unavailable: workspaceProjects.projectFailure(project.store.unavailable, project.id) }
      : { loaded: { store: project.store, isActive: (runId: string) => project.manager.isActive(runId), ci: ciOf?.(project) } }),
  });
  /** The registry, or undefined when it cannot be read. */
  const visibleProjects = () => workspaceProjects.listVisibleProjects().catch(() => undefined);
  const projectName = (projects: readonly { id: string; name: string }[] | undefined, id: string, root: string) =>
    projects?.find((project) => project.id === id)?.name ?? basename(root);
  return {
    loadedSource,
    /** One loaded project, named from the registry. */
    project: async (project: LoadedProject): Promise<LiveActivitySource> =>
      loadedSource(project, projectName(await visibleProjects(), project.id, project.root)),
    /** Every visible project; the ones this process has not loaded answer `loaded: false`. */
    workspace: async (): Promise<LiveActivitySource[]> => {
      const projects = await visibleProjects();
      const bootId = await workspaceProjects.resolveBootProject(projects);
      const sources = (projects ?? []).map((entry): LiveActivitySource => {
        const owned = entry.id === bootId ? { ...bootContext, id: bootId } : contexts.peek(entry.id);
        return owned ? loadedSource(owned, entry.name) : { projectId: entry.id, name: entry.name };
      });
      // The boot project this process runs is always in the snapshot, loaded or unavailable: also
      // when it is not registered, or when the registry cannot be read. It comes first.
      if (!projects?.some((entry) => entry.id === bootId)) sources.unshift(loadedSource({ ...bootContext, id: bootId }, projectName(undefined, bootId, bootContext.root)));
      return sources;
    },
  };
}
