import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { parentFileSnapshotPath, verifyWorkerContext } from '../delegation/context.ts';
import { ownedWorkflow, workerContextHash, workerWorkflowHash } from '../delegation/execution-identity.ts';
import { removeOwnedWorkspace } from '../delegation/workspace.ts';
import { handoffPath } from '../handoff.ts';
import { LEGACY_RUNS_FILE } from '../legacy-runs.ts';
import { isFallbackProjectPath } from '../project-paths.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { fence, moved, rows, TIMEOUT } from './engine.testkit.ts';
import { migrateProject } from './engine.ts';
import { projectKeptRunIds } from './live.ts';
import { describeProjectMigrationPlan, planProjectMigration } from './plan.ts';
import {
  buildMigrationProject, CHECKPOINTED, git, PARENT, projectSnapshot, removeMigrationProject, SNAPSHOT, TASK, WORKER, type MigrationProject,
} from './project-migration.testkit.ts';

/**
 * A project move with tasks that can still resume (owner decision A, hearsay-tools/cezarion#2778):
 * the store and every item no kept task owns move; a kept task's own items (a live task's, or a
 * task's that is not archived) stay in `.ai/cezar/` with their stored paths, and a later move
 * carries them once the task is archived or deleted.
 */

async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

const rowsById = (path: string) => new Map(rows(path).map(row => [row.id, row]));

async function migrateWith(project: MigrationProject, kept?: readonly string[]) {
  const held = await fence(project);
  try { return await migrateProject({ repoRoot: project.root, fence: held, ...kept ? { keptRunIds: () => new Set(kept) } : {} }); }
  finally { held.release(); }
}

function setArchived(dataDir: string, id: string, archived: boolean): void {
  const store = RunStore.open(dataDir, { keepLive: true });
  try { store.setArchived(id, archived); store.flush(); } finally { store.close(); }
}

