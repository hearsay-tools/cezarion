import { readdirSync } from 'node:fs';
import { REBRAND_SWITCH } from '../home/switch.ts';
import type { Home } from '../home/home.ts';
import { pathPresent, projectPaths } from '../project-paths.ts';
import { CockpitOwnership, migrationFencePaths } from '../server/cockpit-ownership.ts';
import { projectCockpits, projectLiveTasksOffline } from './live.ts';
import { moveUnderFence } from './offline.ts';
import { planProjectMigration } from './plan.ts';
import { ProjectMigrationRecoveryError, recoverProjectMigration } from './recovery.ts';
import type { ArchiveOnMergeDeps } from '../server/archive-on-merge.ts';
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

/** Each cockpit run's (its ownership's) attempt per project: no retry loop inside one run, and a
 *  caller that comes while the attempt runs waits on it instead of reading the project first. */
const attempts = new WeakMap<CockpitOwnership, Map<string, Promise<AutomaticMove>>>();

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

/**
 * The move under `ownership`'s fence. Any failure before the journal exists (a refusal, a race, a
 * file system error claiming the fence) is a reason to wait: nothing moved, the project is served
 * as before. Only a failure after the journal exists closes the project through recovery.
 */
async function move(root: string, ownership: CockpitOwnership, fault: MigrationFault | undefined): Promise<{ gitMv: string[] } | { reason: string }> {
  try {
    return { gitMv: (await moveUnderFence(root, ownership, fault)).gitMv };
  } catch (error) {
    const journal = migrationFencePaths(projectPaths(root).write)?.journal;
    if (journal && pathPresent(journal)) throw new ProjectMigrationRecoveryError(journal, root, error);
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/** What a later caller of an attempt that already ran sees: nothing left for it to move. */
function nothingLeft(): AutomaticMove {
  return { status: 'nothing' };
}

/**
 * Move `root`'s legacy state when nothing else is live; see the module comment. `ownership` is the
 * caller's claim (kept afterwards); without one a temporary claim is taken and released. One
 * attempt per project per cockpit run: a later or concurrent call gets that attempt's promise.
 */
export function moveProjectWhenIdle(root: string, options: {
  ownership?: CockpitOwnership | undefined; homes: readonly Home[]; rebrand?: boolean; self?: number; fault?: MigrationFault;
  log?: (line: string) => void;
}): Promise<AutomaticMove> {
  if (!(options.rebrand ?? REBRAND_SWITCH)) return Promise.resolve({ status: 'off' });
  if (!options.ownership) return attempt(root, options);
  const runs = attempts.get(options.ownership) ?? new Map<string, Promise<AutomaticMove>>();
  attempts.set(options.ownership, runs);
  const pending = runs.get(root);
  // A later caller waits for the attempt; its failure was the first caller's (recovery handles a journal it left).
  if (pending) return pending.then(nothingLeft, nothingLeft);
  const started = attempt(root, options);
  runs.set(root, started);
  return started;
}

async function attempt(root: string, options: Parameters<typeof moveProjectWhenIdle>[1]): Promise<AutomaticMove> {
  if (!legacyStatePresent(root)) return { status: 'nothing' };
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

/**
 * The prepare step of a project for a cockpit: journal recovery, then the automatic move. Every
 * cockpit path that touches a project before or without its context runs it first: the context
 * build, the post-listen preparation of every registered project, the archive and completion
 * ticks and the cold run index. Concurrent callers share the recovery and the move attempt.
 */
export async function prepareProject(root: string, options: {
  ownership?: CockpitOwnership | undefined; homes: readonly Home[]; rebrand?: boolean | undefined; keep?: boolean;
}): Promise<void> {
  await recoverProjectMigration(root, { ownership: options.ownership, keep: options.keep ?? false });
  await moveProjectWhenIdle(root, { ownership: options.ownership, homes: options.homes, ...(options.rebrand === undefined ? {} : { rebrand: options.rebrand }) });
}

/** Prepare `projects` one after another; a project whose recovery fails or whose move fails after
 *  its journal exists is logged and stays refused by admission, and never stops the others. */
export async function prepareProjects<T extends { root: string; status?: string }>(projects: T[], options: {
  ownership?: CockpitOwnership | undefined; homes: readonly Home[]; rebrand?: boolean | undefined;
}): Promise<T[]> {
  for (const project of projects) {
    if (project.status === 'missing') continue;
    await prepareProject(project.root, options).catch((error: unknown) => {
      console.warn(`[cez] ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return projects;
}

/** The archive and completion ticks: each tick's project list is prepared first, before the
 *  tick's admission check and its maintenance store. */
export function prepareBeforeTicks(options: Parameters<typeof prepareProjects>[1], deps: ArchiveOnMergeDeps): ArchiveOnMergeDeps {
  return { ...deps, projects: async () => { return prepareProjects([...await deps.projects()], options); } };
}
