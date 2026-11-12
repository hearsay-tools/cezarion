import { acquirePooledCiResources, type CiResources } from './resource-pool.ts';
import type { CiProgressRegistry } from './progress.ts';
import { CiWatcherSupervisor } from './supervisor.ts';
export type { CiResources, CiSupervisorLike } from './resource-pool.ts';

/** The workspace's shared CI watcher and tool controller. A composition root passes this to each
 *  `RunManager`; managers on one semaphore share one supervisor and one controller. */
export function acquireCiResources(workspace: object): CiResources<CiWatcherSupervisor> {
  return acquirePooledCiResources(workspace, createCiWatcherSupervisor);
}

/** One function for every acquire: the pool tells supervisor factories apart by identity. */
function createCiWatcherSupervisor(progress: CiProgressRegistry): CiWatcherSupervisor {
  return new CiWatcherSupervisor({ progress });
}
