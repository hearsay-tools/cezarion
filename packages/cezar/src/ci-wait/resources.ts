import { CiToolController } from './controller.ts';
import { CiWatcherSupervisor } from './supervisor.ts';

/** The workspace semaphore is shared by cockpit projects; headless callers have one too. */
const workspaces = new WeakMap<object, {
  refs: number;
  supervisor: CiWatcherSupervisor;
  controller?: Promise<CiToolController | undefined>;
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
    controller: () => shared.controller ??= CiToolController.start().catch(() => {
      console.warn('[cez] CI-wait tool unavailable; ordinary runs remain enabled.');
      return undefined;
    }),
    release() {
      if (released) return;
      released = true;
      if (--shared.refs !== 0) return;
      workspaces.delete(workspace);
      shared.supervisor.close();
      void shared.controller?.then(controller => controller?.close()).catch(() => {});
    },
  };
}
