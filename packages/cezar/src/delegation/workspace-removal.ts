/** Checked removal of an owned worker workspace, on top of the record and Git layers. */
import { fallbackProjectWriteError } from '../project-paths.ts';
import { describeProcesses, inspectGeneration } from './process-liveness.ts';
import { entryExists as exists } from './entry-exists.ts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerDestroyResult, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { withWorktreeMutation, WorktreeMutationLockTimeout } from '../git-worktree-lock.ts';
import { branchLog, checkedGit, gitCommonDir, liveGitDir, worktreeEntries } from './workspace-git.ts';
import { cleanupSchema, hash, readIdentityFile, readReceipt, RECEIPT_CAP, receiptLocation, replaceIdentityFile, validateIntent, type Cleanup, type Receipt } from './workspace-record.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function verifyBranch(repoRoot: string, workspace: WorkerWorkspace, receipt: Receipt) {
  if (!receipt.branchIdentity) throw new Error('Branch creation identity absent');
  const log = await branchLog(repoRoot, workspace);
  const initial = receipt.branchIdentity;
  if (log.content.length < initial.prefixBytes ||
      hash(log.content.subarray(0, initial.prefixBytes)) !== initial.prefixHash) throw new Error('Branch ownership changed');
  return { sha: await checkedGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${workspace.branch}`]), log };
}
async function writeCleanup(path: string, value: Cleanup, assertCurrent?: () => void): Promise<void> {
  return replaceIdentityFile(path, JSON.stringify(value), assertCurrent);
}

/** Whether any linked worktree's admin directory still carries this resource's identity marker.
 * An unsafe or unreadable marker throws, so the caller fails closed. */
async function markerRemains(repoRoot: string, workspace: WorkerWorkspace): Promise<boolean> {
  const admin = join(await gitCommonDir(repoRoot), 'worktrees');
  if (!await exists(admin)) return false;
  for (const entry of await readdir(admin)) {
    const marker = join(admin, entry, 'cezar-owned-resource');
    if (await exists(marker) && await readIdentityFile(marker, 36, false) === workspace.resourceId) return true;
  }
  return false;
}

/** Whether `value` is still the worktree its receipt and identity marker name, at its own real path:
 * only then may destroy stop what runs there. Any doubt answers false. */
export async function ownedWorktreePresent(repoRoot: string, value: WorkerWorkspace): Promise<boolean> {
  try {
    const workspace = await validateIntent(repoRoot, value);
    const receipt = await readReceipt(await receiptLocation(repoRoot, workspace));
    return !!receipt && same(receipt.workspace, workspace) && await liveGitDir(repoRoot, workspace) === receipt.gitDir &&
      await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36, false) === workspace.resourceId;
  } catch { return false; }
}

/** A removal that could not take the worktree mutation lock in time. Contention clears without
 * changing anything a destroy can observe, so a retry must not skip it (hearsay-tools/cezarion#879). */
export const WORKTREE_LOCK_BUSY_ERROR = 'Owned resources retained: worktree mutation lock is busy; retry destroy later';

/** Thrown by a removal's `assertUnheld` when live processes may hold the worker's resources. */
export class WorkspaceHeldError extends Error {
  constructor(readonly pids: readonly number[]) { super(`Processes ${pids.join(', ')} may still hold the worker's resources`); }
}

/**
 * Checked cleanup after persisted destroy intent and termination proof. Keep the private
 * checkpoint beyond Git-directory removal; compare exact ref/reflog identity before retrying
 * deletion.
 */
