import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorktreeGitResult { ok: boolean; stdout: string; stderr: string }
/** `input` is written to git's stdin — what `update-ref --stdin` needs for a multi-ref transaction. */
export type WorktreeGit = (cwd: string, args: string[], timeout?: number, input?: string) => Promise<WorktreeGitResult>;

export class WorktreeMutationLockTimeout extends Error {
  constructor() { super('timed out waiting for worktree mutation lock'); }
}

/**
 * Serialize worktree mutations by canonical Git common directory, across processes.
 * A short-lived keeper owns both the claim and Git children: losing the caller's
 * IPC channel releases the claim only AFTER its Git command exits. No heartbeat
 * expiry can admit a prune beside a slow/stopped add. No daemon or dependency.
 */
export async function withWorktreeMutation<T>(repoRoot: string, operation: (git: WorktreeGit) => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const waitMs = options.waitMs ?? 120_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new Error('invalid worktree mutation wait budget');
  const common = await new Promise<string>((resolve, reject) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8', timeout: Math.max(1, Math.min(30_000, waitMs)) }, (error, stdout, stderr) => {
      if (error) reject(new Error(`cannot resolve Git common directory: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
  const claims = join(await realpath(common), 'cezar-worktree-mutations');
  const source = import.meta.url.endsWith('.ts');
  const helper = fileURLToPath(new URL(source ? './git-worktree-lock-helper.ts' : './git-worktree-lock-helper.js', import.meta.url));
  const keeper = spawn(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []), helper, claims, String(waitMs)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    // Establish the process group before a claim or Git child can exist.
    detached: process.platform !== 'win32',
    // Do not inherit tsx loaders or the caller's Node inspector flags.
    env: process.env,
  });
  let failure: Error | undefined;
  let stderr = '';
  keeper.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  const pending = new Map<number, { resolve: (result: WorktreeGitResult) => void; reject: (error: Error) => void }>();
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error: Error) => {
    failure = error;
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  keeper.on('error', fail);
  keeper.on('message', (message: { kind: string; id: number; result: WorktreeGitResult; error: string; code?: string }) => {
    if (message.kind === 'ready') readyResolve();
    else if (message.kind === 'error') fail(message.code === 'lock_timeout' ? new WorktreeMutationLockTimeout() : new Error(message.error));
    else if (message.kind === 'result') {
      pending.get(message.id)?.resolve(message.result);
      pending.delete(message.id);
    }
  });
  const exited = new Promise<void>(resolve => {
    keeper.once('exit', (code, signal) => {
      fail(new Error(`worktree mutation keeper exited (${signal ?? code}): ${stderr.trim()}`));
      resolve();
    });
    // A spawn failure emits error but never exit. Do not await close here:
    // explicit IPC disconnect can suppress it on supported Node versions.
    keeper.once('error', () => { if (keeper.pid === undefined) resolve(); });
  });
  let sequence = 0;
  const git: WorktreeGit = (cwd, args, timeout, input) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    keeper.send({ kind: 'git', id, cwd, args, timeout, ...(input !== undefined ? { input } : {}) }, error => { if (error) fail(error); });
  });
  try {
    await ready;
    return await operation(git);
  } finally {
    if (keeper.connected) keeper.disconnect();
    await exited;
  }
}
