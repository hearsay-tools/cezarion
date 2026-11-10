import { realpathSync } from 'node:fs';
import { Hono } from 'hono';
import { projectMigrationRequestSchema, type ProjectMigrationError, type ProjectMigrationRequest, type ProjectMigrationResponse } from '@open-mercato/cezar-contract/project-migration';
import { projectPaths } from '../project-paths.ts';
import { dryRunAnswer, migrationAnswer } from '../project-migration/answer.ts';
import { migrateProject, ProjectMigrationRefusedError } from '../project-migration/engine.ts';
import { afterProjectRecovery, ProjectMigrationRecoveryError, recoverProjectMigration } from '../project-migration/recovery.ts';
import type { ArchiveOnMergeDeps } from './archive-on-merge.ts';
import { PROJECT_MIGRATION_SWITCH } from '../project-migration/switch.ts';
import type { PreviewHost } from '../preview/host.ts';
import {
  anotherCockpitOwner, assertProjectAdmitted, CockpitAlreadyRunningError, CockpitOwnership, ProjectMigrationBusyError, ProjectMigrationFencedError,
} from './cockpit-ownership.ts';
import { fenceProjectContext, ProjectContextError, type ProjectContexts } from './project-context.ts';
import { jsonZodValidator } from './validators.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

export { recoverProjects } from '../project-migration/recovery.ts';

/** The archive and completion stores, each opened only after the project's unfinished journal
 *  finishes: recovery runs before `withStore` opens its admission lease. */
export function recoverBeforeStores(ownership: CockpitOwnership | undefined, deps: ArchiveOnMergeDeps): ArchiveOnMergeDeps {
  return { ...deps, withStore: (project, work) => afterProjectRecovery(project.root, ownership, () => { return deps.withStore(project, work); }) };
}

/**
 * `POST /api/v1/projects/:projectId/migration` (hearsay-tools/cezarion#3089): the owning cockpit
 * migrates one of its projects itself, at the request of `migrate-project`. Off (404) until the P5
 * gate turns the command on. A workspace route on purpose: a project route holds an admission
 * lease for its whole length, and the fence's drain would wait on it.
 */

export interface ProjectMigrationRouteDeps {
  /** The P5 gate (`PROJECT_MIGRATION_SWITCH`); tests pass true through `ServerDeps.projectMigration`. */
  enabled: boolean;
  /** Hosted mode: the migration runs only from the host. */
  hosted: () => boolean;
  /** The project's registry entry, after the same id resolution as the other project routes. */
  project: (projectId: string) => Promise<{ id: string; root: string; status: string } | undefined>;
  /** The root this cockpit serves as its boot project. */
  bootRoot: string;
  contexts: Pick<ProjectContexts, 'context' | 'dispose'>;
  ownership: CockpitOwnership;
  preview?: Pick<PreviewHost, 'releaseProject'> | undefined;
}

export interface ProjectMigrationServerDeps {
  /** Explicit fixture seam for the P5 gate; production uses `PROJECT_MIGRATION_SWITCH`, which stays false. */
  projectMigration?: boolean | undefined;
}

/** The route family, mounted beside the project registry routes. */
export function createProjectMigrationRoutes(options: {
  deps: ProjectMigrationServerDeps & { ownership?: CockpitOwnership | undefined; previewHost?: Pick<PreviewHost, 'releaseProject'> | undefined };
  workspaceProjects: Pick<WorkspaceProjects, 'resolveProjectId' | 'listVisibleProjects'>;
  bootRoot: string;
  contexts: Pick<ProjectContexts, 'context' | 'dispose'>;
  hosted: () => boolean;
}) {
  const { deps, workspaceProjects } = options;
  const routeDeps: ProjectMigrationRouteDeps = {
    enabled: deps.projectMigration ?? PROJECT_MIGRATION_SWITCH,
    hosted: options.hosted,
    project: async (raw) => {
      const resolved = await workspaceProjects.resolveProjectId(raw);
      if ('error' in resolved) return undefined;
      return (await workspaceProjects.listVisibleProjects()).find((project) => project.id === resolved.id);
    },
    bootRoot: options.bootRoot,
    contexts: options.contexts,
    ownership: deps.ownership ?? new CockpitOwnership(),
    preview: deps.previewHost,
  };
  return new Hono()
    .post('/projects/:projectId/migration', jsonZodValidator(projectMigrationRequestSchema), async (c) => {
      const answer = await answerProjectMigration(routeDeps, c.req.param('projectId'), c.req.valid('json'), c.req.raw.signal);
      return answer.status === 200 ? c.json(answer.body, 200) : c.json(answer.body, answer.status);
    });
}

