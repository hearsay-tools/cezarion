import type { WorkerDestroyResult, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace, type RemovalReport } from './workspace-removal.ts';
import type { PreviewHostLike } from '../preview/registration.ts';

/** A destroyed owned worker's checkout: the same rule as `releaseThenRemoveWorktree` (`git-worktree-release.ts`),
 * through the delegation cleanup's own fenced removal. */
export async function releaseThenRemoveOwnedWorkspace(
  deps: { previewHost?: Pick<PreviewHostLike, 'release'> | undefined },
  repoRoot: string,
  workspace: WorkerWorkspace,
  assertCurrent?: () => void,
  assertUnheld?: () => void,
  report?: RemovalReport,
): Promise<WorkerDestroyResult> {
  return removeOwnedWorkspace(repoRoot, workspace, assertCurrent, async () => {
    await deps.previewHost?.release(workspace.ownerRunId).catch(() => undefined);
  }, assertUnheld, report);
}
