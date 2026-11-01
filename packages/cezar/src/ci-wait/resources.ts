import { CiToolController } from './controller.ts';
import { CiWatcherSupervisor } from './supervisor.ts';

/** The workspace semaphore is shared by cockpit projects; headless callers have one too. */
const workspaces = new WeakMap<object, {
  refs: number;
  supervisor: CiWatcherSupervisor;
  controller?: Promise<CiToolController> | undefined;
}>();

export function acquireCiResources(workspace: object) {
  let resource = workspaces.get(workspace);
  if (!resource) {
    resource = { refs: 0, supervisor: new CiWatcherSupervisor() };
    workspaces.set(workspace, resource);
  }
  const shared = resource;
  shared.refs++;
  let released = false;
  return {
    supervisor: shared.supervisor,
    // hearsay-tools/cezarion#2397: only a started controller is kept. A failed start is forgotten,
    // so the next launch after a repair starts it again.
    controller: () => {
      if (shared.controller) return shared.controller;
      const starting = CiToolController.start();
      shared.controller = starting;
      starting.catch((error: unknown) => {
        if (shared.controller === starting) shared.controller = undefined;
        console.warn(`[cez] ${error instanceof Error ? error.message : String(error)}`);
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
