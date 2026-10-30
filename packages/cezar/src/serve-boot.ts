import { pruneOrphans } from './git-worktree.ts';
import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from './config.ts';
import { reclaimWorktrees } from './runs/retention.ts';
import { sweepMergedBranches } from './server/repo-branch-sweep.ts';
import type { RunStore } from './runs/store.ts';
import type { RunManager } from './workflows/run.ts';
import type { PreviewHost } from './preview/host.ts';
import type { getRepoInfo } from './server/git.ts';

const reconcileDefaults = { pruneOrphans, resolveWorktreeRetention, reclaimWorktrees, sweepMergedBranches, log: console.log };

export async function reconcileServeWorktrees(
  repoRoot: string,
  repo: Awaited<ReturnType<typeof getRepoInfo>>,
  store: RunStore,
  manager: RunManager,
  previewHost?: PreviewHost,
  steps = reconcileDefaults,
): Promise<void> {
  // Startup reconcile (spec 006): sweep worktrees whose run no longer exists. Never over a store
  // that could not open (#779): its runs are unknown, and every worktree would look orphaned.
  if (repo && !store.unavailable) {
    const orphans = await steps.pruneOrphans(repoRoot, new Set(store.listRunIds())).catch(
      () => [] as string[],
    );
    if (orphans.length > 0) {
      steps.log(`  cleaned ${orphans.length} orphaned worktree(s): ${orphans.map((id) => id.slice(0, 8)).join(', ')}`);
    }
    // Count-based worktree retention (#483): reclaim finished worktrees beyond
    // the keep-limit (directory only — `cez/<id8>` branch kept, so recoverable).
    // Best-effort; never blocks boot.
    const keep = await steps.resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
    const reclaimed = await steps.reclaimWorktrees(repoRoot, store, keep, { previewHost }).catch(() => [] as string[]);
    if (reclaimed.length > 0) {
      steps.log(`  reclaimed ${reclaimed.length} old worktree(s), branch kept: ${reclaimed.map((id) => id.slice(0, 8)).join(', ')}`);
    }
    // Branches whose work landed (hearsay-tools/cezarion#2268). In the background: it may ask
    // GitHub, and boot never waits on the network.
    void steps.sweepMergedBranches({ root: repoRoot, store, manager }, { keep });
  }

}
