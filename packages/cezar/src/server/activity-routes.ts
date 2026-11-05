import { basename } from 'node:path';
import { Hono } from 'hono';
import type { ActivitySnapshot } from '@open-mercato/cezar-contract';
import { activityQuerySchema } from '@open-mercato/cezar-contract/activity';
import { ActivityDemand } from '../activity/demand.ts';
import { buildActivitySnapshot, unreadableLogger, type ActivityDeps, type ActivityProjectSource } from '../activity/read-model.ts';
import type { ProjectContext } from './project-context.ts';
import { queryZodValidator } from './validators.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

type LoadedProject = Pick<ProjectContext, 'id' | 'root' | 'store' | 'manager'>;

export interface ActivityRouteDeps {
  bootContext: LoadedProject;
  contexts: { peek(projectId: string): LoadedProject | undefined };
  workspaceProjects: Pick<WorkspaceProjects, 'listVisibleProjects' | 'resolveBootProject' | 'resolveLiveProject' | 'projectFailure'>;
  /** The projects activity readers watch; the CI progress registry reads it. */
  demand?: ActivityDemand;
  /** The trackers (tool activity, CI progress) and the clock. */
  activity?: Omit<ActivityDeps, 'onUnreadable'>;
}

/**
 * `GET /workspace/activity` (spec 2026-11-05-live-activity-view, Live transport): the activity
 * snapshot of one project (`project`), or of every visible project. The global read never builds a
 * project context, which would recover its runs: a project this process has not loaded answers
 * `loaded: false` with empty lists. A loaded project whose store cannot open carries the failure
 * its project routes answer in `unavailable`.
 */
export function createActivityRoutes({ bootContext, contexts, workspaceProjects, demand = new ActivityDemand(), activity = {} }: ActivityRouteDeps) {
  const deps: ActivityDeps = { ...activity, onUnreadable: unreadableLogger() };
  /** A store that cannot open never reads as empty (docs/areas/runs-store.md): it carries the failure. */
  const loadedSource = (project: LoadedProject, name: string): ActivityProjectSource => ({
    projectId: project.id,
    name,
    ...(project.store.unavailable
      ? { unavailable: workspaceProjects.projectFailure(project.store.unavailable, project.id) }
      : { loaded: { store: project.store, isActive: (runId: string) => project.manager.isActive(runId) } }),
  });
  const projectNames = async () => {
    const projects = await workspaceProjects.listVisibleProjects().catch(() => []);
    return { projects, name: (id: string, root: string) => projects.find((project) => project.id === id)?.name ?? basename(root) };
  };
  const snapshot = (sources: ActivityProjectSource[]): ActivitySnapshot => {
    const body = buildActivitySnapshot(sources, deps);
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
      const { name } = await projectNames();
      return c.json(snapshot([loadedSource(project, name(project.id, project.root))]), 200);
    }
    const { projects } = await projectNames();
    const bootId = await workspaceProjects.resolveBootProject(projects);
    return c.json(snapshot(projects.map((entry) => {
      const owned = entry.id === bootId ? { ...bootContext, id: bootId } : contexts.peek(entry.id);
      return owned ? loadedSource(owned, entry.name) : { projectId: entry.id, name: entry.name };
    })), 200);
  });
}
