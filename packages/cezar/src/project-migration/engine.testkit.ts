import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { PROJECT_MOVED_FILE } from '../project-paths.ts';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { CockpitOwnership, projectAdmissionRefusal, type ProjectMigrationFence } from '../server/cockpit-ownership.ts';
import { directoriesDown, durable } from './durable.ts';
import { migrateProject, resumeProjectMigration } from './engine.ts';
import { readProjectMigrationJournal, type ProjectMigrationJournal } from './journal.ts';
import { buildMigrationProject, projectSnapshot, type MigrationProject } from './project-migration.testkit.ts';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';

/** Shared helpers of the project migration engine tests (hearsay-tools/cezarion#3088). */

// bound: each case restores a real repository and runs Git, a worktree-lock keeper and SQLite.
export const TIMEOUT = 300_000;
const none = { liveTasks: () => [] };
export const owners: CockpitOwnership[] = [];
export const disposers: Array<() => void> = [];

/** A fence of a CLI that no cockpit serves; its release lets go of the ownership claim too, as the
 *  CLI's exit (or death) would. */
export async function fence(project: MigrationProject): Promise<ProjectMigrationFence> {
  const ownership = new CockpitOwnership();
  owners.push(ownership);
  const held = await ownership.fenceProject(project.dataDir, none);
  return { ...held, release: () => ownership.releaseAll() };
}

/** A whole migration under a fence, released after, as P4b3's caller will do. */
export async function migrate(project: MigrationProject, fault?: (point: string) => void) {
  const held = await fence(project);
  try { return await migrateProject({ repoRoot: project.root, fence: held, ...(fault ? { fault } : {}) }); }
  finally { held.release(); }
}

/** A process death at a fault point. The test then releases the fence, as the death would let a
 *  later claim reclaim it. */
export class Crash extends Error {}
export const crashAt = (point: string) => (at: string) => { if (at === point) throw new Crash(point); };

/** The durability invariant (durable.ts) checked on a recorded run: every fault point is an action
 *  that depends on the effects before it, so the syncs each effect needs must appear after the
 *  previous fault point and before it. A resumed run is checked the same way: items it finds
 *  applied still need their syncs. */
export function assertDurableOrder(events: readonly string[], journal: ProjectMigrationJournal, label: string): void {
  const root = dirname(journal.destination);
  const chain = (path: string) => directoriesDown(root, path).map(directory => `dir:${directory}`);
  const admin = (worktree: string) => resolve(worktree, readFileSync(join(worktree, '.git'), 'utf8').replace(/^gitdir: /, '').trim());
  const files = (kinds: readonly string[]) => [...new Set(journal.rewrites.flatMap(rewrite => 'file' in rewrite && kinds.includes(rewrite.kind) ? [rewrite.file] : []))];
  const receipts = files(['receipt', 'cleanup-checkpoint']);
  const evidence = files(['worker-execution', 'autosave-cleanup', 'worker-result', 'artifact-metadata', 'handoff']);
  const required = (point: string): string[] => {
    const [step, kind, at] = point.split(':');
    const index = Number(at);
    if (step === 'move' && kind === 'item') return [...chain(dirname(journal.moves[index]!.to)), ...chain(dirname(journal.moves[index]!.from))];
    if (step === 'lock-worktrees' && kind === 'item') return [`dir:${admin(journal.worktrees[index]!.to)}`];
    if (step === 'repair-worktrees' && kind === 'unlock') {
      const worktree = journal.worktrees[index]!.to;
      return [`file:${join(worktree, '.git')}`, `dir:${worktree}`, `file:${join(admin(worktree), 'gitdir')}`, `dir:${admin(worktree)}`];
    }
    if (step === 'repair-worktrees' && kind === 'item') return [`dir:${admin(journal.worktrees[index]!.to)}`];
    if (step === 'receipts' && kind === 'item') return [`file:${receipts[index]!}`, `dir:${dirname(receipts[index]!)}`];
    if (step === 'run-files' && kind === 'item') return [`file:${evidence[index]!}`, ...chain(dirname(evidence[index]!))];
    if (point === 'run-store:after' && journal.rewrites.some(rewrite => rewrite.kind === 'run-row')) return [`file:${join(journal.destination, RUNS_DB_FILE)}`, ...chain(journal.destination)];
    if (point === 'mark-moved:after') return [`file:${join(journal.destination, PROJECT_MOVED_FILE)}`, ...chain(journal.destination)];
    if (kind === 'marked' || point === 'journal:written') return [`file:${join(root, 'squawk-migration.json')}`, `dir:${root}`];
    return [];
  };
  let window: string[] = [];
  for (const event of events) {
    if (event.startsWith('dir:') || event.startsWith('file:')) { window.push(event); continue; }
    for (const sync of required(event)) expect(window, `${label}: ${event} needs ${sync}`).toContain(sync);
    window = [];
  }
  expect(window, `${label}: the journal removal`).toContain(`dir:${root}`);
}

