import { isReclaimable } from '../../runs/retention.ts';
import type { RunModuleContext } from './types.ts';

interface MaintenanceClaimsHost {
  isActive(runId: string): boolean;
  autosaveCleanupBlocker(runId: string): unknown;
  hasExecution(runId: string): boolean;
  scheduleScratchCleanup(runId: string): void;
  holdForMaintenance(runIds: readonly string[]): (() => void) | null;
}

export class MaintenanceClaims {
  readonly reclaiming = new Set<string>();
  constructor(private readonly context: RunModuleContext, private readonly host: MaintenanceClaimsHost) {}
  has(runId: string): boolean { return this.reclaiming.has(runId); }

  /** Hold off every admission path until destructive work (including async Git) completes. */
  claimWorkerCleanup(runId: string): (() => void) | undefined {
    if (this.context.disposed() || this.has(runId) || !!this.host.autosaveCleanupBlocker(runId) || this.host.isActive(runId) || this.host.hasExecution(runId)) return undefined;
    this.reclaiming.add(runId);
    return () => { this.reclaiming.delete(runId); this.host.scheduleScratchCleanup(runId); };
  }

  /**
   * Claim a run's worktree for a reclaim (#483, issue 08 §B4), or null when it is in use or no
   * longer reclaimable. The check and the claim are one synchronous step, and `continueRun`
   * refuses a claimed run until the release, so a Continue can never resume into a directory a
   * forced removal is deleting — nor a removal start under a session that was just admitted.
   */
  claimWorktreeReclaim(runId: string): (() => void) | null {
    if (this.has(runId) || !!this.host.autosaveCleanupBlocker(runId) || this.host.isActive(runId) || this.context.store.writeRefusal(runId)) return null;
    const run = this.context.store.getRun(runId);
    if (!run || !isReclaimable(run, (id) => this.context.store.getRun(id))) return null;
    return this.host.holdForMaintenance([runId]);
  }

  /**
   * Hold `runIds` against Continue, reclaim, publish and branch cleanup here AND in every other
   * cezar process for the length of an async operation (#779, plan step 3; PR #851 review). An
   * ownership check alone is a moment: pinning claims each run's family, so another process
   * cannot claim and Continue it while this one rematerializes, publishes or deletes. Null when
   * any hold fails (another process took the claim first); nothing stays held then.
   */
  holdForMaintenance(runIds: readonly string[]): (() => void) | null {
    // Only pin and reclaim together: a failed hold leaves nothing held.
    const pinned: string[] = [];
    for (const id of runIds) {
      if (!this.context.store.pin(id, 'maintenance')) {
        for (const done of pinned) this.context.store.unpin(done, 'maintenance');
        return null;
      }
      pinned.push(id);
    }
    for (const id of runIds) this.reclaiming.add(id);
    return () => {
      for (const id of runIds) { this.reclaiming.delete(id); this.context.store.unpin(id, 'maintenance'); }
    };
  }

  /**
   * Claim a settled run while its draft PR is published (`POST /runs/:id/pr`), or null when it is
   * live or already claimed. Publishing may first re-materialize a reclaimed checkout, which
   * clears the reclaim stamp and makes the run reclaimable again; held, the claim keeps reclaim,
   * branch cleanup and Continue off the checkout until the push and `gh` are done with it.
   */
  claimForPublish(runId: string): (() => void) | null {
    if (this.has(runId) || !!this.host.autosaveCleanupBlocker(runId) || this.host.isActive(runId) || this.context.store.writeRefusal(runId)) return null;
    return this.host.holdForMaintenance([runId]);
  }

  /**
   * Claim every run that owns a branch about to be deleted (issue 08 §B3), or null when any is in
   * use: live, queued, at the review gate, or already claimed. The classification that allowed the
   * delete read liveness before awaiting git and GitHub; this re-reads it and holds Continue off —
   * its re-materialization would otherwise recreate the branch from the base under the delete.
   */
  claimForBranchCleanup(runIds: readonly string[]): (() => void) | null {
    const unfinished = (id: string) => !['done', 'failed', 'cancelled'].includes(this.context.store.getRun(id)?.status ?? 'done');
    if (runIds.some((id) => this.has(id) || !!this.host.autosaveCleanupBlocker(id) || this.host.isActive(id) || unfinished(id) || this.context.store.writeRefusal(id))) return null;
    return this.host.holdForMaintenance(runIds);
  }

}
