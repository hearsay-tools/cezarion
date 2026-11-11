import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace } from '../delegation/workspace.ts';
import { handoffPath } from '../handoff.ts';
import { LEGACY_RUNS_FILE } from '../legacy-runs.ts';
import { isFallbackProjectPath } from '../project-paths.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { fence, moved, rows, TIMEOUT } from './engine.testkit.ts';
import { migrateProject } from './engine.ts';
import { describeProjectMigrationPlan, planProjectMigration } from './plan.ts';
import {
  buildMigrationProject, CHECKPOINTED, git, PARENT, projectSnapshot, removeMigrationProject, SNAPSHOT, TASK, WORKER, type MigrationProject,
} from './project-migration.testkit.ts';

/**
 * A project move with live tasks (owner decision A, hearsay-tools/cezarion#2778): the store and
 * every item no live task owns move; a live task's own items stay in `.ai/cezar/` with their stored
 * paths, and a later move carries them once the task is no longer live.
 */

async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

const rowsById = (path: string) => new Map(rows(path).map(row => [row.id, row]));

async function migrateWith(project: MigrationProject, live: readonly string[]) {
  const held = await fence(project);
  try { return await migrateProject({ repoRoot: project.root, fence: held, liveRunIds: () => new Set(live) }); }
  finally { held.release(); }
}

describe('a project move with live tasks', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked: false, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('the dry run lists the live tasks that keep their items, and writes nothing', async () => {
    project.restore();
    const before = projectSnapshot(project, { databaseBytes: true });
    const plan = await planProjectMigration(project.root, { keep: new Set([PARENT, CHECKPOINTED]) });
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);
    expect(plan.leftovers).toEqual([PARENT, CHECKPOINTED].sort());
    expect(plan.moves.map(move => move.from)).not.toContain(project.checkpointed.path);
    expect(plan.moves.map(move => move.from)).not.toContain(join(project.dataDir, 'runs', `${PARENT}-worker-results`));
    expect(plan.worktrees.map(worktree => worktree.from)).not.toContain(project.checkpointed.path);
    expect(describeProjectMigrationPlan(plan)).toContain(`Kept in .ai/cezar/ for live tasks until they end:\n  ${[PARENT, CHECKPOINTED].sort().join('\n  ')}`);
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
});
