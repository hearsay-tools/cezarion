import { createWorktree, resolveBaseRef } from '../../git-worktree.ts';
import { getRepoInfo } from '../../server/git.ts';
import { ensureOwnedWorkspace, verifyOwnedWorkspace } from '../../delegation/workspace.ts';
import { placeWorkerAttachments, verifyWorkerContext } from '../../delegation/context.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { Execution, ExecutionLaunch, WorkerDelegationRecord } from './types.ts';

export const REPOSITORY_ROOT_LOCK_DISABLED_NOTE =
  'repository-root lock disabled by CEZ_DISABLE_REPO_LOCK=1 (shared checkout is unsafe)';

/** Verify an owned worker's Continue workspace without recreating it. The caller settles refusal. */
export async function ownedContinuationWorkspace(
  store: RunStore,
  repoRoot: string,
  dataDir: string,
  record: RunRecord,
  delegation: WorkerDelegationRecord,
): Promise<string> {
  if (delegation.destroy) throw new Error('Worker destruction has begun');
  const cwd = (await verifyOwnedWorkspace(repoRoot, record)).path;
  await verifyWorkerContext({ dataDir, parentId: delegation.parentRunId, workspace: delegation.workspace, context: delegation.context,
    parentCwd: store.getRun(delegation.parentRunId)?.worktreePath ?? repoRoot });
  return cwd;
}

/** An explicit worker attachment takes precedence over the project's personal config copy. */
export function executionSeedFiles(ownedRun: RunRecord | undefined): Set<string> {
  return new Set(ownedRun?.delegation?.role === 'worker'
    ? (ownedRun.delegation.context?.inputs ?? []).flatMap(input => input.source.kind === 'parent-file' ? [input.source.path] : [])
    : []);
}

/**
 * Fork from the configured base branch (config.json `baseBranch`, e.g.
 * `develop`) — also the target of the eventual draft PR. Unresolvable
 * (typo, not fetched) → note + the currently checked-out branch.
 *
 * A task that already recorded a fork point keeps it: its worktree is
 * reused as-is, and re-resolving against a since-changed config would
 * silently re-anchor the `merge-base` every diff/shortstat is measured
 * from, shifting "what did this task change" under an existing task.
 */
export async function executionBaseRef(
  store: RunStore,
  repoRoot: string,
  execution: Execution,
  repo: Awaited<ReturnType<typeof getRepoInfo>>,
  launch: ExecutionLaunch,
): Promise<string> {
  const { runId, emit } = execution;
  const recorded = launch.owned?.baselineSha ?? store.getRun(runId)?.baseBranch;
  let base = recorded ?? repo?.branch ?? 'HEAD';
  const configured = recorded ? undefined : launch.config.baseBranch;
  if (configured) {
    const resolved = await resolveBaseRef(repoRoot, configured);
    if (resolved) {
      base = resolved;
    } else {
      emit({
        type: 'note',
        message: `configured base branch "${configured}" not found (locally or on origin) — using "${base}"`,
      });
    }
  }
  return base;
}

/** The task's worktree: an owned worker's verified workspace, or a new worktree forked from `base`. */
export async function openExecutionWorktree(
  store: RunStore,
  repoRoot: string,
  dataDir: string,
  execution: Execution,
  launch: ExecutionLaunch,
  base: string,
): Promise<{ path: string; branch: string; baseBranch: string }> {
  const { runId, startAt } = execution;
  const { owned, ownedRun } = launch;
  const ownedWorkspace = owned && ownedRun ? await ensureOwnedWorkspace(repoRoot, ownedRun) : undefined;
  if (ownedRun?.delegation?.role === 'worker') await verifyWorkerContext({ dataDir, parentId: ownedRun.delegation.parentRunId, workspace: ownedRun.delegation.workspace, context: ownedRun.delegation.context,
    parentCwd: store.getRun(ownedRun.delegation.parentRunId)?.worktreePath ?? repoRoot });
  // First launch only (hearsay-tools/cezarion#1149): a worker re-queued past its first step and
  // runContinuation never re-place attachments the worker may have edited or deleted.
  if (ownedRun?.delegation?.role === 'worker' && startAt === 0) await placeWorkerAttachments({ dataDir, workspace: ownedRun.delegation.workspace, context: ownedRun.delegation.context });
  return ownedWorkspace
    ? { path: ownedWorkspace.path, branch: ownedWorkspace.branch, baseBranch: ownedWorkspace.baselineSha }
    : await createWorktree(repoRoot, runId, base);
}
