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
}

/** A group consisting only of zombies cannot write, even before init reaps it. */
async function groupAlive(pid: number): Promise<boolean> {
  try { process.kill(-pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  if (process.platform !== 'linux') return true;
  try {
    let zombie = false;
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = await readFile(`/proc/${entry}/stat`, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return true; // An unreadable process might belong to this group.
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (Number(fields[2]) !== pid) continue;
      if (fields[0] !== 'Z' && fields[0] !== 'X') return true;
      zombie = true;
    }
    if (zombie) return false;
    // A scan with no matches is not proof: recheck the kernel's group lookup.
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  } catch { return true; }
}

/**
 * Timeout starts shutdown, never completion. The returned promise retains the
 * caller's worktree guard until both the leader and its process group are gone.
 * If the OS cannot prove termination, report it and keep observing; no timer
 * fabricates permission for another writer. Commands never reset/remove files.
 */
export async function autosaveGit(cwd: string, args: string[], options: AutosaveOptions) {
  const windows = process.platform === 'win32' ? await watchWindowsAutosave() : undefined;
  const holdersAlive = process.platform === 'win32' ? (windows ? async () => false : undefined) : await watchAutosaveHolders(cwd);
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
      const alive = child.pid !== undefined && (windows ? await windows.alive(child.pid, () => exited) : await groupAlive(child.pid));
      const holders = !alive && await holdersAlive();
      checking = false;
      if (finished) return;
      if (exited && !alive && !holders && (aborted || closed)) { finish(); return; }
      pollTimer = setTimeout(() => { void observe(); }, process.platform === 'linux' ? 50 : 500);
    };
    const abort = (reason: string) => {
      if (aborted || finished) return;
      aborted = true;
      warn(`${reason}; save unsuccessful, stopping process group`);
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), killGraceMs);
      confirmTimer = setTimeout(() => {
        if (!finished) warn('termination not confirmed; worktree remains busy until processes exit');
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
