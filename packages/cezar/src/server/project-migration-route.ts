import { realpathSync } from 'node:fs';
import type { ProjectMigrationError, ProjectMigrationRequest, ProjectMigrationResponse } from '@open-mercato/cezar-contract/project-migration';
import { projectPaths } from '../project-paths.ts';
import { dryRunAnswer, migrationAnswer } from '../project-migration/answer.ts';
import { migrateProject, ProjectMigrationRefusedError } from '../project-migration/engine.ts';
import { ProjectMigrationRecoveryError, recoverProjectMigration } from '../project-migration/recovery.ts';
import type { PreviewHost } from '../preview/host.ts';
import {
  anotherCockpitOwner, assertProjectAdmitted, CockpitAlreadyRunningError, ProjectMigrationBusyError, ProjectMigrationFencedError, type CockpitOwnership,
} from './cockpit-ownership.ts';
import { fenceProjectContext, ProjectContextError, type ProjectContexts } from './project-context.ts';

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
