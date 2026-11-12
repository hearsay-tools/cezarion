import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asFenceHolder, holdsProjectFence, migrationFencePaths, type ProjectMigrationFence } from '../server/cockpit-ownership.ts';
import {
  PROJECT_MIGRATION_STEPS, readProjectMigrationJournal, removeProjectMigrationJournal, writeProjectMigrationJournal, type ProjectMigrationJournal,
  type ProjectMigrationStep,
} from './journal.ts';
import { gitMvCommands, LEGACY_PROJECT_DIR, planProjectMigration, type ProjectMigrationPlan } from './plan.ts';
import { GIT_MIGRATION_STEPS, MIGRATION_STEP_RUNNERS, type MigrationFault } from './steps.ts';
import { withWorktreeMutation, type WorktreeGit } from '../git-worktree-lock.ts';
import { assertJournalContained, assertJournalFile } from './containment.ts';
import { projectKeptRunIds } from './live.ts';

/**
 * The project state migration engine (P4b2, hearsay-tools/cezarion#3088): it moves a project's
 * runtime state from `.ai/cezar/` to `.ai/squawk/` under the exclusive project fence. A migration
 * runs offline (hearsay-tools/cezarion#3089): no cockpit serves the project and no other process
 * claims a task of it. A task that can still resume (live or not archived) keeps its own items in
 * `.ai/cezar/` (`legacy-runs.ts`); a later migration carries them once it is archived or deleted.
 *
 * Order: the caller takes the fence (`fenceProject`); the engine checks that this process holds
 * it, runs as its holder (`asFenceHolder`), closes the store the caller opened (`closeProject`),
 * plans, writes the journal, runs each step and marks it done, and removes the journal last. The
 * caller releases the fence afterwards, also after a failure: the journal then keeps the project
 * blocked until a resume completes it.
 */

export interface ProjectMigrationOptions {
  /** The project root, in the form the project is registered with. */
  repoRoot: string;
  /** The fence this process holds for the project. */
  fence: ProjectMigrationFence;
  /** Test seam: called at each fault point; throwing there stops the migration as a crash would. */
  fault?: MigrationFault;
}

export interface ProjectMigrationResult {
  /** The journal as completed (removed from disk). */
  journal: ProjectMigrationJournal;
  /** Whether an unfinished journal was completed rather than a new plan run. */
  resumed: boolean;
  /** Commands that move the tracked files the migration left in place, for the user to commit. */
  gitMv: string[];
  /** A completed migration had marked the project moved: nothing was written, no journal either. */
  alreadyMoved: boolean;
}

/** The plan had conflicts or blockers: nothing was written and no journal exists. */
export class ProjectMigrationRefusedError extends Error {
  constructor(readonly plan: ProjectMigrationPlan) {
    super(`Cannot migrate ${plan.repoRoot}:${[...plan.blockers, ...plan.conflicts.map(conflict => `${conflict.path}: ${conflict.reason}`)]
      .map(line => `\n- ${line}`).join('')}`);
    this.name = 'ProjectMigrationRefusedError';
  }
}

function legacyDataDir(repoRoot: string): string {
  return join(resolve(repoRoot), ...LEGACY_PROJECT_DIR.split('/'));
}

/** The engine runs only under a fence its own process holds, and only for that fence's project. */
function assertHeldFence(dataDir: string, fence: ProjectMigrationFence): void {
  const paths = migrationFencePaths(dataDir);
  if (!paths || paths.lock !== fence.lock || paths.journal !== fence.journal || !holdsProjectFence(dataDir)) {
    throw new Error(`The project migration of ${resolve(dataDir, '..', '..')} needs the project's migration fence held by this process`);
  }
}

async function runJournal(path: string, start: ProjectMigrationJournal, resumed: boolean, fault: MigrationFault): Promise<ProjectMigrationResult> {
  let journal = start;
  const run = async (step: ProjectMigrationStep, git?: WorktreeGit) => {
    if (journal.done.includes(step)) return;
    fault(`${step}:before`);
    await MIGRATION_STEP_RUNNERS[step](journal, fault, git);
    fault(`${step}:after`);
    journal = { ...journal, done: [...journal.done, step] };
    writeProjectMigrationJournal(path, journal);
    fault(`${step}:marked`);
  };
  // Worktree locks, moves and repairs in one hold of the common directory's mutation lock, so no
  // cooperating process mutates worktree registrations in between; the Git locks cover a crash.
  if (journal.worktrees.length > 0 && GIT_MIGRATION_STEPS.some(step => !journal.done.includes(step))) {
    await withWorktreeMutation(journal.repoRoot, async git => { for (const step of GIT_MIGRATION_STEPS) await run(step, git); });
  }
  for (const step of PROJECT_MIGRATION_STEPS) await run(step);
  removeProjectMigrationJournal(path);
  return { journal, resumed, gitMv: gitMvCommands(journal.repoRoot, journal.tracked), alreadyMoved: false };
}

