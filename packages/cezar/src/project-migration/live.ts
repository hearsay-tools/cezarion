import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Home } from '../home/home.ts';
import { readCockpitLeases } from '../home/leases.ts';
import { projectPaths } from '../project-paths.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { RunStore } from '../runs/store.ts';
import { anotherCockpitOwner, type LiveProjectTask } from '../server/cockpit-ownership.ts';
import { projectLiveTasks } from '../server/project-context.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';

/**
 * Whether anything is live for a project (hearsay-tools/cezarion#3089). A project migration runs
 * offline: it refuses while a cockpit serves the project or a task of it is live, and names what to
 * stop. Shared by every caller that starts a migration.
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
  constructor(readonly project: string, readonly cockpits: readonly ProjectCockpit[], readonly tasks: readonly LiveProjectTask[]) {
    const lines = [
      ...cockpits.map(cockpit => `- cockpit pid ${cockpit.pid}${cockpit.url ? ` at ${cockpit.url}` : cockpit.port ? ` on port ${cockpit.port}` : ''}`
        + `${cockpit.instance ? `, instance ${cockpit.instance}` : ''}${cockpit.home ? `, home ${cockpit.home}` : ''}: stop it`),
      ...tasks.map(task => `- task ${task.id} ${task.title} (${task.state}): finish or cancel it`),
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

/** The project's run store, opened to read its live tasks; none when neither directory holds runs. */
export function openLiveTaskStore(root: string): RunStore | undefined {
  if (!projectPaths(root).reads.some(directory => existsSync(join(directory, RUNS_DB_FILE)) || existsSync(join(directory, 'runs.json')))) return undefined;
  return RunStore.open(projectPaths(root).write, { keepLive: true, maintenance: true });
}

/** Refuse when a cockpit serves the project; live tasks are checked under the fence (`fenceProject`). */
export async function assertNoProjectCockpit(root: string, homes: readonly Home[], self = process.pid): Promise<void> {
  const cockpits = await projectCockpits(root, homes, self);
  if (cockpits.length > 0) throw new ProjectInUseError(root, cockpits, []);
}

/** The live tasks of `store`, as the fence's live-task check; none without a store. */
export function liveTasksOf(store: RunStore | undefined): LiveProjectTask[] {
  return store ? projectLiveTasks(store) : [];
}
