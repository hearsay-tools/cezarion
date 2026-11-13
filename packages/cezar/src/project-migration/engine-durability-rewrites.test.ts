import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace } from '../delegation/workspace-removal.ts';
import { crashThenCheckDurability, beforeRepair, recordedMigration, TIMEOUT } from './engine.testkit.ts';
import { removeMigrationProject, type MigrationProject } from './project-migration.testkit.ts';

/** The project migration's durability invariant (durable.ts, hearsay-tools/cezarion#3088) on a resume
 *  from every fault point of the worktree repair, the receipts, the run store and the run files. */

/** A real cleanup checkpoint: the removal stops right after writing it, with the worktree in place. */
async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

describe('the durability invariant from the repair on', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  let points: string[] = [];
  beforeAll(async () => { ({ project, points } = await recordedMigration(checkpoint)); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('settles every effect before each action that depends on it, on a resume from every fault point of the repair and the rewrites', async () => {
    const own = points.filter(point => !beforeRepair(point));
    expect(own.length).toBeGreaterThan(10);
    for (const point of own) await crashThenCheckDurability(project, point);
  });
});