/** Run `work` recording each durable call and each fault point, in order. */
export async function recording(work: (fault: (point: string) => void) => Promise<unknown>): Promise<string[]> {
  const events: string[] = [];
  const directory = vi.spyOn(durable, 'directory').mockImplementation((path) => { events.push(`dir:${path}`); });
  const file = vi.spyOn(durable, 'file').mockImplementation((path) => { events.push(`file:${path}`); });
  try { await work(point => { events.push(point); }); } finally { directory.mockRestore(); file.mockRestore(); }
  return events;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const ownership of owners.splice(0)) ownership.releaseAll();
});

export function rows(path: string) {
  const db = RunDatabase.openReadOnly(path)!;
  try { return db.listAll().map(({ id, revision, worktreePath, data, summary }) => ({ id, revision, worktreePath, data, summary })); }
  finally { db.close(); }
}

export const moved = (project: MigrationProject, path: string) => path.replace(project.dataDir, project.newDir);


/** The fault points up to the moves (the journal's first write, the worktree locks, the moves); the rest
 *  belong to the repair and the rewrites. Each crash matrix is split along this line into two test
 *  files of about the same length, so each stays well below Vitest's per-file duration cap. */
export const beforeRepair = (point: string): boolean => /^(?:journal|lock-worktrees|move):/.test(point);

/** A main-checkout project, every fault point of an uninterrupted migration, and its final snapshot. */
export async function recordedMigration(checkpoint: (root: string, workspace: WorkerWorkspace) => Promise<void>): Promise<{
  project: MigrationProject; points: string[]; reference: Record<string, string>;
}> {
  const project = await buildMigrationProject({ linked: false, checkpoint });
  const points: string[] = [];
  await migrate(project, point => { points.push(point); });
  return { project, points, reference: projectSnapshot(project) };
}

/** Crash a fresh copy at `point`, check that the journal blocks admission, and recover under a new
 *  fence (resume, or a new migration when the crash came before the journal). */
export async function crashThenRecover(project: MigrationProject, point: string): Promise<void> {
  project.restore();
  const crashed = await fence(project);
  await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt(point) }), point).rejects.toThrow(point);
  crashed.release();
  // The journal blocks every ordinary reader until the recovery completes under a fence.
  expect(projectAdmissionRefusal(project.dataDir)?.reason, point).toBe(point === 'journal:before' ? undefined : 'journal');
  const recovery = await fence(project);
  try {
    const resumed = await resumeProjectMigration({ repoRoot: project.root, fence: recovery });
    expect(resumed?.resumed, point).toBe(point === 'journal:before' ? undefined : true);
    if (!resumed) await migrateProject({ repoRoot: project.root, fence: recovery });
  } finally { recovery.release(); }
}

/** Crash a fresh copy at `point`, then check the durability invariant over the resumed run. */
export async function crashThenCheckDurability(project: MigrationProject, point: string): Promise<void> {
  project.restore();
  const crashed = await fence(project);
  await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt(point) }), point).rejects.toThrow(point);
  crashed.release();
  const saved = readProjectMigrationJournal(join(project.root, '.ai/squawk-migration.json'));
  if (!saved) return;
  const recovery = await fence(project);
  try {
    const resumed = await recording(fault => resumeProjectMigration({ repoRoot: project.root, fence: recovery, fault }));
    assertDurableOrder(resumed, saved, `resume after ${point}`);
  } finally { recovery.release(); }
}