export type ProjectMigrationRouteAnswer =
  | { status: 200; body: ProjectMigrationResponse }
  | { status: 403 | 404 | 409 | 500; body: ProjectMigrationError };

function sameRoot(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
}

export async function answerProjectMigration(deps: ProjectMigrationRouteDeps, projectId: string, request: ProjectMigrationRequest, signal?: AbortSignal): Promise<ProjectMigrationRouteAnswer> {
  if (!deps.enabled) return { status: 404, body: { error: 'Project migration is not available in this release' } };
  if (deps.hosted()) return { status: 403, body: { error: 'Project migration runs only from the host the cockpit serves' } };
  const project = await deps.project(projectId);
  if (!project) return { status: 404, body: { error: `unknown project: ${projectId}` } };
  if (project.status === 'missing') return { status: 409, body: { error: `project folder not found: ${project.id}` } };
  // The boot context is not rebuilt after its store closes, so this cockpit never migrates it.
  if (sameRoot(project.root, deps.bootRoot)) {
    return { status: 409, body: { error: `This cockpit serves ${project.root} as its boot project. Stop it, then run migrate-project again` } };
  }
  const owner = anotherCockpitOwner(projectPaths(project.root).write);
  if (owner) return { status: 409, body: { error: `Another cockpit (pid ${owner.pid}${owner.url ? ` at ${owner.url}` : ''}) owns ${project.root}; run migrate-project against it` } };
  try {
    return { status: 200, body: await migrate(deps, project, request.dryRun, signal) };
  } catch (error) {
    return failure(error);
  }
}

async function migrate(deps: ProjectMigrationRouteDeps, project: { id: string; root: string }, dryRun: boolean, signal: AbortSignal | undefined): Promise<ProjectMigrationResponse> {
  const recovered = await recoverProjectMigration(project.root, { ownership: deps.ownership, keep: true });
  if (dryRun) {
    assertProjectAdmitted(projectPaths(project.root).write);
    return dryRunAnswer(project.root, recovered !== undefined);
  }
  // The unfinished migration was this migration: it is complete now.
  if (recovered) return migrationAnswer(recovered);
  // A built context (recovery and admission included), then the strict fence over it.
  const context = await deps.contexts.context(project.id);
  const fence = await fenceProjectContext(deps.ownership, context, { signal, preview: deps.preview });
  try {
    const result = await migrateProject({
      repoRoot: context.root, fence, closeProject: () => { deps.contexts.dispose(project.id, { releasePreviews: false }); },
    });
    return migrationAnswer(result);
  } finally {
    // The next request builds the context again over the moved state.
    fence.release();
  }
}

function failure(error: unknown): ProjectMigrationRouteAnswer {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProjectMigrationBusyError) return { status: 409, body: { error: message, liveTasks: [...error.tasks] } };
  if (error instanceof ProjectMigrationFencedError || error instanceof CockpitAlreadyRunningError || error instanceof ProjectMigrationRefusedError
    || error instanceof ProjectMigrationRecoveryError || error instanceof ProjectContextError) return { status: 409, body: { error: message } };
  console.error('[cez] project migration failed:', error);
  return { status: 500, body: { error: message } };
}
