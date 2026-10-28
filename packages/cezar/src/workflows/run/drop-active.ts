import type { RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';

/** Release session grants before timers and live registries are cleared. */
export function releaseActiveResources(store: RunStore, runId: string, state: ActiveRun | undefined): void {
  state?.pendingPermissions?.clear();
  if (store.getRun(runId)?.hasPendingPermission) store.updateRun(runId, { hasPendingPermission: false });
  state?.releaseRepoRoot?.();
  state?.revokeCiTools?.();
  if (state) state.releaseRepoRoot = undefined;
}
