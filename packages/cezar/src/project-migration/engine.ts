import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { holdProjectWork, holdsProjectFence, migrationFencePaths, type ProjectMigrationFence } from '../server/cockpit-ownership.ts';
import {
  PROJECT_MIGRATION_STEPS, readProjectMigrationJournal, removeProjectMigrationJournal, writeProjectMigrationJournal, type ProjectMigrationJournal,
} from './journal.ts';
import { gitMvCommands, LEGACY_PROJECT_DIR, planProjectMigration, type ProjectMigrationPlan } from './plan.ts';
import { MIGRATION_STEP_RUNNERS, type MigrationFault } from './steps.ts';

/**
 * The project state migration engine (P4b2, hearsay-tools/cezarion#3088): it moves a project's
 * runtime state from `.ai/cezar/` to `.ai/squawk/` under the exclusive project fence (P4b1). It is
 * internal: no command, route or boot hook calls it until P4b3 wires it and P5 enables it.
 *
 * Order: the caller takes the fence (`fenceProject` or `fenceProjectContext`); the engine checks
 * that this process holds it, runs the holder duty (`closeProject`: dispose the project's context
 * and close its store), plans, writes the journal, runs each step and marks it done, and removes
 * the journal last. The caller releases the fence afterwards, also after a failure: the journal
 * then keeps the project blocked until a resume completes it.
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
  for (const step of PROJECT_MIGRATION_STEPS) {
    if (journal.done.includes(step)) continue;
    fault(`${step}:before`);
    await MIGRATION_STEP_RUNNERS[step](journal, fault);
    fault(`${step}:after`);
    journal = { ...journal, done: [...journal.done, step] };
    writeProjectMigrationJournal(path, journal);
    fault(`${step}:marked`);
  }
  removeProjectMigrationJournal(path);
  return { journal, resumed, gitMv: gitMvCommands(journal.repoRoot, journal.tracked) };
}

/** Complete an unfinished journal, for P4b3's recovery before any project read; undefined without one. */
export async function resumeProjectMigration(options: ProjectMigrationOptions): Promise<ProjectMigrationResult | undefined> {
  const dataDir = legacyDataDir(options.repoRoot);
  assertHeldFence(dataDir, options.fence);
  return holdProjectWork(dataDir, async () => resumeHeld(options));
}

async function resumeHeld(options: ProjectMigrationOptions): Promise<ProjectMigrationResult | undefined> {
  const journal = readProjectMigrationJournal(options.fence.journal);
  if (!journal) return undefined;
  const root = realpathSync(resolve(options.repoRoot));
  if (journal.repoRoot !== root) throw new Error(`The migration journal ${options.fence.journal} belongs to ${journal.repoRoot}, not ${root}`);
  return runJournal(options.fence.journal, journal, true, options.fault ?? (() => undefined));
}

/**
 * Migrate the project, or finish its unfinished journal first. `closeProject` is the holder duty
 * after the drain and before the first move: an owning cockpit disposes the project's context
 * (`ProjectContexts.dispose(id, { releasePreviews: false })`, previews were released in the drain),
 * which closes its store; a CLI closes the store it opened. A refused plan writes nothing.
 */
export async function migrateProject(options: ProjectMigrationOptions & { closeProject?: () => void | Promise<void> }): Promise<ProjectMigrationResult> {
  const dataDir = legacyDataDir(options.repoRoot);
  assertHeldFence(dataDir, options.fence);
  return holdProjectWork(dataDir, async () => {
    await options.closeProject?.();
    const unfinished = await resumeHeld(options);
    if (unfinished) return unfinished;
    const plan = await planProjectMigration(options.repoRoot);
    if (plan.blockers.length > 0 || plan.conflicts.length > 0) throw new ProjectMigrationRefusedError(plan);
    const journal: ProjectMigrationJournal = {
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(), repoRoot: plan.repoRoot, source: plan.source,
      destination: plan.destination, done: [], moves: plan.moves, tracked: plan.tracked, worktrees: plan.worktrees, rewrites: plan.rewrites,
    };
    const fault = options.fault ?? (() => undefined);
    fault('journal:before');
    writeProjectMigrationJournal(plan.journal, journal);
    fault('journal:written');
    return runJournal(plan.journal, journal, false, fault);
  });
}
