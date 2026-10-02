import { removeWorktree } from './git-worktree.ts';
import type { PreviewHostLike } from './preview/registration.ts';

/**
 * The one way a run's worktree is removed (#781, spec 2026-10-02-live-preview-v1 "Exit
 * triggers"): the task's preview is released first, so a dev server never keeps running from a
 * directory that is gone and the open pane is told why. `git-worktree-release.test.ts` scans the
 * sources so no site calls `removeWorktree` directly. A failed release never blocks the removal.
 */
export async function releaseThenRemoveWorktree(
  deps: { previewHost?: Pick<PreviewHostLike, 'release'> },
  runId: string,
  ...args: Parameters<typeof removeWorktree>
): Promise<void> {
  await deps.previewHost?.release(runId).catch(() => undefined);
  await removeWorktree(...args);
}
