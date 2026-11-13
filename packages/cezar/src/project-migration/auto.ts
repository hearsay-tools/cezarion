import { join } from 'node:path';
import { productIdentity } from '../home/identity.ts';
import { markFreshProject } from './fresh.ts';
import type { Home } from '../home/home.ts';
import { noticeLegacyProject, pathPresent, projectMoveMarked, projectPaths } from '../project-paths.ts';
import { CockpitOwnership, migrationFencePaths } from '../server/cockpit-ownership.ts';
import { projectCockpits, projectForeignTasksOffline, projectKeptRunIds } from './live.ts';
import { moveUnderFence } from './offline.ts';
import { LEGACY_PROJECT_DIR, legacyStateLeft, MIGRATED_PROJECT_DIR, planProjectMigration } from './plan.ts';
import { ProjectMigrationRecoveryError, recoverProjectMigration } from './recovery.ts';
import type { ArchiveOnMergeDeps } from '../server/archive-on-merge.ts';
import { automationLeaseHeld } from '../automations/store.ts';
import type { MigrationFault } from './steps.ts';

/**
 * The cockpit's automatic project move (hearsay-tools/cezarion#3089):
 * at cockpit start for the boot project and, right after the listener starts, every other registered
 * project (or earlier, when a request reaches it first), and a project added later when it is added;
 * after journal recovery and before any ordinary read or task start. It moves the legacy state under
 * `.ai/cezar/` with the same offline move as `migrate-project` when no other writer is live and the
 * plan has no blocker or conflict. A task that can still resume does not stop the move: a live
 * task (running, parked, waiting, a worker whose destroy is unfinished) or any task not archived,
 * since a human can Continue a finished one. Its own items stay in `.ai/cezar/` (`legacy-runs.ts`),
 * and the notice lists it. A later start moves them once it is archived or deleted, and removes the old directories that leaves empty. When another writer is live (another cockpit,
 * a family another process claims, an automation lease of this cockpit) or the plan has a blocker
 * or conflict, it does not move: the project is served from both folders as before, a notice names
 * what blocks the move, and the next start tries again. One attempt per project per cockpit run
 * (its ownership). Tracked files are never moved: the notice of a finished move lists their
 * `git mv` commands. A move that fails after its journal exists leaves the project to the
 * recovery path.
 */

export type AutomaticMove =
  | { status: 'nothing' }
  | { status: 'moved'; gitMv: string[]; leftovers: string[] }
  | { status: 'blocked'; reason: string };

/** Each cockpit run's (its ownership's) attempt per project: no retry loop inside one run, and a
 *  caller that comes while the attempt runs waits on it instead of reading the project first. */
const attempts = new WeakMap<CockpitOwnership, Map<string, Promise<AutomaticMove>>>();

/** Why the move does not run now, or undefined when no other writer is live. The caller's own process never counts. */
async function blocker(root: string, homes: readonly Home[], self: number): Promise<string | undefined> {
  const cockpits = await projectCockpits(root, homes, self);
  const tasks = projectForeignTasksOffline(root);
  const reasons = [
    // A lease this process holds would be renamed from under its holder (a schedule fire opening the project).
    ...(automationLeaseHeld(projectPaths(root).write) ? ['an automation of this cockpit holds its lease'] : []),
    ...cockpits.map(cockpit => `cockpit pid ${cockpit.pid}${cockpit.url ? ` at ${cockpit.url}` : cockpit.port ? ` on port ${cockpit.port}` : ''} serves it`),
    ...tasks.map(task => `task ${task.id} ${task.title} is live in another process (${task.state})`),
  ];
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}


