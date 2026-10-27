import { inspectGeneration } from './process-liveness.ts';
import { assertDarwinMountBoundary, assertLinuxMountBoundary, MountBoundaryError } from './mount-boundary.ts';
import { waitForTestAppWatcher, withIdleTestApp } from './idle-test-app.ts';
import { windowsAssertMountBoundary, windowsIdentityDirectory, windowsReadIdentity, windowsWriteIdentity } from './windows-workspace-identity.ts';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import { copyGitIndex } from '../git-index-copy.ts';
import { delegationStateSchema, workerWorkspaceSchema } from '@open-mercato/cezar-contract/delegation';
import type { WorkerDestroyResult, WorkerDiff, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { branchFor, createWorktree, DIFF_CAP, worktreePathFor } from '../git-worktree.ts';
import { withWorktreeMutation, WorktreeMutationLockTimeout } from '../git-worktree-lock.ts';
import { resolveTaskDiffBase } from '../git-diff-base.ts';
import { isSafeGitRef } from '../git-refs.ts';
import type { RunRecord } from '../runs/store.ts';
import { DelegationPolicyError } from './policy.ts';

const RECEIPT_CAP = 16_384;
// Filesystem primitives belong to the host that loaded this module.
const windowsIdentities = process.platform === 'win32';
// Identify owned branches by tip and reflog contents, not inode identity.
// Keep file/logFile fields for older strict checkpoint readers.
const fileIdentitySchema = z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict();
const branchIdentitySchema = z.object({ file: fileIdentitySchema, prefixBytes: z.number().int().min(1).max(4096), prefixHash: z.string().length(64) }).strict();
const receiptSchema = z.object({ workspace: workerWorkspaceSchema, gitDir: z.string().min(1), branchIdentity: branchIdentitySchema.optional() }).strict();
const cleanupSchema = z.object({ workspace: workerWorkspaceSchema, gitDir: z.string(), sha: workerWorkspaceSchema.shape.baselineSha,
  logFile: fileIdentitySchema, logHash: z.string().length(64), rootIdentity: z.object({ dev: z.number(), ino: z.number() }).strict().optional(), phase: z.enum(['prepared', 'worktree-removed', 'complete']) }).strict();
type Cleanup = z.infer<typeof cleanupSchema>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const checkUnheld = (assertUnheld?: () => void) => assertUnheld?.();
async function removeAfterIdleApp(path: string, remove: () => Promise<boolean>, report?: RemovalReport): Promise<boolean> {
  return withIdleTestApp(path, async (_stopped, busy) => {
    if (busy || !await waitForTestAppWatcher(path)) { report?.unexplained?.(); return false; }
    return remove();
  });
}
const matchesRootIdentity = (identity: Cleanup['rootIdentity'], info: { dev: number; ino: number }) =>
  !identity || (identity.dev === info.dev && identity.ino === info.ino);
async function verifiedRootIdentity(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Unsafe owned workspace root');
  return { dev: info.dev, ino: info.ino };
}
function bindRootIdentity(checkpoint: Cleanup, initial: { dev: number; ino: number }, current: { dev: number; ino: number }): boolean {
  if (!matchesRootIdentity(checkpoint.rootIdentity, current) || !matchesRootIdentity(initial, current)) return false;
  // Bind a legacy checkpoint only while the original registered worktree is verified.
  checkpoint.rootIdentity ??= current;
  return true;
}

// Git for Windows emits forward slashes even for native absolute paths.
function worktreeEntries(listed: string): string[] {
  return listed.split('\0').map(entry => entry.startsWith('worktree ') ? `worktree ${normalize(entry.slice(9))}` : entry);
}

async function branchLog(repoRoot: string, workspace: WorkerWorkspace) {
  const common = await gitCommonDir(repoRoot);
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
  if (log.content.length < initial.prefixBytes ||
      hash(log.content.subarray(0, initial.prefixBytes)) !== initial.prefixHash) throw new Error('Branch ownership changed');
  return { sha: await checkedGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${workspace.branch}`]), log };
}
async function writeCleanup(path: string, value: Cleanup, assertCurrent?: () => void): Promise<void> {
  assertCurrent?.();
  if (windowsIdentities) { windowsWriteIdentity(path, JSON.stringify(value), true); return; }
  if (await exists(path)) await readIdentityFile(path, RECEIPT_CAP);
  assertCurrent?.();
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeIdentityFile(temporary, JSON.stringify(value));
  try { assertCurrent?.(); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
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
/** The repository's shared Git directory (where refs, reflogs and linked-worktree admin dirs live), resolved. */
export async function gitCommonDir(cwd: string): Promise<string> {
  return realpath(await checkedGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** Restore owner access only on real directories; do not chmod symlinks or their targets. */
async function makeDirectoryWritable(path: string, expected?: { dev: number; ino: number }): Promise<void> {
  assertLinuxMountBoundary([path]);
  assertDarwinMountBoundary([path]);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path ||
      (expected && (info.dev !== expected.dev || info.ino !== expected.ino))) throw new Error(`Unsafe directory: ${path}`);
  if (process.platform !== 'win32') {
    // Linux O_PATH pins a directory even with mode 000; chmod the pinned inode
    // through procfs because fchmod on an O_PATH descriptor fails with EBADF.
    const linuxPath = process.platform === 'linux';
    // Darwin O_EVTONLY opens an event descriptor without requesting read access;
    // O_NOFOLLOW_ANY rejects a symlink in any component. Native CI must verify
    // both opening mode-000 directories and fchmod on this descriptor.
    const flags = linuxPath ? 0x200000 : process.platform === 'darwin' ? 0x00008000 | 0x20000000 : constants.O_RDONLY;
    // Darwin rejects O_NOFOLLOW combined with O_NOFOLLOW_ANY. The latter
    // already refuses a symlink in the final component as well as ancestors.
    const directory = await open(path, flags | (process.platform === 'darwin' ? 0 : constants.O_NOFOLLOW));
    try {
      const opened = await directory.stat();
      if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`Directory changed: ${path}`);
      if (linuxPath) await chmod(`/proc/self/fd/${directory.fd}`, opened.mode | 0o700);
      else await directory.chmod(opened.mode | 0o700);
    } finally { await directory.close(); }
  }
}

/** Windows directory mode bits do not control deletion; reparse points are never traversed. */
async function makeDirectoriesWritable(path: string): Promise<void> {
  await makeDirectoryWritable(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesWritable(join(path, entry.name));
  }
}

/** Check probe access without changing permissions or claiming the test-app lease. */
async function probeAccessible(path: string, components: string[]): Promise<boolean> {
  try {
    for (const component of components) {
      if (!await exists(component)) break;
      const info = await lstat(component);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(component) !== component) throw new Error(`Unsafe directory: ${component}`);
    }
    await exists(join(path, '.ai', 'qa', 'test-env.json'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return false;
    throw error;
  }
}

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
  const dir = join(await gitCommonDir(repoRoot), 'cezar-owned-workspaces');
  if (windowsIdentities) {
    windowsIdentityDirectory(dir, create);
    return join(dir, `${workspace.resourceId}.json`);
  }
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
async function readIdentityFile(path: string, cap: number, privateParent = true): Promise<string> {
  if (windowsIdentities) return windowsReadIdentity(path, cap, privateParent);
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
async function writeIdentityFile(path: string, content: string, privateParent = true): Promise<void> {
  if (windowsIdentities) { windowsWriteIdentity(path, content, false, privateParent); return; }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function readReceipt(path: string): Promise<Receipt | undefined> {
  if (!await exists(path)) return undefined;
  return receiptSchema.parse(JSON.parse(await readIdentityFile(path, RECEIPT_CAP)));
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
async function liveGitDir(repoRoot: string, workspace: WorkerWorkspace): Promise<string> {
  if (await realpath(workspace.path) !== workspace.path) throw new Error('Owned workspace path is redirected');
  const rootCommon = await gitCommonDir(repoRoot);
  if (await gitCommonDir(workspace.path) !== rootCommon) throw new Error('Owned workspace repository changed');
  const top = await realpath(await checkedGit(workspace.path, ['rev-parse', '--show-toplevel']));
  if (top !== workspace.path) throw new Error('Owned workspace is no longer a Git worktree');
  const listed = await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (!worktreeEntries(listed).includes(`worktree ${workspace.path}`)) throw new Error('Owned workspace registration missing');
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

/** Authenticate the owned root before an explicit destroy can inspect or signal its holders. */
export async function prepareDestroyAccess(repoRoot: string, value: WorkerWorkspace): Promise<() => Promise<void>> {
  return withWorktreeMutation(repoRoot, async () => {
    const workspace = await validateIntent(repoRoot, value);
    const path = await receiptLocation(repoRoot, workspace);
    const receipt = await readReceipt(path);
    if (!receipt || !same(receipt.workspace, workspace)) throw new Error('Owned workspace receipt missing or mismatched');
    const root = await verifiedRootIdentity(workspace.path);
    const checkpointPath = path.replace(/\.json$/, '.cleanup.json');
    const checkpoint = await exists(checkpointPath) ? cleanupSchema.parse(JSON.parse(await readIdentityFile(checkpointPath, RECEIPT_CAP))) : undefined;
    if (checkpoint && (!same(checkpoint.workspace, workspace) || checkpoint.gitDir !== receipt.gitDir || !matchesRootIdentity(checkpoint.rootIdentity, root))) {
      throw new Error('Owned workspace checkpoint identity changed');
    }
    const entries = worktreeEntries(await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']));
    const registered = entries.includes(`worktree ${workspace.path}`);
    if (registered) {
      if (await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36, false) !== workspace.resourceId) throw new Error('Owned workspace marker changed');
      // A registration alone does not prove that the directory at its path is
      // still the checkout. Only a checkpoint-bound inode can authorize repair
      // before the worktree's own Git link is readable.
      if (!checkpoint?.rootIdentity && await liveGitDir(repoRoot, workspace) !== receipt.gitDir) throw new Error('Owned workspace Git identity changed');
    } else if (checkpoint?.phase !== 'prepared' || await exists(receipt.gitDir)) {
      throw new Error('Owned workspace is not an authenticated prepared leftover');
    }
    // Repair only the authenticated root before Git and evidence reads. The opened
    // descriptor is checked against the captured inode before chmod.
    await makeDirectoryWritable(workspace.path, root);
    if (registered && await liveGitDir(repoRoot, workspace) !== receipt.gitDir) throw new Error('Owned workspace Git identity changed');
    return async () => {
      await validateIntent(repoRoot, value);
      if (!same(await readReceipt(path), receipt)) throw new Error('Owned workspace receipt changed');
      const currentCheckpoint = await exists(checkpointPath) ? cleanupSchema.parse(JSON.parse(await readIdentityFile(checkpointPath, RECEIPT_CAP))) : undefined;
      if (checkpoint && !currentCheckpoint) throw new Error('Owned workspace checkpoint disappeared');
      if (currentCheckpoint && (!same(currentCheckpoint.workspace, workspace) || currentCheckpoint.gitDir !== receipt.gitDir ||
          !matchesRootIdentity(currentCheckpoint.rootIdentity, root))) throw new Error('Owned workspace checkpoint identity changed');
      const currentEntries = worktreeEntries(await checkedGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']));
      if (currentEntries.includes(`worktree ${workspace.path}`)) {
        if (await readIdentityFile(join(receipt.gitDir, 'cezar-owned-resource'), 36, false) !== workspace.resourceId ||
            await liveGitDir(repoRoot, workspace) !== receipt.gitDir) throw new Error('Owned workspace Git identity changed');
      } else if (currentCheckpoint?.phase !== 'prepared' || await exists(receipt.gitDir)) {
        throw new Error('Owned workspace is not an authenticated prepared leftover');
      }
      const current = lstatSync(workspace.path);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino) throw new Error('Owned workspace root changed');
    };
  }, { waitMs: 1_000 });
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
  beforeRemove?: () => Promise<void>, assertUnheld?: () => void, report?: RemovalReport,
  reapHolders?: () => Promise<void>): Promise<WorkerDestroyResult> {
  let remaining: Array<'worktree' | 'branch'> = ['worktree', 'branch'];
  let provisioned = false; let lockBusy = false; let heldBy: readonly number[] = [];
  const held = (pids: readonly number[]) => { heldBy = pids; report?.held?.(pids); };
  let stranded: string | undefined; let leftoverError: string | undefined; let mountError: string | undefined;
  const result = (): WorkerDestroyResult => ({ workerId: value.ownerRunId, state: remaining.length ? 'incomplete' : 'complete', remaining,
    ...(remaining.length ? { error: lockBusy ? WORKTREE_LOCK_BUSY_ERROR
      : heldBy.length ? `Owned resources retained: processes ${heldBy.join(', ')} may still hold the worker worktree or scratch; retry destroy after they exit`
      : mountError ? mountError
      : stranded ? `Owned branch ${value.branch} ${stranded}; keep what you need, delete the branch, then retry destroy`
      : leftoverError ? `Git no longer registers owned worktree ${value.path}; cleanup failed: ${leftoverError}`
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
      if (await exists(workspace.path)) {
        const partial = checkpoint?.phase === 'prepared' && !await exists(receipt.gitDir) &&
          !(await registered()).includes(`worktree ${workspace.path}`);
        if (partial ? !await removeLeftover(receipt) : !await removePresentWorktree(receipt)) return result();
      }
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
        const initialRoot = await verifiedRootIdentity(workspace.path);
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
        const rootInfo = await verifiedRootIdentity(workspace.path);
        checkpoint ??= { workspace, gitDir: receipt.gitDir, sha: current.sha, logFile: current.log.file, logHash: hash(current.log.content), phase: 'prepared' };
        return bindRootIdentity(checkpoint, initialRoot, rootInfo) ? checkpoint : undefined;
      }

      async function removePresentWorktree(receipt: Receipt): Promise<boolean> {
        const prepared = await preparePresentWorktree(receipt);
        if (!prepared) return false;
        await writeCleanup(checkpointPath, prepared, assertCurrent);
        assertCurrent?.();
        await beforeRemove?.();
        assertCurrent?.();
        if (reapHolders) {
          await reapHolders();
          if (!await preparePresentWorktree(receipt)) return false;
          await makeDirectoriesWritable(workspace.path);
          if (!await preparePresentWorktree(receipt)) return false;
          await reapHolders();
        }
        if (!reapHolders) checkUnheld(assertUnheld);
        const remove = async () => {
          await reapHolders?.();
          if (!await preparePresentWorktree(receipt)) return false;
          assertCurrent?.();
          if (!reapHolders) {
            assertUnheld?.();
            const holders = inspectGeneration({ paths: [workspace.path] });
            if (holders.liveness !== 'gone') { if (holders.pids.length) held(holders.pids); else report?.unexplained?.(); return false; }
          }
          // Git requires a second force for a locked worktree. Explicit destroy has
          // already authenticated this resource; an owned lock cannot veto it.
          assertLinuxMountBoundary([workspace.path]);
          assertDarwinMountBoundary([workspace.path]);
          if (process.platform === 'win32') windowsAssertMountBoundary([workspace.path]);
          const removal = await mutationGit(repoRoot, ['worktree', 'remove', '--force', ...(reapHolders ? ['--force'] : []), workspace.path]);
          if (!removal.ok) { report?.unexplained?.(); return false; }
          return true;
        };
        const removed = reapHolders ? await remove() : await removeAfterIdleApp(workspace.path, remove, report);
        if (!removed) return false;
        remaining = ['branch'];
        return true;
      }

      async function removeLeftover(receipt: Receipt): Promise<boolean> {
        const safe = async () => {
          const info = await lstat(workspace.path);
          return info.isDirectory() && !info.isSymbolicLink() && await realpath(workspace.path) === workspace.path &&
            !await exists(receipt.gitDir) && !(await registered()).includes(`worktree ${workspace.path}`);
        };
        if (!await safe()) return false;
        const original = await lstat(workspace.path);
        // Old prepared checkpoints have no root identity. Their recovery relies on the
        // cooperative same-path assumption that authorized the original cleanup.
        if (!matchesRootIdentity(checkpoint?.rootIdentity, original)) {
          report?.unexplained?.(); return false;
        }
        const unheld = () => {
          assertCurrent?.();
          if (reapHolders) return true;
          assertUnheld?.();
          const holders = inspectGeneration({ paths: [workspace.path] });
          if (holders.liveness === 'gone') return true;
          if (holders.pids.length) held(holders.pids); else report?.unexplained?.();
          return false;
        };
        const stillOwned = async () => {
          await validateIntent(repoRoot, value);
          if (!same(await readReceipt(path), receipt) ||
              !same(cleanupSchema.parse(JSON.parse(await readIdentityFile(checkpointPath, RECEIPT_CAP))), checkpoint) ||
              !await safe()) return false;
          const current = await lstat(workspace.path);
          return current.dev === original.dev && current.ino === original.ino;
        };
        const removeFiles = async () => {
          try { await makeDirectoriesWritable(workspace.path); }
          catch (error) { return failedRemoval(error); }
          // Permission repair yields: a new checkout or holder can arrive while it runs.
          if (!await stillOwned()) { report?.unexplained?.(); return false; }
          if (!await reapVerified()) return false;
          if (!unheld()) return false;
          assertLinuxMountBoundary([workspace.path]);
          assertDarwinMountBoundary([workspace.path]);
          if (process.platform === 'win32') windowsAssertMountBoundary([workspace.path]);
          try { await rm(workspace.path, { recursive: true, force: true }); }
          catch (error) { return failedRemoval(error); }
          remaining = ['branch'];
          return true;
        };
        const failedRemoval = (error: unknown) => {
          leftoverError = error instanceof Error ? error.message : String(error);
          report?.unexplained?.();
          return false;
        };
        const reapVerified = async () => {
          if (!reapHolders) return true;
          if (!await stillOwned()) return false;
          await reapHolders();
          return stillOwned();
        };
        const repairProbeAccess = async (components: string[]) => {
          for (const component of components) {
            if (!await stillOwned() || !unheld()) return false;
            if (!await exists(component)) break;
            try { await makeDirectoryWritable(component, component === workspace.path ? original : undefined); }
            catch (error) { return failedRemoval(error); }
            if (!await stillOwned() || !unheld()) return false;
          }
          return true;
        };
        assertCurrent?.();
        await beforeRemove?.();
        assertCurrent?.();
        if (!await reapVerified()) return false;
        if (!reapHolders) checkUnheld(assertUnheld);
        const components = [workspace.path, join(workspace.path, '.ai'), join(workspace.path, '.ai', 'qa')];
        let inaccessible: boolean;
        try { inaccessible = !await probeAccessible(workspace.path, components); }
        catch (error) { return failedRemoval(error); }
        // Repair only the probe ancestors before claiming the test-app lease.
        if (inaccessible && !await repairProbeAccess(components)) return false;
        const remove = async () => {
          if (!await reapVerified()) return false;
          if (!unheld()) return false;
          if (!await safe()) { report?.unexplained?.(); return false; }
          return removeFiles();
        };
        return reapHolders ? remove() : removeAfterIdleApp(workspace.path, remove, report);
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
        // hearsay-tools/cezarion#905: the worktree went away outside cezar and left its branch behind.
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
          if (!reapHolders) assertUnheld?.();
          const removed = await mutationGit(repoRoot, ['update-ref', '-d', `refs/heads/${workspace.branch}`, checkpoint.sha]);
          if (!removed.ok || await branchExists()) { report?.unexplained?.(); return; }
        }
        await writeCleanup(checkpointPath, { ...checkpoint, phase: 'complete' }, assertCurrent);
        remaining = [];
      }
    }, { waitMs: 1_000 });
  } catch (error) {
    // Ambiguous ownership and every failed Git/filesystem operation fail closed.
    if (error instanceof MountBoundaryError) mountError = error.message;
    lockBusy = error instanceof WorktreeMutationLockTimeout;
    if (error instanceof WorkspaceHeldError && error.pids.length) held(error.pids);
    else report?.unexplained?.();
  }
  return result();
}
