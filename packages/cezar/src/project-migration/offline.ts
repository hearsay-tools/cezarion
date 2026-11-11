import type { Home } from '../home/home.ts';
import { pathPresent, projectPaths } from '../project-paths.ts';
import { assertProjectAdmitted, CockpitOwnership } from '../server/cockpit-ownership.ts';
import { dryRunAnswer, migrationAnswer, type ProjectMigrationAnswer } from './answer.ts';
import { migrateProject } from './engine.ts';
import { assertNoProjectCockpit, projectForeignTasksOffline } from './live.ts';
import { recoverProjectMigration } from './recovery.ts';
import type { MigrationFault } from './steps.ts';

/**
 * One offline project migration (hearsay-tools/cezarion#3089). It refuses while any cockpit it can
 * see serves the project (`live.ts`). It then takes the project's `cockpit.lock` and its migration
 * fence, so no cockpit boots on the project and no process that checks admission is admitted; under the fence it
 * refuses while another live process claims a task, then runs the engine and releases both claims.
 * Every other task that is not archived keeps its own items in `.ai/cezar/`. An unfinished
 * journal finishes first and is reported as the migration. A dry run holds only `cockpit.lock`
 * while it plans and writes nothing.
 */
export async function migrateProjectOffline(root: string, options: {
  homes: readonly Home[]; dryRun: boolean; fault?: MigrationFault | undefined; self?: number | undefined;
}): Promise<ProjectMigrationAnswer> {
  const dataDir = projectPaths(root).write;
  await assertNoProjectCockpit(root, options.homes, options.self);
  const ownership = new CockpitOwnership();
  try {
    const recovered = await recoverProjectMigration(root, { ownership, keep: true });
    if (options.dryRun) {
      // An admitted read under `cockpit.lock`, claimed in the directory that exists.
      const existing = projectPaths(root).reads.find(pathPresent);
      if (existing) await ownership.acquire(existing);
      assertProjectAdmitted(dataDir);
      options.fault?.('plan:before');
      return await dryRunAnswer(root, recovered);
    }
    if (recovered) return migrationAnswer(recovered);
    assertProjectAdmitted(dataDir);
    return await moveUnderFence(root, ownership, options.fault);
  } finally {
    ownership.releaseAll();
  }
}

/**
 * The move itself, shared by the command and the cockpit's automatic move: take the fence with
 * `ownership` (which owns, or then owns, `cockpit.lock`), refuse while another live process claims
 * a task (the check reads the run stores without writing, so a refusal writes nothing), run the
 * engine, which leaves the own items of the kept tasks (live or not archived) in place, release the fence. The caller
 * keeps or releases `cockpit.lock`.
 */
export async function moveUnderFence(root: string, ownership: CockpitOwnership, fault?: MigrationFault): Promise<ProjectMigrationAnswer> {
  const fence = await ownership.fenceProject(projectPaths(root).write, { liveTasks: () => projectForeignTasksOffline(root) });
  try {
    return migrationAnswer(await migrateProject({ repoRoot: root, fence, ...(fault ? { fault } : {}) }));
  } finally { fence.release(); }
}
