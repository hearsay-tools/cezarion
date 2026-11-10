import { projectPaths, pathPresent } from '../project-paths.ts';
import { anotherCockpitOwner, CockpitAlreadyRunningError, CockpitOwnership, migrationFencePaths, ProjectMigrationFencedError } from '../server/cockpit-ownership.ts';
import { resumeProjectMigration, type ProjectMigrationResult } from './engine.ts';

/**
 * Early recovery of an unfinished project migration (P4b3, hearsay-tools/cezarion#3089). Every
 * entry that opens a project calls it before its first ordinary read and before it opens an
 * admission lease: cockpit boot, lazy context builds, maintenance, cold run reads, CLI project
 * commands and `migrate-project`. It does not depend on the P5 gate: only a gated command or a
 * newer binary writes a journal, and once written the journal must finish before anything reads
 * the project.
 */

/** The journal could not be finished: it stays, and admission keeps refusing the project. */
export class ProjectMigrationRecoveryError extends Error {
  constructor(readonly journal: string, readonly project: string, cause: unknown) {
    super(`The unfinished project migration ${journal} of ${project} could not finish: ${cause instanceof Error ? cause.message : String(cause)}. `
      + 'The project stays closed until it finishes. Fix the cause, then open the project again to retry', { cause });
    this.name = 'ProjectMigrationRecoveryError';
  }
}

/** The journal blocks every admission from the moment it is written, and a migration starts only
 *  with no live task, so a recovery fence has nothing live and nothing in flight to drain. */
const NOTHING_LIVE = { liveTasks: () => [], inFlight: () => 0 };

/** Recoveries in flight in this process, by journal path: concurrent entries share one. */
const recovering = new Map<string, Promise<ProjectMigrationResult | undefined>>();

/**
 * Finish the project's unfinished migration journal under the exclusive fence; undefined without
 * one (one `lstat`), or when another live cockpit or fence holder has the project: that holder
 * recovers it, and admission refuses here meanwhile. `ownership`: the caller's claim, used when
 * it already owns the project or `keep` is set (the caller is about to own it, and keeps the
 * claim); otherwise a temporary claim is taken and released. Throws
 * `ProjectMigrationRecoveryError` when the journal cannot be finished.
 */
export function recoverProjectMigration(repoRoot: string, options: { ownership?: CockpitOwnership | undefined; keep?: boolean } = {}): Promise<ProjectMigrationResult | undefined> {
  const dataDir = projectPaths(repoRoot).write;
  const journal = migrationFencePaths(dataDir)?.journal;
  if (!journal || !pathPresent(journal)) return Promise.resolve(undefined);
  const pending = recovering.get(journal);
  if (pending) return pending;
  const recovery = recover(repoRoot, dataDir, journal, options).finally(() => recovering.delete(journal));
  recovering.set(journal, recovery);
  return recovery;
}

async function recover(repoRoot: string, dataDir: string, journal: string, options: { ownership?: CockpitOwnership | undefined; keep?: boolean }): Promise<ProjectMigrationResult | undefined> {
  if (anotherCockpitOwner(dataDir)) return undefined;
  const callers = options.ownership && (options.keep || options.ownership.owns(dataDir)) ? options.ownership : undefined;
  const ownership = callers ?? new CockpitOwnership();
  const done = () => { if (ownership !== callers) ownership.releaseAll(); };
  let fence;
  try { fence = await ownership.fenceProject(dataDir, NOTHING_LIVE); }
  catch (error) {
    done();
    // Another process holds the project or its fence: it recovers, admission refuses meanwhile.
    if (error instanceof ProjectMigrationFencedError || error instanceof CockpitAlreadyRunningError) return undefined;
    throw new ProjectMigrationRecoveryError(journal, repoRoot, error);
  }
  try { return await resumeProjectMigration({ repoRoot, fence }); }
  catch (error) { throw new ProjectMigrationRecoveryError(journal, repoRoot, error); }
  finally { fence.release(); done(); }
}

/** Finish the unfinished journals of `projects` before they are read; a project whose journal
 *  cannot finish is logged and stays refused by admission. Answers `projects` unchanged. */
export async function recoverProjects<T extends { root: string; status?: string }>(projects: T[], ownership: CockpitOwnership | undefined): Promise<T[]> {
  await Promise.all(projects.filter((project) => project.status !== 'missing').map((project) =>
    recoverProjectMigration(project.root, { ownership }).catch((error: unknown) => {
      console.warn(`[cez] ${error instanceof Error ? error.message : String(error)}`);
    })));
  return projects;
}

/** `work` after the project's unfinished journal finishes, before `work` opens its lease. A
 *  journal that cannot finish leaves admission to refuse inside `work`. */
export async function afterProjectRecovery<T>(repoRoot: string, ownership: CockpitOwnership | undefined, work: () => Promise<T>): Promise<T> {
  await recoverProjectMigration(repoRoot, { ownership }).catch(() => undefined);
  return work();
}
