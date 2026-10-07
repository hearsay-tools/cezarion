import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentTmpDirLocations } from '../runs/agent-tmpdir.ts';
import type { RunStore } from '../runs/store.ts';
import { processStartToken, recordedProcessLive, type RecordedProcess } from './process-liveness.ts';

/**
 * What a full destroy attempt started from, and the processes it found holding the worker's
 * resources (hearsay-tools/cezarion#879). A scheduled retry that would observe the same, with
 * every holder still the same live process, has nothing new to try: it skips the transcript
 * read, the git spawns, the `/proc` scans and the snapshot writes.
 */
export type DestroyObservation = { key: string; holders: RecordedProcess[] };

/** A file's identity and content stamp, or why it cannot be read. */
function fileSignature(path: string): string {
  try { const info = lstatSync(path); return `${info.ino}:${info.size}:${info.mtimeMs}`; }
  catch (error) { return (error as NodeJS.ErrnoException).code ?? 'error'; }
}
/** A directory's identity only: a holder working inside it changes its mtime, never whether
 * the directory is there or which one it is. */
function dirSignature(path: string): string {
  try { return String(lstatSync(path).ino); }
  catch (error) { return (error as NodeJS.ErrnoException).code ?? 'error'; }
}

/** The linked worktree's own admin dir, which its `.git` file names: its lock lives there. */
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
 * dir and lock and, given the repository's common Git dir, the ownership receipt, the branch ref,
 * `packed-refs`, the branch reflog and the linked-worktree admin dirs. Synchronous, with no git
 * and no `/proc` scan.
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
    admin: admin ? [fileSignature(admin), fileSignature(join(admin, 'locked'))] : 'absent',
    ...(commonDir ? { git: [
      fileSignature(join(commonDir, 'cezar-owned-workspaces', `${resourceId}.json`)),
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

/** Every recorded holder is still the same live process: none exited, none was replaced. */
export function holdersStillLive(holders: readonly RecordedProcess[]): boolean {
  return holders.every(recordedProcessLive);
}
