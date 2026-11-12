import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace } from '../delegation/workspace-removal.ts';
import { assertDurableOrder, crashThenCheckDurability, beforeRepair, migrate, recordedMigration, recording, TIMEOUT } from './engine.testkit.ts';
import type { ProjectMigrationJournal } from './journal.ts';
import { removeMigrationProject, type MigrationProject } from './project-migration.testkit.ts';

/** The project migration's durability invariant (durable.ts, hearsay-tools/cezarion#3088), checked
 *  over the durable seam on the first run and on a resume from every fault point up to the moves.
 *  The repair and the rewrites are in engine-durability-rewrites.test.ts. */

/** A real cleanup checkpoint: the removal stops right after writing it, with the worktree in place. */
async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

describe('the durability invariant up to the moves', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  let points: string[] = [];
  beforeAll(async () => { ({ project, points } = await recordedMigration(checkpoint)); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('settles every effect before each action that depends on it, on the first run and on a resume from every fault point up to the moves', async () => {
    project.restore();
    let journal: ProjectMigrationJournal | undefined;
    const first = await recording(async fault => { journal = (await migrate(project, fault)).journal; });
    assertDurableOrder(first, journal!, 'first run');
    const own = points.filter(beforeRepair);
    expect(own.length).toBeGreaterThan(15);
    for (const point of own) await crashThenCheckDurability(project, point);
  });
});
