import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace } from '../delegation/workspace.ts';
import { crashAt, fence, beforeRepair, crashThenRecover, recordedMigration, TIMEOUT } from './engine.testkit.ts';
import { migrateProject, resumeProjectMigration } from './engine.ts';
import { git, projectSnapshot, removeMigrationProject, type MigrationProject } from './project-migration.testkit.ts';

/** Crash recovery of the project migration engine up to its moves (hearsay-tools/cezarion#3088): a
 *  crash at every fault point of the journal's first write, the worktree locks and the moves, and a
 *  prune between the move and the repair, each resumed under a new fence. The repair and the
 *  rewrites are in engine-crash-rewrites.test.ts. */

/** A real cleanup checkpoint: the removal stops right after writing it, with the worktree in place. */
async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

describe('crash recovery up to the moves', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  let reference: Record<string, string>;
  let points: string[] = [];
  beforeAll(async () => { ({ project, points, reference } = await recordedMigration(checkpoint)); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('offers a fault point before and after every step effect and mark', () => {
    for (const step of ['move', 'repair-worktrees', 'receipts', 'run-store', 'run-files', 'mark-moved']) {
      expect(points).toEqual(expect.arrayContaining([`${step}:before`, `${step}:after`, `${step}:marked`]));
    }
    expect(points).toEqual(expect.arrayContaining(['journal:before', 'journal:written', 'lock-worktrees:item:0', 'move:prepared:0', 'move:renamed:0', 'move:item:0',
      'repair-worktrees:unlock:0', 'repair-worktrees:item:0', 'receipts:item:0', 'run-store:commit', 'run-files:item:0']));
  });

  it('completes the same result with no duplicate rewrite after a crash at any fault point of the journal, worktree lock and move steps', async () => {
    const own = points.filter(beforeRepair);
    expect(own.length).toBeGreaterThan(15);
    for (const point of own) {
      await crashThenRecover(project, point);
      // Same files, Git metadata, receipts, rows, revisions and commit sequence: no rewrite ran twice.
      expect(projectSnapshot(project), point).toEqual(reference);
    }
  });

  it('keeps every moved worktree registered when another checkout prunes between the move and the repair', async () => {
    for (const point of ['move:item:0', 'move:after', 'move:marked']) {
      project.restore();
      const crashed = await fence(project);
      await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt(point) }), point).rejects.toThrow(point);
      crashed.release();
      // Git's own prune, as any checkout sharing this Git directory runs it: it ignores Squawk's receipts.
      git(project.repo, 'worktree', 'prune');
      const recovery = await fence(project);
      try { await resumeProjectMigration({ repoRoot: project.root, fence: recovery }); } finally { recovery.release(); }
      expect(projectSnapshot(project), point).toEqual(reference);
      expect(git(project.root, 'worktree', 'list', '--porcelain')).not.toMatch(/^locked/m);
    }
  });
});
