import type { RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';

/** Release session grants before timers and live registries are cleared. */
export function releaseActiveResources(store: RunStore, runId: string, state: ActiveRun | undefined): void {
  state?.liveSession.clearPermissions();
  if (store.getRun(runId)?.hasPendingPermission) store.updateRun(runId, { hasPendingPermission: false });
  state?.liveSession.releaseRepoRoot?.();
  state?.liveSession.revokeCiTools?.();
  if (state) state.liveSession.clearRepoRootRelease();
}
