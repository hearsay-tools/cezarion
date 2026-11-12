import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Home } from '../home/home.ts';
import { readCockpitLeases } from '../home/leases.ts';
import { pathPresent, projectPaths } from '../project-paths.ts';
import { claimOwnerLive } from '../runs/run-claims.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { parseRunRecords, type RunRecord, type RunStore } from '../runs/store.ts';
import { isLiveRecord } from '../runs/run-row.ts';
import { anotherCockpitOwner, type LiveProjectTask } from '../server/cockpit-ownership.ts';
import { projectLiveTasks } from '../server/project-context.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { readQuiescentRunDatabase } from './plan.ts';

/**
 * Whether anything is live for a project (hearsay-tools/cezarion#3089). A project migration runs
 * offline: it refuses while a cockpit serves the project or another live process claims a task of
 * it, and names what to stop. A task live otherwise (parked, waiting, a worker whose destroy is
 * unfinished) does not refuse it: its own items stay in `.ai/cezar/` (`projectLiveRunIds`).
 * Shared by every caller that starts a migration.
 *
 * Seen: the cockpit that owns the project's `cockpit.lock` (any home), every live cockpit of the
 * given homes whose registry lists the project (their presence leases, `home/leases.ts`), and live
 * tasks: rows not terminal in either project directory, and families another live process (a
 * headless run, another binary) claims in `run_claims`. An agent process belongs to a live task.
 * Not seen: a cockpit of another home that lists the project but never opened it; the write
 * backstop and admission stop its writes during a move.
 */

/** A cockpit that serves the project: the `cockpit.lock` owner, or a live cockpit whose registry lists it. */
export interface ProjectCockpit { pid: number; url?: string; port?: number; instance?: string; home?: string }

/** Something live serves the project: nothing was claimed, moved or written. */
export class ProjectInUseError extends Error {
  constructor(readonly project: string, readonly cockpits: readonly ProjectCockpit[], readonly tasks: readonly LiveProjectTask[], readonly taskReadFailure?: string) {
    const lines = [
      ...cockpits.map(cockpit => `- cockpit pid ${cockpit.pid}${cockpit.url ? ` at ${cockpit.url}` : cockpit.port ? ` on port ${cockpit.port}` : ''}`
        + `${cockpit.instance ? `, instance ${cockpit.instance}` : ''}${cockpit.home ? `, home ${cockpit.home}` : ''}: stop it`),
      ...tasks.map(task => `- task ${task.id} ${task.title} (${task.state}): finish or cancel it`),
      ...(taskReadFailure ? [`- live tasks could not be read: ${taskReadFailure}`] : []),
    ];
    super(`Cannot migrate ${project} while it is in use. Stop what is listed, then retry:\n${lines.join('\n')}`);
    this.name = 'ProjectInUseError';
  }
}

