import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { createRunner } from '../core/runner-factory.ts';
import { removeOwnedWorkspace } from '../delegation/workspace.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { CockpitOwnership, ProjectMigrationFencedError, projectAdmissionRefusal } from '../server/cockpit-ownership.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { migrateProject, resumeProjectMigration } from './engine.ts';
import { Crash, crashAt, crashThenRecover, disposers, fence, beforeRepair, moved, owners, recordedMigration, rows, TIMEOUT } from './engine.testkit.ts';
import { readProjectMigrationJournal } from './journal.ts';
import { projectSnapshot, removeMigrationProject, TASK, type MigrationProject } from './project-migration.testkit.ts';
import { createRunManager } from '../server/run-manager.testkit.ts';

/** Crash recovery of the project migration engine from its repair on (hearsay-tools/cezarion#3088): a
 *  crash at every fault point of the worktree repair, the receipts, the run store and the run files,
 *  a failed run-store transaction, and the journal's admission block, each resumed under a new fence. */

/** A real cleanup checkpoint: the removal stops right after writing it, with the worktree in place. */
async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

describe('crash recovery from the repair on', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  let reference: Record<string, string>;
  let points: string[] = [];
  beforeAll(async () => { ({ project, points, reference } = await recordedMigration(checkpoint)); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('completes the same result with no duplicate rewrite after a crash at any fault point of the repair, receipt, run-store and run-file steps', async () => {
    const own = points.filter(point => !beforeRepair(point));
    expect(own.length).toBeGreaterThan(10);
    for (const point of own) {
      await crashThenRecover(project, point);
      // Same files, Git metadata, receipts, rows, revisions and commit sequence: no rewrite ran twice.
      expect(projectSnapshot(project), point).toEqual(reference);
    }
  });

  it('rolls back every row when the one run-store transaction fails, and a resume finishes it', async () => {
    project.restore();
    const original = rows(join(project.dataDir, RUNS_DB_FILE));
    const held = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: held, fault: crashAt('run-store:commit') })).rejects.toThrow('run-store:commit');
    held.release();
    expect(rows(join(project.newDir, RUNS_DB_FILE))).toEqual(original);
    expect(readProjectMigrationJournal(join(project.root, '.ai/squawk-migration.json'))?.done).toEqual(['lock-worktrees', 'move', 'repair-worktrees', 'receipts']);
    const recovery = await fence(project);
    try { await resumeProjectMigration({ repoRoot: project.root, fence: recovery }); } finally { recovery.release(); }
    expect(projectSnapshot(project)).toEqual(reference);
  });

  it('keeps ordinary project reads out while a journal is unfinished, and a lazy build finishes it before reading', async () => {
    project.restore();
    const crashed = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt('receipts:after') })).rejects.toThrow(Crash);
    crashed.release();
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), ownership,
      listProjects: async () => [{ id: 'p', root: project.root, status: 'not-git' as const }] });
    disposers.push(() => contexts.disposeAll());
    await expect(ownership.acquire(project.newDir)).rejects.toBeInstanceOf(ProjectMigrationFencedError);
    expect(projectAdmissionRefusal(project.newDir)?.reason).toBe('journal');
    // Early recovery (hearsay-tools/cezarion#3089): the build finishes the journal first.
    const context = await contexts.context('p');
    expect(projectAdmissionRefusal(project.newDir)).toBeUndefined();
    await context.store.reports.idle();
    expect(context.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
    expect(existsSync(join(project.dataDir, RUNS_DB_FILE))).toBe(false);
  });
});