/** 'nothing' when there is nothing to move, a reason when the move must wait, or undefined to go ahead. */
async function precheck(root: string, homes: readonly Home[], self: number): Promise<'nothing' | { reason: string } | undefined> {
  try {
    const plan = await planProjectMigration(root, { keep: projectKeptRunIds(root) });
    const refusals = [...plan.blockers, ...plan.conflicts.map(conflict => `${conflict.path}: ${conflict.reason}`)];
    if (refusals.length > 0) return { reason: refusals.join('; ') };
    // An unmarked project moves while its `.ai/cezar/` exists, even with nothing in it to carry: the move marks it.
    if (plan.alreadyMoved || (!projectMoveMarked(root) && !pathPresent(plan.source))) return 'nothing';
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
async function move(root: string, ownership: CockpitOwnership, fault: MigrationFault | undefined): Promise<{ gitMv: string[]; leftovers: string[] } | { reason: string }> {
  try {
    const answer = await moveUnderFence(root, ownership, fault);
    return { gitMv: answer.gitMv, leftovers: answer.leftovers };
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

/** What a finished move says: that the project moved, and which unarchived tasks keep their files where they were. */
export function movedNotice(root: string, leftovers: readonly string[]): string {
  const kept = leftovers.length === 0 ? ''
    : ` ${leftovers.length} task${leftovers.length === 1 ? ' keeps its' : 's keep their'} files in .ai/cezar/ until ${leftovers.length === 1 ? 'it is' : 'they are'} archived: ${leftovers.join(', ')}.`;
  return `Moved the state of ${root} from .ai/cezar/ to .ai/squawk/.${kept}`;
}

/**
 * Move `root`'s legacy state when no other writer is live; see the module comment. `ownership` is the
 * caller's claim (kept afterwards); without one a temporary claim is taken and released. One
 * attempt per project per cockpit run: a later or concurrent call gets that attempt's promise.
 */
export function moveProjectWhenIdle(root: string, options: {
  ownership?: CockpitOwnership | undefined; homes: readonly Home[]; self?: number; fault?: MigrationFault;
  log?: (line: string) => void;
}): Promise<AutomaticMove> {
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
  markFreshProject(root);
  // A completed move marked the project (hearsay-tools/cezarion#3150): `.ai/cezar/` is its fallback
  // now, and holds nothing more to move once only the ownership claims are left in it. An unmarked
  // project still needs the move that marks it, even when its `.ai/cezar/` is empty or tracked only.
  if (projectMoveMarked(root) && !legacyStateLeft(join(root, ...LEGACY_PROJECT_DIR.split('/')), join(root, ...MIGRATED_PROJECT_DIR.split('/')))) return { status: 'nothing' };
  const log = options.log ?? ((line: string) => console.warn(line));
  const blocked = (reason: string): AutomaticMove => {
    noticeLegacyProject(root, { reason, warn: log });
    return { status: 'blocked', reason };
  };
  const check = await precheck(root, options.homes, options.self ?? process.pid);
  if (check === 'nothing') return { status: 'nothing' };
  if (check) return blocked(check.reason);
  const ownership = options.ownership ?? new CockpitOwnership();
  try {
    const result = await move(root, ownership, options.fault);
    if ('reason' in result) return blocked(result.reason);
    log(`[${productIdentity().command}] ${movedNotice(root, result.leftovers)}${result.gitMv.length
      ? ` Tracked files stay; run these and commit:\n${result.gitMv.map(line => `  ${line}`).join('\n')}` : ''}`);
    return { status: 'moved', gitMv: result.gitMv, leftovers: result.leftovers };
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
  ownership?: CockpitOwnership | undefined; homes: readonly Home[]; keep?: boolean;
}): Promise<void> {
  await recoverProjectMigration(root, { ownership: options.ownership, keep: options.keep ?? false });
  await moveProjectWhenIdle(root, { ownership: options.ownership, homes: options.homes });
}

/** Prepare `projects` one after another; a project whose recovery fails or whose move fails after
 *  its journal exists is logged and stays refused by admission, and never stops the others. Once
 *  `stopped` answers true (the cockpit is closing), no further project is prepared. */
export async function prepareProjects<T extends { root: string; status?: string }>(projects: T[], options: {
  ownership?: CockpitOwnership | undefined; homes: readonly Home[]; stopped?: () => boolean;
}): Promise<T[]> {
  for (const project of projects) {
    if (options.stopped?.()) break;
    if (project.status === 'missing') continue;
    await prepareProject(project.root, options).catch((error: unknown) => {
      console.warn(`[${productIdentity().command}] ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return projects;
}

/** The archive and completion ticks: each tick's project list is prepared first, before the
 *  tick's admission check and its maintenance store. */
export function prepareBeforeTicks(options: Parameters<typeof prepareProjects>[1], deps: ArchiveOnMergeDeps): ArchiveOnMergeDeps {
  return { ...deps, projects: async () => { return prepareProjects([...await deps.projects()], options); } };
}

/** Whether a cockpit server is closing: set when its `close` is called and by `stop`, before anything closes. */
export function closingSignal(server: { close: (...args: never[]) => unknown }): { stopped: () => boolean; stop: () => void } {
  let closing = false;
  const close = server.close.bind(server);
  server.close = ((...args: never[]) => { closing = true; return close(...args); }) as typeof server.close;
  return { stopped: () => { return closing; }, stop: () => { closing = true; } };
}
