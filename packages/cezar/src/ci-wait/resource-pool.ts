import { logPrefix } from '../home/display.ts';
import { CiToolController } from './controller.ts';
import { CiProgressRegistry } from './progress.ts';
import type { CiWatcherSupervisor } from './supervisor.ts';

/** What a manager uses of the workspace's CI watcher. */
export type CiSupervisorLike = Pick<CiWatcherSupervisor, 'resolve' | 'watch' | 'close'>;

/** One manager's handle on its workspace's shared CI resources. */
export interface CiResources<Supervisor extends CiSupervisorLike = CiSupervisorLike> {
  supervisor: Supervisor;
  /** The check progress the supervisor publishes, for the activity view. */
  progress: CiProgressRegistry;
  controller(): Promise<CiToolController>;
  release(): void;
}

/** The workspace semaphore is shared by cockpit projects; headless callers have one too. */
const workspaces = new WeakMap<object, {
  refs: number;
  /** The factory that built `supervisor`: every manager on one workspace must pass the same one. */
  createSupervisor: (progress: CiProgressRegistry) => CiSupervisorLike;
  supervisor: CiSupervisorLike;
  /** The check progress the supervisor publishes, for the activity view. */
  progress: CiProgressRegistry;
  controller?: Promise<CiToolController> | undefined;
}>();

/** The first acquire for a workspace builds its supervisor; later acquires share it until the
 *  last release. `ci-wait/resources.ts` binds the real `CiWatcherSupervisor`. A later acquire with
 *  another factory throws, so a test's stand-in and the real watcher never share a workspace. */
export function acquirePooledCiResources<Supervisor extends CiSupervisorLike>(
  workspace: object,
  createSupervisor: (progress: CiProgressRegistry) => Supervisor,
): CiResources<Supervisor> {
  let resource = workspaces.get(workspace);
  if (resource && resource.createSupervisor !== createSupervisor) {
    throw new Error('This workspace already holds CI resources from another supervisor factory. Every RunManager on one semaphore must pass the same acquireCiResources.');
  }
  if (!resource) {
    const progress = new CiProgressRegistry();
    resource = { refs: 0, createSupervisor, supervisor: createSupervisor(progress), progress };
    workspaces.set(workspace, resource);
  }
  const shared = resource;
  shared.refs++;
  let released = false;
  return {
    supervisor: shared.supervisor as Supervisor,
    progress: shared.progress,
    // hearsay-tools/cezarion#2397: only a started controller is kept. A failed start is forgotten,
    // so the next launch after a repair starts it again.
    controller: () => {
      if (shared.controller) return shared.controller;
      const starting = CiToolController.start();
      shared.controller = starting;
      starting.catch((error: unknown) => {
        if (shared.controller === starting) shared.controller = undefined;
        console.warn(`${logPrefix()} ${error instanceof Error ? error.message : String(error)}`);
      });
      return starting;
    },
    release() {
      if (released) return;
      released = true;
      if (--shared.refs !== 0) return;
      workspaces.delete(workspace);
      shared.supervisor.close();
      void shared.controller?.then(controller => controller.close()).catch(() => {});
    },
  };
}
