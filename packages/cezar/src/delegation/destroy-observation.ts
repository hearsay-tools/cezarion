import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentTmpDirLocations } from '../runs/agent-tmpdir.ts';
import type { RunStore } from '../runs/store.ts';
import { processCwdUnder, processStartToken, recordedProcessLive, type RecordedProcess } from './process-liveness.ts';

/**
 * What a full destroy attempt started from, and the processes it found holding the worker's
 * resources (hearsay-tools/cezarion#879). A scheduled retry that would observe the same, with
 * every holder still the same live process, has nothing new to try: it skips the transcript
 * read, the git spawns, the `/proc` scans and the snapshot writes.
 */
export type DestroyObservation = { key: string; holders: RecordedProcess[] };

/** A file's identity, content and permission stamp, or why it cannot be read. `ctime` and `mode`
 * catch a repair that keeps the size and the second (an in-place rewrite, a `chmod`). */
function fileSignature(path: string): string {
  try { const info = lstatSync(path); return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`; }
  catch (error) { return (error as NodeJS.ErrnoException).code ?? 'error'; }
}
/** A small identity file's bytes and permissions. Each removal attempt rewrites its cleanup
 * checkpoint atomically (a new inode, the same bytes), so only what such a file says, and who may
 * read it, is a change; an in-place repair or a `chmod` still is. */
function contentSignature(path: string): string {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 65_536) return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;
    return `${info.mode}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  } catch (error) { return (error as NodeJS.ErrnoException).code ?? 'error'; }
}
/** A directory's identity and permissions only: a holder working inside it changes its times,
 * never whether the directory is there, which one it is, or who may read it. */
function dirSignature(path: string): string {
  try { const info = lstatSync(path); return `${info.ino}:${info.mode}`; }
  catch (error) { return (error as NodeJS.ErrnoException).code ?? 'error'; }
}

/** The linked worktree's own admin dir, which its `.git` file names: its lock and its ownership
 * marker live there. */
function adminDir(worktree: string): string | undefined {
  try {
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(join(worktree, '.git'), 'utf8'))?.[1]?.trim();
    return gitdir ? resolve(worktree, gitdir) : undefined;
  } catch { return undefined; }
}

/**
 * Everything a destroy attempt's outcome depends on that a stat or a small file read can see:
 * the worker's record (minus `destroy`, which every attempt rewrites), the parent's receipt, the
 * execution checkpoint, the process record, the scratch locations, the worktree and its own admin
 * dir, lock and ownership marker and, given the repository's common Git dir, the ownership receipt
 * and its cleanup checkpoint, the branch ref, `packed-refs`, the branch reflog and the
 * linked-worktree admin dirs. Synchronous, with no git and no `/proc` scan. The worktree mutation
 * lock is not here: every full attempt takes it, so its stamp would change on every attempt.
 */
export function observeDestroy({ store, dataDir, commonDir, workerId }: { store: RunStore; dataDir: string; commonDir?: string; workerId: string }): string {
  const run = store.getRun(workerId);
  if (run?.delegation?.role !== 'worker') return JSON.stringify({ status: run?.status, role: run?.delegation?.role });
  const { destroy: _destroy, ...delegation } = run.delegation;
  const parent = store.getRun(delegation.parentRunId);
  const receipt = parent?.delegation?.role === 'root' ? parent.delegation.receipts.find(entry => entry.workerId === workerId) : undefined;
  const execution = store.readWorkerExecution(workerId);
  const { path, branch, resourceId } = delegation.workspace;
  const admin = adminDir(path);
  return JSON.stringify({
    status: run.status, delegation,
    receipt: receipt ? receipt.deletion ?? 'present' : 'absent',
    execution: execution ?? 'absent',
    processes: execution ? store.readWorkerProcesses(workerId, execution.generation) : 'absent',
    scratch: agentTmpDirLocations(dataDir, workerId).map(dirSignature),
    worktree: dirSignature(path),
    admin: admin ? [fileSignature(admin), fileSignature(join(admin, 'locked')), contentSignature(join(admin, 'cezar-owned-resource'))] : 'absent',
    ...(commonDir ? { git: [
      contentSignature(join(commonDir, 'cezar-owned-workspaces', `${resourceId}.json`)),
      contentSignature(join(commonDir, 'cezar-owned-workspaces', `${resourceId}.cleanup.json`)),
      fileSignature(join(commonDir, 'refs/heads', branch)),
      fileSignature(join(commonDir, 'packed-refs')),
      fileSignature(join(commonDir, 'logs/refs/heads', branch)),
      fileSignature(join(commonDir, 'worktrees')),
    ] } : {}),
  });
}

/** The holders a failed attempt named, pinned to their current incarnation. */
export function recordHolders(pids: readonly number[]): RecordedProcess[] {
  return pids.map(pid => { const startToken = processStartToken(pid); return { pid, ...(startToken ? { startToken } : {}) }; });
}

/**
 * Every holder the last attempt named still holds: the same live process and, unless it belongs to
 * the generation's own process record (which blocks wherever it works), still working under the
 * worktree or a scratch location. A holder that exited, was replaced or moved away is a change.
 * One `readlink` per holder; where only a full scan could read a cwd, liveness alone decides.
 */
export function holdersStillHold({ store, dataDir, workerId, holders }: { store: RunStore; dataDir: string; workerId: string; holders: readonly RecordedProcess[] }): boolean {
  if (!holders.length) return true;
  const run = store.getRun(workerId);
  if (run?.delegation?.role !== 'worker') return false;
  const execution = store.readWorkerExecution(workerId);
  const record = execution ? store.readWorkerProcesses(workerId, execution.generation) : 'absent';
  const recorded = typeof record === 'string' ? [] : [record.controller.pid, ...record.processes.map(entry => entry.pid)];
  const paths = [run.delegation.workspace.path, ...agentTmpDirLocations(dataDir, workerId)];
  return holders.every(holder => recordedProcessLive(holder) && (recorded.includes(holder.pid) || processCwdUnder(holder.pid, paths) !== false));
}