function realRoot(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * The cockpits other than process `self` that serve the project at `root`: the `cockpit.lock` owner
 * and every live cockpit of `homes` whose registry lists `root`. A home that cannot be read has no
 * cockpit to report.
 */
export async function projectCockpits(root: string, homes: readonly Home[], self = process.pid): Promise<ProjectCockpit[]> {
  const found = new Map<number, ProjectCockpit>();
  const owner = anotherCockpitOwner(projectPaths(root).write);
  if (owner && owner.pid !== self) found.set(owner.pid, owner);
  const real = realRoot(root);
  for (const home of homes) {
    let listed: boolean;
    try { listed = (await loadWorkspaceConfig(home.workspaceConfig)).projects.some(project => realRoot(project.root) === real); }
    catch { continue; }
    if (!listed) continue;
    let leases: ReturnType<typeof readCockpitLeases>;
    try { leases = readCockpitLeases(home); } catch { continue; }
    for (const lease of leases) {
      if (lease.pid === self || found.has(lease.pid)) continue;
      found.set(lease.pid, { pid: lease.pid, port: lease.port, instance: lease.instance, home: home.root });
    }
  }
  return [...found.values()];
}

/** One stored record, or nothing when it does not parse. */
function record(value: unknown): RunRecord | undefined {
  const parsed = parseRunRecords([value]);
  return parsed.success ? parsed.data[0] : undefined;
}

/**
 * The project's runs as `projectLiveTasks` reads them, read without writing anything: each run
 * store read-only (`readQuiescentRunDatabase`), and a `runs.json` no store imported yet read as
 * JSON. The legacy directory wins an id both hold. Live: rows not terminal, and the runs of
 * families a live process claims. Throws when a live id's record cannot be read.
 */
export function readLiveTaskView(root: string): Pick<RunStore, 'listRuns' | 'persistedLiveRunIds' | 'getRun'> & {
  allRuns: () => RunRecord[];
  /** Ids of rows not archived whose record does not parse: whether they can resume is unknown. */
  unreadableUnarchived: () => string[];
} {
  const runs = new Map<string, RunRecord>();
  const live = new Set<string>(), foreign = new Set<string>(), unparsed = new Set<string>();
  const add = (run: RunRecord | undefined) => { if (run && !runs.has(run.id)) runs.set(run.id, run); };
  for (const directory of projectPaths(root).reads) {
    const database = join(directory, RUNS_DB_FILE);
    if (pathPresent(database)) {
      readQuiescentRunDatabase(database, (db) => {
        for (const row of db.listAll()) {
          const run = record(parseJson(row.data));
          add(run);
          if (!run && !row.archived) unparsed.add(row.id);
        }
        for (const row of db.listLive()) live.add(row.id);
        for (const claim of db.listClaims(true)) {
          if (!claimOwnerLive(claim)) continue;
          for (const id of [claim.family, ...db.listIdsByParent(claim.family)]) foreign.add(id);
        }
      });
      continue;
    }
    const index = join(directory, 'runs.json');
    if (!pathPresent(index)) continue;
    const entries: unknown = JSON.parse(readFileSync(index, 'utf8'));
    for (const entry of Array.isArray(entries) ? entries : []) {
      const run = record(entry);
      add(run);
      if (run && isLiveRecord(run)) live.add(run.id);
      const raw = entry as { id?: unknown; archived?: unknown } | null;
      if (!run && typeof raw?.id === 'string' && raw.archived !== true) unparsed.add(raw.id);
    }
  }
  // A live task whose record cannot be read is still live: the check refuses what it cannot prove safe.
  const unreadable = [...new Set([...live, ...foreign])].filter(id => !runs.has(id));
  if (unreadable.length > 0) {
    throw new Error(`Cannot migrate ${root}: these tasks are marked live but their records cannot be read: ${unreadable.join(', ')}. `
      + 'Open the project with the binary that wrote them, finish or cancel each one, then retry');
  }
  return { listRuns: () => [], persistedLiveRunIds: () => ({ live: [...live], foreign: [...foreign] }), getRun: (id) => runs.get(id),
    allRuns: () => [...runs.values()], unreadableUnarchived: () => [...unparsed].filter(id => !runs.has(id)).sort() };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Refuse when a cockpit serves the project; include live tasks in that first refusal. The fence checks them again. */
export async function assertNoProjectCockpit(root: string, homes: readonly Home[], self = process.pid): Promise<void> {
  const cockpits = await projectCockpits(root, homes, self);
  if (cockpits.length === 0) return;
  let tasks: LiveProjectTask[];
  try { tasks = projectLiveTasksOffline(root); }
  catch (error) {
    throw new ProjectInUseError(root, cockpits, [], error instanceof Error ? error.message : String(error));
  }
  throw new ProjectInUseError(root, cockpits, tasks);
}

/** The project's live tasks, read without writing anything. */
export function projectLiveTasksOffline(root: string): LiveProjectTask[] {
  return projectLiveTasks(readLiveTaskView(root));
}

/** The tasks of families another live process claims, read without writing anything: the fence's check. */
export function projectForeignTasksOffline(root: string): LiveProjectTask[] {
  const view = readLiveTaskView(root);
  const { foreign } = view.persistedLiveRunIds();
  return projectLiveTasks({ ...view, persistedLiveRunIds: () => ({ live: [], foreign }) });
}

/**
 * The ids of every task of the project that can still resume: each live task, and each task not
 * archived, since a human can Continue a done, review, failed or cancelled task from its stored
 * worktree. A migration leaves their own items in place. A deleted task has no record, so its
 * items move.
 */
export function projectKeptRunIds(root: string): ReadonlySet<string> {
  const view = readLiveTaskView(root);
  // A task not archived may still be continued; with its record unreadable, its files cannot be proven safe to move.
  const unreadable = view.unreadableUnarchived();
  if (unreadable.length > 0) {
    throw new Error(`Cannot migrate ${root}: these tasks are not archived but their records cannot be read: ${unreadable.join(', ')}. `
      + 'Open the project with the binary that wrote them and archive or delete each one, then retry');
  }
  const kept = new Set(projectLiveTasks(view).map(task => task.id));
  for (const run of view.allRuns()) if (!run.archived) kept.add(run.id);
  return kept;
}
