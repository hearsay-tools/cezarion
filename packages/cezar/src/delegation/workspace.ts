import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { delegationStateSchema, workerWorkspaceSchema } from '@open-mercato/cezar-contract';
import type { WorkerDestroyResult, WorkerDiff, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { branchFor, createWorktree, DIFF_CAP, worktreePathFor } from '../git-worktree.ts';
import { resolveTaskDiffBase } from '../git-diff-base.ts';
import { isSafeGitRef } from '../git-refs.ts';
import type { RunRecord } from '../runs/store.ts';
import { DelegationPolicyError } from './policy.ts';

const RECEIPT_CAP = 16_384;
const fileIdentitySchema = z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict();
const branchIdentitySchema = z.object({ file: fileIdentitySchema, prefixBytes: z.number().int().min(1).max(4096), prefixHash: z.string().length(64) }).strict();
const receiptSchema = z.object({ workspace: workerWorkspaceSchema, gitDir: z.string().min(1), branchIdentity: branchIdentitySchema.optional() }).strict();
const cleanupSchema = z.object({ workspace: workerWorkspaceSchema, gitDir: z.string(), sha: workerWorkspaceSchema.shape.baselineSha,
  logFile: fileIdentitySchema, logHash: z.string().length(64), phase: z.enum(['prepared', 'worktree-removed', 'complete']) }).strict();
type Cleanup = z.infer<typeof cleanupSchema>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

async function branchLog(repoRoot: string, workspace: WorkerWorkspace) {
  const common = await commonDir(repoRoot);
  const path = join(common, 'logs/refs/heads', workspace.branch);
  if (await realpath(path) !== path) throw new Error('Branch reflog redirected');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Branch reflog unavailable');
    const content = await file.readFile();
    if (content.length !== info.size) throw new Error('Branch reflog changed while reading');
    return { file: { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }, content };
  } finally { await file.close(); }
}
async function verifyBranch(repoRoot: string, workspace: WorkerWorkspace, receipt: Receipt) {
  if (!receipt.branchIdentity) throw new Error('Branch creation identity absent');
  const log = await branchLog(repoRoot, workspace);
  const initial = receipt.branchIdentity;
  if (!same(log.file, initial.file) || log.content.length < initial.prefixBytes ||
      hash(log.content.subarray(0, initial.prefixBytes)) !== initial.prefixHash) throw new Error('Branch ownership changed');
  return { sha: await checkedGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${workspace.branch}`]), log };
}
async function writeCleanup(path: string, value: Cleanup): Promise<void> {
  if (await exists(path)) await readIdentityFile(path, RECEIPT_CAP);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeIdentityFile(temporary, JSON.stringify(value));
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

type Receipt = z.infer<typeof receiptSchema>;

function git(cwd: string, args: string[], index?: string, maxBuffer = 32 * 1024 * 1024) {
  return new Promise<{ ok: boolean; stdout: string; overflow: boolean }>((done) => {
    execFile('git', args, {
      cwd, encoding: 'utf8', timeout: 30_000, maxBuffer,
      ...(index ? { env: { ...process.env, GIT_INDEX_FILE: index } } : {}),
    }, (error, stdout) => done({
      ok: !error, stdout: stdout ?? '', overflow: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    }));
  });
}
async function checkedGit(cwd: string, args: string[], index?: string): Promise<string> {
  const result = await git(cwd, args, index);
  if (!result.ok) throw new Error(`Owned workspace Git ${args[0]} failed`);
  return result.stdout.trim();
}
async function commonDir(cwd: string): Promise<string> {
  return realpath(await checkedGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** Reads only committed state in the server-known parent cwd; never flushes its edits. */
export async function resolveWorkerBaseline(repoRoot: string, parentCwd: string, baseline: string): Promise<string> {
  try {
    if (!isSafeGitRef(baseline) || baseline.length > 1024 || /[\0\r\n]/.test(baseline)) throw new Error('Invalid ref');
    if (await commonDir(repoRoot) !== await commonDir(parentCwd)) throw new Error('Parent is not in this repository');
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

async function validateIntent(repoRoot: string, value: WorkerWorkspace): Promise<WorkerWorkspace> {
  const workspace = workerWorkspaceSchema.parse(value);
  const root = await realpath(repoRoot);
  if (workspace.path !== worktreePathFor(root, workspace.ownerRunId) || workspace.branch !== branchFor(workspace.ownerRunId)) {
    throw new Error('Owned workspace identity does not match the managed resource');
  }
  // Do not let a symlinked managed-path prefix redirect creation into another tree.
  let prefix = dirname(workspace.path);
  while (prefix !== root) {
    if (await exists(prefix) && await realpath(prefix) !== prefix) throw new Error('Owned workspace path is redirected');
    prefix = dirname(prefix);
  }
  const sha = await checkedGit(root, ['rev-parse', '--verify', '--end-of-options', `${workspace.baselineSha}^{commit}`]);
  if (sha !== workspace.baselineSha) throw new Error('Owned baseline is not a pinned commit');
  return workspace;
}
function workerWorkspace(run: RunRecord): WorkerWorkspace {
  const delegation = delegationStateSchema.parse(run.delegation);
  if (delegation.role !== 'worker' || delegation.workspace.ownerRunId !== run.id) throw new Error('Missing worker ownership');
  return delegation.workspace;
}

async function receiptLocation(repoRoot: string, workspace: WorkerWorkspace, create = false): Promise<string> {
  const dir = join(await commonDir(repoRoot), 'cezar-owned-workspaces');
  if (create) await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (await exists(dir)) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir || (info.mode & 0o077) !== 0) {
      throw new Error('Unsafe owned workspace receipt directory');
    }
  }
  return join(dir, `${workspace.resourceId}.json`);
}
async function readIdentityFile(path: string, cap: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe owned workspace identity file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > cap || (opened.mode & 0o077) !== 0) throw new Error('Unsafe owned workspace identity file');
    const buffer = Buffer.alloc(cap + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > cap) throw new Error('Oversized owned workspace identity file');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
async function writeIdentityFile(path: string, content: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function readReceipt(path: string): Promise<Receipt | undefined> {
  if (!await exists(path)) return undefined;
  return receiptSchema.parse(JSON.parse(await readIdentityFile(path, RECEIPT_CAP)));
}
async function liveGitDir(repoRoot: string, workspace: WorkerWorkspace): Promise<string> {
  if (await realpath(workspace.path) !== workspace.path) throw new Error('Owned workspace path is redirected');
  const rootCommon = await commonDir(repoRoot);
  if (await commonDir(workspace.path) !== rootCommon) throw new Error('Owned workspace repository changed');
  const top = await realpath(await checkedGit(workspace.path, ['rev-parse', '--show-toplevel']));
  if (top !== workspace.path) throw new Error('Owned workspace is no longer a Git worktree');
  const listed = await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (!listed.split('\0').includes(`worktree ${workspace.path}`)) throw new Error('Owned workspace registration missing');
  const gitDir = await realpath(await checkedGit(workspace.path, ['rev-parse', '--absolute-git-dir']));
  // Linked worktrees have a distinct administrative directory, never the main index.
  if (gitDir === rootCommon) throw new Error('Owned workspace points at the main repository');
  return gitDir;
}

/** Fresh-only primitive. Runtime callers supply the already-durable preallocated intent. */
export async function createOwnedWorkspace(repoRoot: string, workerId: string, baselineSha: string, intent?: WorkerWorkspace): Promise<WorkerWorkspace> {
  const workspace = await validateIntent(repoRoot, intent ?? await planOwnedWorkspace(repoRoot, workerId, baselineSha));
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
  await writeIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), workspace.resourceId);
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
      await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36) !== workspace.resourceId) {
    throw new Error('Owned workspace Git identity changed');
  }
  return workspace;
}

/** Reuse only proven resources. No reattachment/replacement after resource loss or ambiguous provisioning. */
export async function ensureOwnedWorkspace(repoRoot: string, run: RunRecord): Promise<WorkerWorkspace> {
  const workspace = await validateIntent(repoRoot, workerWorkspace(run));
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
    await copyFile(workerIndex, index);
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

/** Trusted in-process verifier obtained from the manager, never a wire field. */
export type WorkerNoMaterializationProof = (workspace: WorkerWorkspace) => boolean;

/** Checked cleanup only. Caller must first persist destruction intent and prove termination.
 * The private checkpoint survives removal of the linked Git directory and records
 * the exact ref/log identity whose compare-and-swap deletion may be retried. */
export async function removeOwnedWorkspace(repoRoot: string, value: WorkerWorkspace, neverMaterialized?: WorkerNoMaterializationProof): Promise<WorkerDestroyResult> {
  let remaining: Array<'worktree' | 'branch'> = ['worktree', 'branch'];
  const result = (): WorkerDestroyResult => ({ workerId: value.ownerRunId, state: remaining.length ? 'incomplete' : 'complete', remaining });
  try {
    const workspace = await validateIntent(repoRoot, value);
    const path = await receiptLocation(repoRoot, workspace);
    const receipt = await readReceipt(path);
    const registered = async () => (await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
    const branchExists = async () => {
      const refs = await checkedGit(repoRoot, ['for-each-ref', '--format=%(refname)', `refs/heads/${workspace.branch}`]);
      return refs.split('\n').includes(`refs/heads/${workspace.branch}`);
    };
    if (!receipt) {
      // Absence alone cannot distinguish moved/rebranched resources. Only a
      // private exact-generation no-materialization proof permits this no-op.
      // Revalidate after asynchronous inspection; never delete inferred resources.
      if (neverMaterialized?.(workspace) && !await exists(workspace.path) &&
          !(await registered()).includes(`worktree ${workspace.path}`) && !await branchExists() &&
          neverMaterialized(workspace)) remaining = [];
      return result();
    }
    if (!same(receipt.workspace, workspace)) return result();
    const checkpointPath = path.replace(/\.json$/, '.cleanup.json');
    let checkpoint = await exists(checkpointPath) ? cleanupSchema.parse(JSON.parse(await readIdentityFile(checkpointPath, RECEIPT_CAP))) : undefined;
    if (checkpoint && (!same(checkpoint.workspace, workspace) || checkpoint.gitDir !== receipt.gitDir)) return result();
    if (checkpoint?.phase === 'complete') {
      remaining = [];
      if (await exists(workspace.path) || (await registered()).includes(`worktree ${workspace.path}`) || await exists(receipt.gitDir)) remaining.push('worktree');
      if (await branchExists()) remaining.push('branch');
      return result();
    }
    if (await exists(workspace.path)) {
      if (checkpoint?.phase === 'worktree-removed') return result();
      if (await liveGitDir(repoRoot, workspace) !== receipt.gitDir ||
          await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36) !== workspace.resourceId) return result();
      if (await checkedGit(workspace.path, ['symbolic-ref', '-q', 'HEAD']) !== `refs/heads/${workspace.branch}`) return result();
      // Git permits duplicate checkouts with --force. Preserve both resources
      // before the first removal if another registered path uses this branch.
      let registeredPath: string | undefined;
      for (const entry of await registered()) {
        if (entry.startsWith('worktree ')) registeredPath = entry.slice('worktree '.length);
        if (entry === `branch refs/heads/${workspace.branch}` && registeredPath !== workspace.path) return result();
      }
      const current = await verifyBranch(repoRoot, workspace, receipt);
      if (checkpoint && (checkpoint.sha !== current.sha || !same(checkpoint.logFile, current.log.file) || checkpoint.logHash !== hash(current.log.content))) return result();
      checkpoint ??= { workspace, gitDir: receipt.gitDir, sha: current.sha, logFile: current.log.file, logHash: hash(current.log.content), phase: 'prepared' };
      await writeCleanup(checkpointPath, checkpoint);
      const removed = await git(repoRoot, ['worktree', 'remove', '--force', workspace.path]);
      if (!removed.ok) return result();
    }
    if (!checkpoint || await exists(workspace.path) || await exists(receipt.gitDir) || (await registered()).includes(`worktree ${workspace.path}`)) return result();
    remaining = ['branch'];
    checkpoint = { ...checkpoint, phase: 'worktree-removed' };
    await writeCleanup(checkpointPath, checkpoint);
    if (await branchExists()) {
      if ((await registered()).includes(`branch refs/heads/${workspace.branch}`)) return result();
      const current = await verifyBranch(repoRoot, workspace, receipt);
      if (current.sha !== checkpoint.sha || !same(current.log.file, checkpoint.logFile) || hash(current.log.content) !== checkpoint.logHash) return result();
      // Ref CAS: never delete a branch advanced after our verified snapshot.
      const removed = await git(repoRoot, ['update-ref', '-d', `refs/heads/${workspace.branch}`, checkpoint.sha]);
      if (!removed.ok || await branchExists()) return result();
    }
    await writeCleanup(checkpointPath, { ...checkpoint, phase: 'complete' });
    remaining = [];
  } catch { /* Ambiguous ownership and every failed Git/filesystem operation fail closed. */ }
  return result();
}