export type RemovalReport = { held?: (pids: readonly number[]) => void; unexplained?: () => void };
export async function removeOwnedWorkspace(repoRoot: string, value: WorkerWorkspace, assertCurrent?: () => void,
  beforeRemove?: () => Promise<void>, assertUnheld?: () => void, report?: RemovalReport): Promise<WorkerDestroyResult> {
  const refusal = fallbackProjectWriteError(value.path);
  if (refusal) return { workerId: value.ownerRunId, state: 'incomplete', remaining: ['worktree', 'branch'], error: refusal };
  let remaining: Array<'worktree' | 'branch'> = ['worktree', 'branch'];
  let provisioned = false; let lockBusy = false; let heldBy: readonly number[] = [];
  const held = (pids: readonly number[]) => { heldBy = pids; report?.held?.(pids); };
  let stranded: string | undefined;
  const result = (): WorkerDestroyResult => ({ workerId: value.ownerRunId, state: remaining.length ? 'incomplete' : 'complete', remaining,
    ...(remaining.length ? { error: lockBusy ? WORKTREE_LOCK_BUSY_ERROR
      : heldBy.length ? `Owned resources retained: processes ${describeProcesses(heldBy)} may still hold the worker worktree or scratch; retry destroy after they exit`
      : stranded ? `Owned branch ${value.branch} ${stranded}; keep what you need, delete the branch, then retry destroy`
      : 'Owned resources remain: resource identity or Git cleanup could not be verified. Check the worker worktree, Git lock and ownership receipt, then retry destroy after correcting the blocker' } : {}),
    ...(provisioned ? { deleted: [
      ...(!remaining.includes('worktree') ? [{ kind: 'worktree' as const, path: value.path }] : []),
      ...(!remaining.includes('branch') ? [{ kind: 'branch' as const, ref: `refs/heads/${value.branch}` }] : []),
    ] } : {}),
  });
  try {
    return await withWorktreeMutation(repoRoot, async mutationGit => {
      assertCurrent?.();
      const workspace = await validateIntent(repoRoot, value);
      const path = await receiptLocation(repoRoot, workspace);
      const receipt = await readReceipt(path);
      const registered = async () => worktreeEntries(await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']));
      const branchExists = async () => {
        const refs = await checkedGit(repoRoot, ['for-each-ref', '--format=%(refname)', `refs/heads/${workspace.branch}`]);
        return refs.split('\n').includes(`refs/heads/${workspace.branch}`);
      };
      if (!receipt) {
        await completeWithoutReceipt();
        return result();
      }
      if (!same(receipt.workspace, workspace)) return result();
      provisioned = true;
      const checkpointPath = path.replace(/\.json$/, '.cleanup.json');
      let checkpoint = await exists(checkpointPath) ? cleanupSchema.parse(JSON.parse(await readIdentityFile(checkpointPath, RECEIPT_CAP))) : undefined;
      if (checkpoint && (!same(checkpoint.workspace, workspace) || checkpoint.gitDir !== receipt.gitDir)) return result();
      if (checkpoint?.phase === 'complete') {
        await inspectCompletedCleanup(receipt);
        return result();
      }
      if (await exists(workspace.path) && !await removePresentWorktree(receipt)) return result();
      if (!checkpoint) {
        checkpoint = await prepareMissingWorktree(receipt);
        if (!checkpoint) return result();
      }
      await removeBranch(receipt, checkpoint);
      return result();

      // Each phase shares this attempt's partial result while the mutation fence stays held.
      async function completeWithoutReceipt(): Promise<void> {
        // #878: without a receipt, the identity marker in a Git admin directory is the
        // only trace of a moved worktree. With path, registration, branch and marker all
        // gone, finish bookkeeping; write no checkpoint and delete nothing.
        const absent = async () => !await exists(workspace.path) && !(await registered()).includes(`worktree ${workspace.path}`) &&
          !await branchExists() && !await markerRemains(repoRoot, workspace);
        if (await absent()) {
          assertCurrent?.();
          await beforeRemove?.();
          assertCurrent?.();
          if (await absent()) remaining = [];
        }
        // Markers in any linked admin directory decide this, and a retrying caller's observation
        // does not read them all: a refusal here is unexplained (hearsay-tools/cezarion#879).
        if (remaining.length) report?.unexplained?.();
      }

      async function inspectCompletedCleanup(receipt: Receipt): Promise<void> {
        remaining = [];
        if (await exists(workspace.path) || (await registered()).includes(`worktree ${workspace.path}`) || await exists(receipt.gitDir)) remaining.push('worktree');
        if (await branchExists()) remaining.push('branch');
      }

      async function preparePresentWorktree(receipt: Receipt): Promise<Cleanup | undefined> {
        if (checkpoint?.phase === 'worktree-removed') return undefined;
        if (await liveGitDir(repoRoot, workspace) !== receipt.gitDir ||
            await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36, false) !== workspace.resourceId) return undefined;
        // HEAD files (this worktree's, another's) are not in a retrying caller's observation: these
        // refusals report unexplained, so a retry never skips them (hearsay-tools/cezarion#879).
        if (await checkedGit(workspace.path, ['symbolic-ref', '-q', 'HEAD']) !== `refs/heads/${workspace.branch}`) { report?.unexplained?.(); return undefined; }
        // Git permits duplicate checkouts with --force. Preserve both resources
        // before the first removal if another registered path uses this branch.
        let registeredPath: string | undefined;
        for (const entry of await registered()) {
          if (entry.startsWith('worktree ')) registeredPath = entry.slice('worktree '.length);
          if (entry === `branch refs/heads/${workspace.branch}` && registeredPath !== workspace.path) { report?.unexplained?.(); return undefined; }
        }
        const current = await verifyBranch(repoRoot, workspace, receipt);
        if (checkpoint && (checkpoint.sha !== current.sha || checkpoint.logHash !== hash(current.log.content))) return undefined;
        checkpoint ??= { workspace, gitDir: receipt.gitDir, sha: current.sha, logFile: current.log.file, logHash: hash(current.log.content), phase: 'prepared' };
        return checkpoint;
      }

      async function removePresentWorktree(receipt: Receipt): Promise<boolean> {
        const prepared = await preparePresentWorktree(receipt);
        if (!prepared) return false;
        await writeCleanup(checkpointPath, prepared, assertCurrent);
        assertCurrent?.();
        await beforeRemove?.();
        assertCurrent?.();
        // Preview release may itself end a known owned holder. Check unrelated holders only
        // afterwards, immediately before destructive Git; they are never signalled.
        assertUnheld?.();
        const holders = inspectGeneration({ paths: [workspace.path] });
        if (holders.liveness !== 'gone') { if (holders.pids.length) held(holders.pids); else report?.unexplained?.(); return false; }
        if (!(await mutationGit(repoRoot, ['worktree', 'remove', '--force', workspace.path])).ok) { report?.unexplained?.(); return false; }
        remaining = ['branch'];
        return true;
      }

      async function prepareMissingWorktree(receipt: Receipt): Promise<Cleanup | undefined> {
        const worktreeGone = async () => !await exists(workspace.path) && !await exists(receipt.gitDir) &&
          !(await registered()).includes(`worktree ${workspace.path}`);
        if (!await worktreeGone()) return undefined;
        if (!await branchExists()) {
          // Recorded identity already gone: finish bookkeeping. Do not delete a leftover path/gitDir/branch.
          assertCurrent?.();
          await beforeRemove?.();
          assertCurrent?.();
          if (await worktreeGone() && !await branchExists()) remaining = [];
          return undefined;
        }
        // hearsay-tools/cezarion#905: the worktree went away outside Squawk and left its branch behind.
        // While the branch matches the receipt, is checked out nowhere, and it and every reflog entry
        // sit at the baseline, it holds no work: delete it through the checkpointed compare-and-swap
        // below. A branch reset back to its baseline keeps the worker's commits only in the reflog
        // that the delete would drop. Commits on it are a human's call.
        remaining = ['branch'];
        if ((await registered()).includes(`branch refs/heads/${workspace.branch}`)) { report?.unexplained?.(); return undefined; }
        const current = await verifyBranch(repoRoot, workspace, receipt);
        if (current.sha !== workspace.baselineSha) {
          const commits = Number(await checkedGit(repoRoot, ['rev-list', '--count', `${workspace.baselineSha}..${current.sha}`]));
          stranded = commits ? `holds ${commits} commit${commits === 1 ? '' : 's'} beyond its worker baseline` : 'no longer points at its worker baseline';
          return undefined;
        }
        const tips = current.log.content.toString('utf8').split('\n').filter(Boolean).map(entry => entry.split(' ')[1]);
        if (tips.some(tip => tip !== workspace.baselineSha)) {
          stranded = 'returned to its worker baseline after holding other commits';
          return undefined;
        }
        assertCurrent?.();
        await beforeRemove?.();
        assertCurrent?.();
        return { workspace, gitDir: receipt.gitDir, sha: current.sha, logFile: current.log.file, logHash: hash(current.log.content), phase: 'prepared' };
      }

      async function removeBranch(receipt: Receipt, checkpoint: Cleanup): Promise<void> {
        if (await exists(workspace.path) || await exists(receipt.gitDir) || (await registered()).includes(`worktree ${workspace.path}`)) return;
        remaining = ['branch'];
        checkpoint = { ...checkpoint, phase: 'worktree-removed' };
        await writeCleanup(checkpointPath, checkpoint, assertCurrent);
        if (await branchExists()) {
          if ((await registered()).includes(`branch refs/heads/${workspace.branch}`)) { report?.unexplained?.(); return; }
          const current = await verifyBranch(repoRoot, workspace, receipt);
          if (current.sha !== checkpoint.sha || hash(current.log.content) !== checkpoint.logHash) return;
          // Ref CAS: never delete a branch advanced after our verified snapshot.
          assertCurrent?.();
          assertUnheld?.();
          const removed = await mutationGit(repoRoot, ['update-ref', '-d', `refs/heads/${workspace.branch}`, checkpoint.sha]);
          if (!removed.ok || await branchExists()) { report?.unexplained?.(); return; }
        }
        await writeCleanup(checkpointPath, { ...checkpoint, phase: 'complete' }, assertCurrent);
        remaining = [];
      }
    }, { waitMs: 1_000 });
  } catch (error) {
    // Ambiguous ownership and every failed Git/filesystem operation fail closed.
    lockBusy = error instanceof WorktreeMutationLockTimeout;
    if (error instanceof WorkspaceHeldError && error.pids.length) held(error.pids);
    else report?.unexplained?.();
  }
  return result();
}
