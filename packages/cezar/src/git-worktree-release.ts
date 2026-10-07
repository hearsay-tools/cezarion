import type { WorkerDestroyResult, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace, type WorkerNoMaterializationProof } from './delegation/workspace.ts';
import { removeWorktree, type RemoveWorktreeOptions } from './git-worktree.ts';
import type { PreviewHostLike } from './preview/registration.ts';

/**
 * The one way a run's worktree is removed (#781, spec 2026-10-02-live-preview-v1 "Exit
 * triggers"): the task's preview is released once the removal is going ahead and before git
 * removes the checkout, so a dev server never keeps running from a directory that is gone and the
 * open pane is told why. A removal that declines (a dirty tree under `onlyClean`, an owned or
 * protected path) releases nothing. `git-worktree-release.test.ts` scans the sources so no site
 * calls `removeWorktree` or `removeOwnedWorkspace` directly, and git's `worktree remove` runs only
 * inside those two. A failed release never blocks the removal.
 */
export async function releaseThenRemoveWorktree(
  deps: { previewHost?: Pick<PreviewHostLike, 'release'> },
  runId: string,
  repoRoot: string,
  worktreePath: string,
  branch?: string,
  opts?: RemoveWorktreeOptions,
): Promise<void> {
  await removeWorktree(repoRoot, worktreePath, branch, {
    ...opts,
    beforeRemove: async () => {
      await deps.previewHost?.release(runId).catch(() => undefined);
      await opts?.beforeRemove?.();
    },
  });
}

/** A destroyed owned worker's checkout: the same rule, through the delegation cleanup's own fenced removal. */
export async function releaseThenRemoveOwnedWorkspace(
  deps: { previewHost?: Pick<PreviewHostLike, 'release'> },
  repoRoot: string,
  workspace: WorkerWorkspace,
  neverMaterialized?: WorkerNoMaterializationProof,
  assertCurrent?: () => void,
  assertUnheld?: () => void,
): Promise<WorkerDestroyResult> {
  return removeOwnedWorkspace(repoRoot, workspace, neverMaterialized, assertCurrent, async () => {
    await deps.previewHost?.release(workspace.ownerRunId).catch(() => undefined);
  }, assertUnheld);
}
