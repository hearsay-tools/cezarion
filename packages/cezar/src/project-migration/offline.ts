import type { Home } from '../home/home.ts';
import { pathPresent, projectPaths } from '../project-paths.ts';
import type { RunStore } from '../runs/store.ts';
import { assertProjectAdmitted, CockpitOwnership } from '../server/cockpit-ownership.ts';
import { dryRunAnswer, migrationAnswer, type ProjectMigrationAnswer } from './answer.ts';
import { migrateProject } from './engine.ts';
import { assertNoProjectCockpit, liveTasksOf, openLiveTaskStore } from './live.ts';
import { recoverProjectMigration } from './recovery.ts';
import type { MigrationFault } from './steps.ts';

/**
 * One offline project migration (hearsay-tools/cezarion#3089). It refuses while any cockpit it can
 * see serves the project (`live.ts`). It then takes the project's `cockpit.lock` and its migration
 * fence, so no cockpit boots on the project and no other process is admitted; under the fence it
 * refuses while any task is live, then runs the engine and releases both claims. An unfinished
 * journal finishes first and is reported as the migration. A dry run holds only `cockpit.lock`
 * while it plans and writes nothing.
 */
export async function migrateProjectOffline(root: string, options: {
  homes: readonly Home[]; dryRun: boolean; fault?: MigrationFault | undefined; self?: number | undefined;
}): Promise<ProjectMigrationAnswer> {
  const dataDir = projectPaths(root).write;
  await assertNoProjectCockpit(root, options.homes, options.self);
  const ownership = new CockpitOwnership();
  let store: RunStore | undefined;
  try {
    const recovered = await recoverProjectMigration(root, { ownership, keep: true });
    if (options.dryRun) {
      // An admitted read under `cockpit.lock`, claimed in the directory that exists.
      const existing = projectPaths(root).reads.find(pathPresent);
      if (existing) await ownership.acquire(existing);
      assertProjectAdmitted(dataDir);
      options.fault?.('plan:before');
      return await dryRunAnswer(root, recovered !== undefined);
    }
    if (recovered) return migrationAnswer(recovered);
    assertProjectAdmitted(dataDir);
    const fence = await ownership.fenceProject(dataDir, { liveTasks: () => liveTasksOf(store ??= openLiveTaskStore(root)) });
    try {
      return migrationAnswer(await migrateProject({ repoRoot: root, fence, closeProject: () => { store?.close(); store = undefined; },
        ...(options.fault ? { fault: options.fault } : {}) }));
    } finally { fence.release(); }
  } finally {
    store?.close();
    ownership.releaseAll();
  }
}
