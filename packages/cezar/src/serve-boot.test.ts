import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKTREE_RETENTION } from './config.ts';
import { reconcileServeWorktrees } from './serve-boot.ts';
import type { RunStore } from './runs/store.ts';
import type { RunManager } from './workflows/run.ts';
import type { getRepoInfo } from './server/git.ts';

function reconcileFixture(unavailable = false) {
  const store = { unavailable, listRunIds: vi.fn(() => ['live-run']) } as unknown as RunStore;
  const manager = {} as RunManager;
  const repo = { root: '/repo' } as NonNullable<Awaited<ReturnType<typeof getRepoInfo>>>;
  const steps = {
    pruneOrphans: vi.fn().mockResolvedValue([]),
    resolveWorktreeRetention: vi.fn().mockResolvedValue(7),
    reclaimWorktrees: vi.fn().mockResolvedValue([]),
    sweepMergedBranches: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
  return { store, manager, repo, steps };
}

describe('reconcileServeWorktrees', () => {
  it.each(['no repo', 'unavailable store'])('skips reconciliation with %s', async (reason) => {
    const { store, manager, repo, steps } = reconcileFixture(reason === 'unavailable store');
    await reconcileServeWorktrees('/repo', reason === 'no repo' ? null : repo, store, manager, undefined, steps);
    expect(store.listRunIds).not.toHaveBeenCalled();
    expect(steps.pruneOrphans).not.toHaveBeenCalled();
    expect(steps.resolveWorktreeRetention).not.toHaveBeenCalled();
    expect(steps.reclaimWorktrees).not.toHaveBeenCalled();
    expect(steps.sweepMergedBranches).not.toHaveBeenCalled();
    expect(steps.log).not.toHaveBeenCalled();
  });

  it('keeps step order, output, live ids and the resolved sweep retention', async () => {
    const { store, manager, repo, steps } = reconcileFixture();
    steps.pruneOrphans.mockResolvedValue(['12345678-orphan', 'abcdefgh-orphan']);
    steps.reclaimWorktrees.mockResolvedValue(['87654321-old']);
    // A sweep can remain pending without delaying boot.
    steps.sweepMergedBranches.mockReturnValue(new Promise(() => {}));
    await reconcileServeWorktrees('/repo', repo, store, manager, undefined, steps);
    expect(steps.pruneOrphans).toHaveBeenCalledWith('/repo', new Set(['live-run']));
    expect(steps.reclaimWorktrees).toHaveBeenCalledWith('/repo', store, 7, { previewHost: undefined });
    expect(steps.sweepMergedBranches).toHaveBeenCalledWith({ root: '/repo', store, manager }, { keep: 7 });
    expect(steps.log.mock.calls).toEqual([
      ['  cleaned 2 orphaned worktree(s): 12345678, abcdefgh'],
      ['  reclaimed 1 old worktree(s), branch kept: 87654321'],
    ]);
    expect(steps.pruneOrphans).toHaveBeenCalledBefore(steps.resolveWorktreeRetention);
    expect(steps.resolveWorktreeRetention).toHaveBeenCalledBefore(steps.reclaimWorktrees);
    expect(steps.reclaimWorktrees).toHaveBeenCalledBefore(steps.sweepMergedBranches);
  });

  it.each(['pruneOrphans', 'resolveWorktreeRetention', 'reclaimWorktrees'] as const)(
    'keeps boot working when %s rejects', async (failedStep) => {
      const { store, manager, repo, steps } = reconcileFixture();
      steps[failedStep].mockRejectedValue(new Error('unavailable'));
      await reconcileServeWorktrees('/repo', repo, store, manager, undefined, steps);
      const keep = failedStep === 'resolveWorktreeRetention' ? DEFAULT_WORKTREE_RETENTION : 7;
      expect(steps.reclaimWorktrees).toHaveBeenCalledWith('/repo', store, keep, { previewHost: undefined });
      expect(steps.sweepMergedBranches).toHaveBeenCalledWith({ root: '/repo', store, manager }, { keep });
      expect(steps.log).not.toHaveBeenCalled();
    },
  );
});
