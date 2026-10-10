import { autosaveGroupExists, autosaveGroupSnapshotAlive, groupInspectionFailed } from './autosave-group.ts';
import type { AutosaveCleanupProof } from './autosave-cleanup.ts';
import { processStartToken } from './delegation/process-liveness.ts';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { watchAutosaveHolders } from './autosave-holders.ts';
import { watchWindowsAutosave } from './autosave-windows.ts';

/** Internal budgets, shared by every autosave command; no user configuration required. */
export interface AutosaveOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  confirmMs?: number;
  onWarning?: (message: string) => void;
  /** Cleanup is still pending. Callers may settle execution only under a separate worktree hold. */
  onBlocked?: (message: string, proof: AutosaveCleanupProof) => void;
}

/** A group consisting only of zombies cannot write, even before init reaps it. */
async function groupAlive(pid: number, diagnostic: (message: string) => void): Promise<boolean> {
  const uncertain = (error: unknown) => groupInspectionFailed(pid, error, diagnostic);
  if (!autosaveGroupExists(pid, diagnostic)) return false;
  if (process.platform !== 'linux') { diagnostic(`process group ${pid} alive`); return true; }
  try {
    const stats: string[] = [];
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try { stats.push(await readFile(`/proc/${entry}/stat`, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        uncertain(error); return true;
      }
    }
    return autosaveGroupSnapshotAlive(pid, stats, diagnostic);
  } catch (error) { uncertain(error); return true; }
}

/**
 * Timeout starts shutdown, never completion. The returned promise retains the
 * caller's worktree guard until both the leader and its process group are gone.
 * If the OS cannot prove termination, report it and keep observing; no timer
 * fabricates permission for another writer. Commands never reset/remove files.
 */
export async function autosaveGit(cwd: string, args: string[], options: AutosaveOptions) {
  const windows = process.platform === 'win32' ? await watchWindowsAutosave() : undefined;
  const holdersAlive = process.platform === 'win32' ? (windows ? Object.assign(async () => false, { diagnostics: () => ({ pids: [] as number[], processes: [], inspectionFailed: false }) }) : undefined) : await watchAutosaveHolders(cwd);
  return new Promise<{ ok: boolean; stdout: string; code: number | null }>((resolve) => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const killGraceMs = options.killGraceMs ?? 1_000;
    const confirmMs = options.confirmMs ?? 2_000;
    const warn = (message: string) => {
      const text = `autosave git ${args[0]} in ${cwd}: ${message}`;
      console.warn(`[cezar] ${text}`);
      try { options.onWarning?.(text); } catch { /* Reporting must not interrupt shutdown. */ }
    };
    if (!holdersAlive) {
      warn('cannot inspect worktree processes; save unsuccessful, no Git command started');
      resolve({ ok: false, stdout: '', code: null });
      return;
    }
    const grouped = process.platform !== 'win32';
    // Git maintenance detaches and may move to the shared git directory.
    // Suppress it for this command only; never rewrite the repository config.
    const child = spawn('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let bytes = 0;
    let exited = false;
    let closed = false;
    let code: number | null = null;
    let aborted = false;
    let finished = false;
    let checking = false;
    let blocked = false;
    let lastBlocker = '';
    let groupDiagnostic = 'process inspection pending';
    let groupPending = true;
    const leaderToken = child.pid === undefined ? undefined : processStartToken(child.pid);
    const reportBlocked = () => {
      if (!blocked || finished) return;
      const holders = holdersAlive.diagnostics();
      const message = `termination not confirmed; Git PID ${child.pid ?? 'unknown'} ${exited ? 'exited' : 'has not exited'}; ${groupDiagnostic}; ` +
        `${holders.inspectionFailed ? 'cwd inspection failed; ' : ''}retained cwd holder PIDs: ${holders.pids.join(', ') || 'none'}; worktree reuse blocked until cleanup is confirmed`;
      const proof = windows ? windows.cleanupProof() : {
        processes: [...holders.processes, ...(!exited && child.pid !== undefined ? [{ pid: child.pid, startToken: leaderToken }] : [])],
        groups: groupPending && child.pid !== undefined ? [child.pid] : [], uncertain: !exited && child.pid === undefined,
      };
      const signature = JSON.stringify({ message, proof });
      if (signature === lastBlocker) return;
      lastBlocker = signature;
      warn(message);
      try { options.onBlocked?.(message, proof); } catch { /* Retain cleanup if the caller cannot take its own hold. */ }
    };
    let killTimer: NodeJS.Timeout | undefined;
    let confirmTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    const signal = (name: NodeJS.Signals) => {
      if (finished || child.pid === undefined) return;
      try { if (windows) windows.stop(name === 'SIGKILL'); else process.kill(-child.pid, name); }
      catch { /* The observation below, not signal delivery, proves termination. */ }
    };
    const finish = () => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(confirmTimer);
      clearTimeout(pollTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ok: !aborted && code === 0, stdout, code: aborted ? null : code });
    };
    const observe = async () => {
      if (finished || checking) return;
      clearTimeout(pollTimer);
      checking = true;
      // A failed spawn owns no process. Signals never substitute for observation.
      const alive = child.pid !== undefined && (windows ? await windows.alive(child.pid, () => exited) : await groupAlive(child.pid, message => { groupDiagnostic = message; }));
      groupPending = alive;
      if (!alive) groupDiagnostic = `process group ${child.pid ?? 'unknown'} exited`;
      else if (windows) groupDiagnostic = windows.diagnostic();
      const holders = !alive && await holdersAlive();
      checking = false;
      if (finished) return;
      if (exited && !alive && !holders && (aborted || closed)) { finish(); return; }
      reportBlocked();
      pollTimer = setTimeout(() => { void observe(); }, process.platform === 'linux' ? 50 : 500);
    };
    const abort = (reason: string) => {
      if (aborted || finished) return;
      aborted = true;
      warn(`${reason}; save unsuccessful, stopping process group`);
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), killGraceMs);
      confirmTimer = setTimeout(() => {
        blocked = true;
        reportBlocked();
      }, killGraceMs + confirmMs);
      void observe();
    };
    const deadline = setTimeout(() => abort('command timed out'), timeoutMs);
    const collect = (chunk: string, output: boolean) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024 * 1024) { abort('output limit exceeded'); return; }
      if (output) stdout += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.on('close', () => { closed = true; void observe(); });
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.on('error', () => {
      // Only spawn failure proves no child exists. Later errors do not.
      if (child.pid === undefined) { exited = true; finish(); }
      else abort('process error');
    });
    child.on('exit', value => { exited = true; code = value; void observe(); });
    if (windows) void observe(); // Observe ancestry while the leader is still running.
  });
}
