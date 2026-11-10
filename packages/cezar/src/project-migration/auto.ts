import { readdirSync } from 'node:fs';
import { REBRAND_SWITCH } from '../home/switch.ts';
import type { Home } from '../home/home.ts';
import { pathPresent, projectPaths } from '../project-paths.ts';
import { CockpitOwnership, migrationFencePaths, ProjectMigrationBusyError, ProjectMigrationFencedError, CockpitAlreadyRunningError } from '../server/cockpit-ownership.ts';
import { ProjectMigrationRefusedError } from './engine.ts';
import { projectCockpits, projectLiveTasksOffline } from './live.ts';
import { moveUnderFence } from './offline.ts';
import { planProjectMigration } from './plan.ts';
import { ProjectMigrationRecoveryError } from './recovery.ts';
import type { MigrationFault } from './steps.ts';

/**
 * The cockpit's automatic project move (hearsay-tools/cezarion#3089), only with `REBRAND_SWITCH`:
 * at cockpit start for the boot project, and at the first open of every other project, after
 * journal recovery and before any ordinary read or task start. It moves the legacy state under
 * `.ai/cezar/` with the same offline move as `migrate-project` when nothing else is live. When
 * anything else is live (another cockpit, a task from before the restart, a headless run) it does
 * not move: the project is served from both folders as before, a notice names what blocks the
 * move, and the next start tries again. One attempt per project per cockpit run (its ownership).
 * Tracked files are never moved: the notice of a finished move lists their `git mv` commands. A
 * move that fails after its journal exists leaves the project to the recovery path.
 */

export type AutomaticMove =
  | { status: 'off' | 'nothing' }
  | { status: 'moved'; gitMv: string[] }
  | { status: 'blocked'; reason: string };

/** The projects each cockpit run (its ownership) already tried: no retry loop inside one run. */
const attempted = new WeakMap<CockpitOwnership, Set<string>>();

/** Whether `.ai/cezar/` holds anything a move would carry: entries besides the `cockpit.lock*` claims. */
function legacyStatePresent(root: string): boolean {
  const legacy = projectPaths(root).write;
  if (!pathPresent(legacy)) return false;
  try { return readdirSync(legacy).some(name => !name.startsWith('cockpit.lock')); }
  catch { return false; }
}

/** Why the move does not run now, or undefined when nothing else is live. The caller's own process never counts. */
async function blocker(root: string, homes: readonly Home[], self: number): Promise<string | undefined> {
  const cockpits = await projectCockpits(root, homes, self);
  const tasks = projectLiveTasksOffline(root);
  const reasons = [
    ...cockpits.map(cockpit => `cockpit pid ${cockpit.pid}${cockpit.url ? ` at ${cockpit.url}` : cockpit.port ? ` on port ${cockpit.port}` : ''} serves it`),
    ...tasks.map(task => `task ${task.id} ${task.title} is live (${task.state})`),
  ];
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

/** True the first time `ownership`'s cockpit run meets `root`; a run without an ownership always tries. */
function firstAttempt(ownership: CockpitOwnership | undefined, root: string): boolean {
  if (!ownership) return true;
  const tried = attempted.get(ownership) ?? new Set<string>();
  attempted.set(ownership, tried);
  if (tried.has(root)) return false;
  tried.add(root);
  return true;
}

/** 'nothing' when there is nothing to move, a reason when the move must wait, or undefined to go ahead. */
async function precheck(root: string, homes: readonly Home[], self: number): Promise<'nothing' | { reason: string } | undefined> {
  try {
    const plan = await planProjectMigration(root);
    if (plan.moves.length === 0) return 'nothing';
    const refusals = [...plan.blockers, ...plan.conflicts.map(conflict => `${conflict.path}: ${conflict.reason}`)];
    if (refusals.length > 0) return { reason: refusals.join('; ') };
    const live = await blocker(root, homes, self);
    return live ? { reason: live } : undefined;
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The move under `ownership`'s fence; a refusal before the journal exists is a reason to wait. */
async function move(root: string, ownership: CockpitOwnership, fault: MigrationFault | undefined): Promise<{ gitMv: string[] } | { reason: string }> {
  try {
    return { gitMv: (await moveUnderFence(root, ownership, fault)).gitMv };
  } catch (error) {
    // A move that started leaves its journal: the project stays closed until recovery finishes it.
    const journal = migrationFencePaths(projectPaths(root).write)?.journal;
    if (journal && pathPresent(journal)) throw new ProjectMigrationRecoveryError(journal, root, error);
    if (error instanceof ProjectMigrationBusyError || error instanceof ProjectMigrationFencedError || error instanceof CockpitAlreadyRunningError
      || error instanceof ProjectMigrationRefusedError) return { reason: error.message };
    throw error;
  }
}

/**
 * Move `root`'s legacy state when nothing else is live; see the module comment. `ownership` is the
 * caller's claim (kept afterwards); without one a temporary claim is taken and released.
 */
export async function moveProjectWhenIdle(root: string, options: {
  ownership?: CockpitOwnership | undefined; homes: readonly Home[]; rebrand?: boolean; self?: number; fault?: MigrationFault;
  log?: (line: string) => void;
}): Promise<AutomaticMove> {
  if (!(options.rebrand ?? REBRAND_SWITCH) || !legacyStatePresent(root) || !firstAttempt(options.ownership, root)) {
    return { status: (options.rebrand ?? REBRAND_SWITCH) ? 'nothing' : 'off' };
  }
  const log = options.log ?? ((line: string) => console.warn(line));
  const blocked = (reason: string): AutomaticMove => {
    log(`[hsq] Project ${root} keeps its state in .ai/cezar/ for now: ${reason}. It is served from both folders; the move runs again at the next start.`);
    return { status: 'blocked', reason };
  };
  const check = await precheck(root, options.homes, options.self ?? process.pid);
  if (check === 'nothing') return { status: 'nothing' };
  if (check) return blocked(check.reason);
  const ownership = options.ownership ?? new CockpitOwnership();
  try {
    const result = await move(root, ownership, options.fault);
    if ('reason' in result) return blocked(result.reason);
    log(`[hsq] Moved the state of ${root} from .ai/cezar/ to .ai/squawk/.${result.gitMv.length
      ? ` Tracked files stay; run these and commit:\n${result.gitMv.map(line => `  ${line}`).join('\n')}` : ''}`);
    return { status: 'moved', gitMv: result.gitMv };
  } finally {
    if (!options.ownership) ownership.releaseAll();
  }
}