describe('a project move with tasks that can still resume', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked: false, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('the dry run lists the tasks that keep their items, and writes nothing', async () => {
    project.restore();
    const before = projectSnapshot(project, { databaseBytes: true });
    const plan = await planProjectMigration(project.root, { keep: new Set([PARENT, CHECKPOINTED]) });
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);
    expect(plan.leftovers).toEqual([PARENT, CHECKPOINTED].sort());
    expect(plan.moves.map(move => move.from)).not.toContain(project.checkpointed.path);
    expect(plan.moves.map(move => move.from)).not.toContain(join(project.dataDir, 'runs', `${PARENT}-worker-results`));
    expect(plan.worktrees.map(worktree => worktree.from)).not.toContain(project.checkpointed.path);
    expect(describeProjectMigrationPlan(plan)).toContain(`Kept in .ai/cezar/ for tasks until they are archived:\n  ${[PARENT, CHECKPOINTED].sort().join('\n  ')}`);
  });

  it('keeps a live parent\'s results and a live worker\'s worktree in place, rewrites only paths to moved items, and moves them once they end', async () => {
    project.restore();
    const resultFile = join(project.dataDir, 'runs', `${PARENT}-worker-results`, `${WORKER}.${SNAPSHOT}.json`);
    const result = await migrateWith(project, [PARENT, CHECKPOINTED]);
    expect(result.journal.leftovers).toEqual([PARENT, CHECKPOINTED].sort());
    expect(JSON.parse(readFileSync(join(project.newDir, LEGACY_RUNS_FILE), 'utf8'))).toEqual({ version: 1, runs: [PARENT, CHECKPOINTED].sort() });

    // The store and the ended tasks' items moved.
    expect(existsSync(join(project.newDir, RUNS_DB_FILE))).toBe(true);
    expect(existsSync(moved(project, project.taskPath))).toBe(true);
    expect(existsSync(moved(project, project.worker.path))).toBe(true);
    // The live parent's result file stayed; the moved worker's paths in it were rewritten in place, its own path was not.
    const stored = JSON.parse(readFileSync(resultFile, 'utf8'));
    expect(stored.result.workspace.path).toBe(moved(project, project.worker.path));
    expect(stored.result.diff.path).toBe(resultFile);
    expect(stored.result.artifacts.items[0].path).toBe(moved(project, stored.result.artifacts.items[0].path.replace('/.ai/squawk/', '/.ai/cezar/')));
    // The live worker kept its worktree, its row and Git registration; the store resolves its files in .ai/cezar/.
    expect(existsSync(project.checkpointed.path)).toBe(true);
    const after = rowsById(join(project.newDir, RUNS_DB_FILE));
    expect(after.get(CHECKPOINTED)?.worktreePath).toBe(project.checkpointed.path);
    expect(after.get(WORKER)?.worktreePath).toBe(moved(project, project.worker.path));
    expect(git(project.root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${project.checkpointed.path}\n`);
    expect(handoffPath(project.newDir, PARENT)).toBe(join(project.dataDir, 'runs', `${PARENT}.handoff.md`));
    expect(handoffPath(project.newDir, TASK)).toBe(join(project.newDir, 'runs', `${TASK}.handoff.md`));

    // A destroy retry of the live worker still works with the stored path.
    expect(isFallbackProjectPath(project.root, project.checkpointed.path)).toBe(false);
    expect(isFallbackProjectPath(project.root, join(project.dataDir, RUNS_DB_FILE))).toBe(true);

    // Both end: the next move carries what they kept, and removes what that left empty.
    const next = await migrateWith(project, []);
    expect(next.alreadyMoved).toBe(false);
    expect(next.journal.leftovers).toEqual([]);
    expect(existsSync(join(project.newDir, LEGACY_RUNS_FILE))).toBe(false);
    expect(existsSync(project.checkpointed.path)).toBe(false);
    expect(rowsById(join(project.newDir, RUNS_DB_FILE)).get(CHECKPOINTED)?.worktreePath).toBe(moved(project, project.checkpointed.path));
    expect(git(project.root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${moved(project, project.checkpointed.path)}\n`);
    expect(existsSync(join(project.newDir, 'runs', `${PARENT}-worker-results`, `${WORKER}.${SNAPSHOT}.json`))).toBe(true);
    for (const empty of ['runs', 'worktrees']) expect(existsSync(join(project.dataDir, empty))).toBe(false);
    // A third start finds nothing left to move.
    const third = await migrateWith(project, []);
    expect(third.alreadyMoved).toBe(true);
  });

  it('a destroy retry of a worker kept in place removes its worktree by the stored path after the move', async () => {
    project.restore();
    await migrateWith(project, [CHECKPOINTED]);
    expect(existsSync(project.checkpointed.path)).toBe(true);
    await removeOwnedWorkspace(project.root, project.checkpointed);
    expect(existsSync(project.checkpointed.path)).toBe(false);
    expect(git(project.root, 'worktree', 'list', '--porcelain')).not.toContain(project.checkpointed.path);
    // The task's items are gone: the next move drops it from the list and removes the emptied directories.
    const next = await migrateWith(project, [CHECKPOINTED]);
    expect(next.journal.leftovers).toEqual([]);
    expect(existsSync(join(project.newDir, LEGACY_RUNS_FILE))).toBe(false);
    expect(existsSync(join(project.dataDir, 'worktrees'))).toBe(false);
  });

  it('keeps a finished task that is not archived in place, and moves it at the next move once it is archived', async () => {
    project.restore();
    // The worker is done but not archived: a human can still Continue it from its worktree.
    setArchived(project.dataDir, WORKER, false);
    const first = await migrateWith(project);
    expect(first.journal.leftovers).toEqual([WORKER]);
    expect(existsSync(project.worker.path)).toBe(true);
    expect(rowsById(join(project.newDir, RUNS_DB_FILE)).get(WORKER)?.worktreePath).toBe(project.worker.path);
    // Archived tasks moved, whatever their state.
    expect(existsSync(moved(project, project.taskPath))).toBe(true);
    expect(existsSync(moved(project, project.checkpointed.path))).toBe(true);

    // Still not archived: the next move keeps it.
    const second = await migrateWith(project);
    expect(second.alreadyMoved).toBe(true);
    expect(existsSync(project.worker.path)).toBe(true);

    // Archived: the next move carries its worktree and removes what that left empty.
    setArchived(project.newDir, WORKER, true);
    const third = await migrateWith(project);
    expect(third.journal.leftovers).toEqual([]);
    expect(existsSync(project.worker.path)).toBe(false);
    expect(rowsById(join(project.newDir, RUNS_DB_FILE)).get(WORKER)?.worktreePath).toBe(moved(project, project.worker.path));
    expect(existsSync(join(project.newDir, LEGACY_RUNS_FILE))).toBe(false);
    expect(existsSync(join(project.dataDir, 'worktrees'))).toBe(false);
  });

  it('keeps a kept worker\'s context recipe and catalog workflow as its identity binds them, so Continue still verifies', async () => {
    project.restore();
    const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const workflowDef = { name: 'local', source: 'file' as const, path: join(project.dataDir, 'workflows/local.yaml'), steps: [] };
    // A parent-file input (its copy in the worker worktree, its snapshot in the worker's -images) and a parent attachment.
    const fileBytes = 'parent file bytes', attachmentBytes = 'attachment bytes';
    writeFileSync(join(project.worker.path, 'notes.txt'), fileBytes);
    const fileSnapshot = await parentFileSnapshotPath(project.dataDir, project.worker, 0);
    const attachmentSnapshot = await parentFileSnapshotPath(project.dataDir, project.worker, 1);
    mkdirSync(join(project.dataDir, 'runs', `${WORKER}-images`), { recursive: true });
    writeFileSync(fileSnapshot, fileBytes);
    writeFileSync(attachmentSnapshot, attachmentBytes);
    const context = { inputs: [
      { source: { kind: 'parent-file' as const, path: 'notes.txt' }, path: join(project.worker.path, 'notes.txt'), sha256: sha(fileBytes), bytes: fileBytes.length },
      { source: { kind: 'parent-attachment' as const, id: 'pasted-1.png' }, path: attachmentSnapshot, sha256: sha(attachmentBytes), bytes: attachmentBytes.length },
    ] };
    const store = RunStore.open(project.dataDir, { keepLive: true });
    try {
      const worker = store.getRun(WORKER)!;
      setRunStatus(store, WORKER, 'done', { archived: false, workflowDef, delegation: { ...worker.delegation!, context } as never });
      store.flush();
    } finally { store.close(); }
    writeFileSync(join(project.dataDir, 'runs', `${WORKER}.identity.json`), JSON.stringify({ kind: 'internal', workflowHash: workerWorkflowHash(workflowDef) }), { mode: 0o600 });
    const contextHash = workerContextHash(context);

    expect((await migrateWith(project)).journal.leftovers).toEqual([WORKER]);
    const moved = RunStore.open(project.newDir, { keepLive: true });
    try {
      const run = moved.getRun(WORKER)!;
      expect(run.workflowDef?.path).toBe(workflowDef.path);
      expect(ownedWorkflow(run, moved.readWorkerIdentity(WORKER))).toEqual(workflowDef);
      const recipe = run.delegation?.role === 'worker' ? run.delegation.context : undefined;
      expect(recipe && workerContextHash(recipe)).toBe(contextHash);
      await expect(verifyWorkerContext({ dataDir: project.newDir, parentId: PARENT, workspace: project.worker, context: recipe,
        parentCwd: project.root })).resolves.toBeUndefined();
    } finally { moved.close(); }
  });

  it('rewrites an unreadable kept-task list from the run store at the next move, with items left or not', async () => {
    project.restore();
    await migrateWith(project, [CHECKPOINTED]);
    const file = join(project.newDir, LEGACY_RUNS_FILE);
    writeFileSync(file, '{"version":1,');
    const repaired = await migrateWith(project, [CHECKPOINTED]);
    expect(repaired.alreadyMoved).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, runs: [CHECKPOINTED] });
    // Nothing left in .ai/cezar/: an unreadable list still makes the move run, and the move removes it.
    expect((await migrateWith(project, [])).journal.leftovers).toEqual([]);
    expect(existsSync(join(project.dataDir, 'worktrees'))).toBe(false);
    writeFileSync(file, 'not json');
    const cleared = await migrateWith(project, []);
    expect(cleared.alreadyMoved).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('blocks the plan when a directory that may hold a kept task\'s item cannot be listed', async () => {
    project.restore();
    const worktrees = join(project.dataDir, 'worktrees');
    chmodSync(worktrees, 0o000);
    try {
      const plan = await planProjectMigration(project.root, { keep: new Set([CHECKPOINTED]) });
      expect(plan.blockers.join('\n')).toContain(`Cannot list ${worktrees}`);
      expect(plan.moves.map(move => move.from)).not.toContain(worktrees);
    } finally { chmodSync(worktrees, 0o755); }
  });

  it('refuses a task not archived whose record cannot be read, and moves an archived one', async () => {
    project.restore();
    const database = new DatabaseSync(join(project.dataDir, RUNS_DB_FILE));
    try { database.prepare('UPDATE runs SET data = ?, archived = 0 WHERE id = ?').run('{"unknown":true}', TASK); } finally { database.close(); }
    expect(() => projectKeptRunIds(project.root)).toThrow(`these tasks are not archived but their records cannot be read: ${TASK}`);
    const held = await fence(project);
    try { await expect(migrateProject({ repoRoot: project.root, fence: held })).rejects.toThrow(TASK); } finally { held.release(); }
    expect(existsSync(join(project.newDir, RUNS_DB_FILE))).toBe(false);

    const archived = new DatabaseSync(join(project.dataDir, RUNS_DB_FILE));
    try { archived.prepare('UPDATE runs SET archived = 1 WHERE id = ?').run(TASK); } finally { archived.close(); }
    expect(projectKeptRunIds(project.root).has(TASK)).toBe(false);
  });
});