/** Complete an unfinished journal, for P4b3's recovery before any project read; undefined without one. */
export async function resumeProjectMigration(options: ProjectMigrationOptions): Promise<ProjectMigrationResult | undefined> {
  const dataDir = legacyDataDir(options.repoRoot);
  assertHeldFence(dataDir, options.fence);
  return asFenceHolder(options.fence, async () => resumeHeld(options));
}

async function resumeHeld(options: ProjectMigrationOptions): Promise<ProjectMigrationResult | undefined> {
  const root = realpathSync(resolve(options.repoRoot));
  // The file is accepted before anything reads it: a symlink, a huge file or a committed one is refused.
  if (!await assertJournalFile(options.fence.journal, root)) return undefined;
  const journal = readProjectMigrationJournal(options.fence.journal);
  if (!journal) return undefined;
  if (journal.repoRoot !== root) throw new Error(`The migration journal ${options.fence.journal} belongs to ${journal.repoRoot}, not ${root}`);
  // Read back from disk, so untrusted: nothing outside the project's own state may be named in it.
  await assertJournalContained(options.fence.journal, journal);
  return runJournal(options.fence.journal, journal, true, options.fault ?? (() => undefined));
}

/**
 * The tasks that can still resume: live or not archived. When their records cannot be read, a plan that is refused anyway reports its
 * own conflicts and blockers rather than the read failure.
 */
async function resolveKeptRunIds(options: { repoRoot: string; keptRunIds?: () => ReadonlySet<string> }): Promise<ReadonlySet<string>> {
  try { return (options.keptRunIds ?? (() => projectKeptRunIds(options.repoRoot)))(); }
  catch (error) {
    const plan = await planProjectMigration(options.repoRoot);
    if (plan.blockers.length > 0 || plan.conflicts.length > 0) throw new ProjectMigrationRefusedError(plan);
    throw error;
  }
}

/**
 * Migrate the project, or finish its unfinished journal first. `closeProject` runs before the
 * plan: the CLI closes the store it opened for its live-task check. A refused plan writes nothing.
 */
export async function migrateProject(options: ProjectMigrationOptions & {
  closeProject?: () => void | Promise<void>;
  /** The tasks that keep their items (live or not archived), read after `closeProject`; by default read from the project's run stores. */
  keptRunIds?: () => ReadonlySet<string>;
}): Promise<ProjectMigrationResult> {
  const dataDir = legacyDataDir(options.repoRoot);
  assertHeldFence(dataDir, options.fence);
  return asFenceHolder(options.fence, async () => {
    await options.closeProject?.();
    const unfinished = await resumeHeld(options);
    if (unfinished) return unfinished;
    const plan = await planProjectMigration(options.repoRoot, { keep: await resolveKeptRunIds(options) });
    if (plan.blockers.length > 0 || plan.conflicts.length > 0) throw new ProjectMigrationRefusedError(plan);
    const journal: ProjectMigrationJournal = {
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(), repoRoot: plan.repoRoot, source: plan.source,
      destination: plan.destination, done: [], moves: plan.moves, tracked: plan.tracked, worktrees: plan.worktrees, rewrites: plan.rewrites,
      leftovers: plan.leftovers,
    };
    // The same rule as a resume, before the journal exists, so a refused plan leaves nothing behind.
    await assertJournalContained(plan.journal, journal);
    if (plan.alreadyMoved) return { journal, resumed: false, gitMv: plan.gitMv, alreadyMoved: true };
    const fault = options.fault ?? (() => undefined);
    fault('journal:before');
    writeProjectMigrationJournal(plan.journal, journal);
    fault('journal:written');
    return runJournal(plan.journal, journal, false, fault);
  });
}
