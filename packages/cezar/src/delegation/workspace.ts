/** Create and check owned worker workspaces, on top of the record and Git layers. Removal lives in `workspace-removal.ts`. */
import { fallbackProjectWriteError } from '../project-paths.ts';
import { entryExists as exists } from './entry-exists.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyGitIndex } from '../git-index-copy.ts';
import { delegationStateSchema, workerWorkspaceSchema } from '@open-mercato/cezar-contract/delegation';
import type { WorkerDiff, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { branchFor, createWorktree, DIFF_CAP, worktreePathFor } from '../git-worktree.ts';
import { resolveTaskDiffBase } from '../git-diff-base.ts';
import { isSafeGitRef } from '../git-refs.ts';
import type { RunRecord } from '../runs/store.ts';
import { DelegationPolicyError } from './policy.ts';
import { branchLog, checkedGit, git, gitCommonDir, liveGitDir } from './workspace-git.ts';
import { hash, readIdentityFile, readReceipt, receiptLocation, validateIntent, writeIdentityFile } from './workspace-record.ts';

/** Reads only committed state in the server-known parent cwd; never flushes its edits. */
export async function resolveWorkerBaseline(repoRoot: string, parentCwd: string, baseline: string): Promise<string> {
  try {
    if (!isSafeGitRef(baseline) || baseline.length > 1024 || /[\0\r\n]/.test(baseline)) throw new Error('Invalid ref');
    if (await gitCommonDir(repoRoot) !== await gitCommonDir(parentCwd)) throw new Error('Parent is not in this repository');
    const ref = baseline === 'parent-head' ? 'HEAD' : baseline;
    return workerWorkspaceSchema.shape.baselineSha.parse(await checkedGit(
      baseline === 'parent-head' ? parentCwd : repoRoot,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    ));
  } catch {
    throw new DelegationPolicyError('invalid_baseline', 'Worker baseline must resolve to a commit in the parent repository');
  }
}

/** No resource side effects. Persist this exact reference/receipt before enqueueing. */
export async function planOwnedWorkspace(repoRoot: string, workerId: string, baselineSha: string): Promise<WorkerWorkspace> {
  const root = await realpath(repoRoot);
  const workspace = workerWorkspaceSchema.parse({
    ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
    path: worktreePathFor(root, workerId), branch: branchFor(workerId), baselineSha,
  });
  await validateIntent(root, workspace);
  return workspace;
}

function workerWorkspace(run: RunRecord): WorkerWorkspace {
  const delegation = delegationStateSchema.parse(run.delegation);
  if (delegation.role !== 'worker' || delegation.workspace.ownerRunId !== run.id) throw new Error('Missing worker ownership');
  return delegation.workspace;
}

/** Fresh-only primitive. Runtime callers supply the already-durable preallocated intent. */
export async function createOwnedWorkspace(repoRoot: string, workerId: string, baselineSha: string, intent?: WorkerWorkspace): Promise<WorkerWorkspace> {
  const workspace = await validateIntent(repoRoot, intent ?? await planOwnedWorkspace(repoRoot, workerId, baselineSha));
  const refusal = fallbackProjectWriteError(workspace.path);
  if (refusal) throw new Error(refusal);
  if (workspace.ownerRunId !== workerId || workspace.baselineSha !== baselineSha) throw new Error('Owned workspace intent mismatch');
  const receiptPath = await receiptLocation(repoRoot, workspace, true);
  if (await exists(receiptPath)) throw new Error('Owned workspace receipt already exists');
  await createWorktree(repoRoot, workerId, baselineSha, { freshOnly: true });
  // A crash/failure before this exclusive receipt leaves ambiguous resources intact.
  // Recovery must fail closed rather than claim them from the intended path alone.
  const log = await branchLog(repoRoot, workspace);
  const prefix = log.content.subarray(0, Math.min(4096, log.content.length));
  const receipt = { workspace, gitDir: await liveGitDir(repoRoot, workspace),
    branchIdentity: { file: log.file, prefixBytes: prefix.length, prefixHash: hash(prefix) } };
  // Git may reuse the same administrative path after remove/add. The marker dies
  // with that directory, preventing a stale common receipt from claiming its replacement.
  await writeIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), workspace.resourceId, false);
  const checkedPath = await receiptLocation(repoRoot, workspace);
  await writeIdentityFile(checkedPath, JSON.stringify(receipt));
  return workspace;
}

/** Resource identity only, not caller authorization or permission to delete a repurposed branch. */
export async function verifyOwnedWorkspace(repoRoot: string, run: RunRecord): Promise<WorkerWorkspace> {
  const workspace = await validateIntent(repoRoot, workerWorkspace(run));
  const receipt = await readReceipt(await receiptLocation(repoRoot, workspace));
  if (!receipt || JSON.stringify(receipt.workspace) !== JSON.stringify(workspace)) throw new Error('Owned workspace provisioning receipt missing or mismatched');
  if (await liveGitDir(repoRoot, workspace) !== receipt.gitDir ||
      await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36, false) !== workspace.resourceId) {
    throw new Error('Owned workspace Git identity changed');
  }
  return workspace;
}

/** Reuse only proven resources. No reattachment/replacement after resource loss or ambiguous provisioning. */
export async function ensureOwnedWorkspace(repoRoot: string, run: RunRecord): Promise<WorkerWorkspace> {
  const workspace = await validateIntent(repoRoot, workerWorkspace(run));
  const refusal = fallbackProjectWriteError(workspace.path);
  if (refusal) throw new Error(refusal);
  if (run.delegation?.role === 'worker' && run.delegation.destroy) throw new Error('Worker destruction has begun');
  const path = await receiptLocation(repoRoot, workspace);
  if (await exists(path)) return verifyOwnedWorkspace(repoRoot, run);
  return createOwnedWorkspace(repoRoot, run.id, workspace.baselineSha, workspace);
}

export async function readOwnedDiff(repoRoot: string, run: RunRecord): Promise<WorkerDiff> {
  let scratch: string | undefined;
  try {
    const workspace = await verifyOwnedWorkspace(repoRoot, run);
    scratch = await mkdtemp(join(tmpdir(), 'cez-owned-diff-'));
    const index = join(scratch, 'index');
    // Preserve staged membership (including force-added ignored files) without
    // letting diff preparation mutate the worker's own linked-worktree index.
    const workerIndex = await checkedGit(workspace.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    await copyGitIndex(workerIndex, index);
    await checkedGit(workspace.path, ['add', '-N', '.'], index);
    const { base } = await resolveTaskDiffBase(
      (args) => git(workspace.path, args, index), workspace.baselineSha,
      { taskBranch: workspace.branch, runStartedAt: run.startedAt },
    );
    // The cap is characters on the wire; allow four UTF-8 bytes per character.
    const result = await git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', base, '--'], index, DIFF_CAP * 4 + 4);
    if (!result.ok && !(result.overflow && result.stdout.length > DIFF_CAP)) throw new Error('Worker diff failed');
    return { workerId: run.id, baselineSha: workspace.baselineSha, diff: result.stdout.slice(0, DIFF_CAP), truncated: result.stdout.length > DIFF_CAP };
  } catch {
    throw new DelegationPolicyError('unavailable_diff', 'Owned worker diff unavailable: resource missing, unverified or unreadable');
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}
