import type { ActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';

interface RepoRootLeaseHost {
  park(runId: string): void;
  unpark(runId: string): void;
  releaseSlot(): void;
}

export class RepoRootLease {
  /**
   * Runs normally isolate in worktrees and may execute in parallel. When that
   * isolation is unavailable (or explicitly disabled), access to `repoRoot` is
   * serialized by default so two agents cannot edit/revert the same files
   * (#438). `CEZ_DISABLE_REPO_LOCK=1` deliberately bypasses this safety lease.
   */
  private repoRootTail: Promise<void> = Promise.resolve();

  constructor(private readonly context: RunModuleContext, private readonly host: RepoRootLeaseHost) {}

  /**
   * Acquire the exclusive repository-root lease. A waiter releases scheduling capacity but stays
   * running in the store. Hold the lease across idle turns; false means cancellation before
   * acquisition and forbids tree access.
   */
  async acquireRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    // `cancel()` can land between the run going `running` and reaching here,
    // while `interrupt` is still the default no-op — never enter the chain.
    if (state.cancelled) return false;
    const previous = this.repoRootTail;
    let release: () => void = () => undefined;
    this.repoRootTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Until `previous` resolves this run does not own the tree yet, so a drop
    // during the wait must not hand the tree to the next waiter — chain our
    // release behind `previous` instead of resolving the tail early.
    state.releaseRepoRoot = () => {
      void previous.then(release);
    };
    let abort: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      abort = resolve;
    });
    const parked = state.interrupt;
    state.interrupt = () => {
      parked();
      abort();
    };
    this.host.park(runId);
    this.host.releaseSlot();
    try {
      await Promise.race([previous, cancelled]);
    } finally {
      state.interrupt = parked;
      this.host.unpark(runId);
    }
    if (state.cancelled) return false;
    state.releaseRepoRoot = release;
    return true;
  }
}

/**
 * Explicitly opt out of the repository-root lease for runs that execute in the
 * current checkout. This covers explicit worktree opt-out, non-Git degradation,
 * and continuations whose worktree cannot be restored (spec 006 hardening, #438).
 * This is intentionally unsafe: concurrent agents may overwrite each other's
 * files or Git state. Isolated worktree runs are unaffected.
 */
export function repositoryRootLockDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_DISABLE_REPO_LOCK === '1';
}
