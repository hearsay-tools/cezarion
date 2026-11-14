import { logPrefix } from './home/display.ts';
import { productEnvEntries } from './core/product-env.ts';
import { gitEnv } from './git-command.ts';
import { autosaveGroupExists, autosaveGroupSnapshotAlive, groupInspectionFailed } from './autosave-group.ts';
import type { AutosaveCleanupProof } from './autosave-cleanup.ts';
import { describeProcesses, processStartToken } from './delegation/process-liveness.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { watchAutosaveHolders, type AutosaveHolders } from './autosave-holders.ts';
import { watchWindowsAutosave } from './autosave-windows.ts';

/** The legacy marker stays present for process-attribution readers during the rename. */
export function autosaveOwnerEnv(marker: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(source).filter(([name]) => !/^(CEZ|HSQ)_AUTOSAVE_OWNER$/i.test(name)));
  return { ...kept, ...productEnvEntries('AUTOSAVE_OWNER', marker) };
}

/** Internal budgets, shared by every autosave command; no user configuration required. */
export interface AutosaveOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  confirmMs?: number;
  onWarning?: (message: string) => void;
  /** Cleanup is still pending. Callers may settle execution only under a separate worktree hold. */
  onBlocked?: (message: string, proof: AutosaveCleanupProof) => void;
}

/** Transcript warnings while cleanup is blocked; the durable proof still follows every change. */
const BLOCKED_WARNINGS = 3;

export type AutosaveGitResult = { ok: boolean; stdout: string; code: number | null };
const UNSUCCESSFUL: AutosaveGitResult = { ok: false, stdout: '', code: null };
const pollMs = () => process.platform === 'linux' ? 50 : 500;

/** What one save's Git commands share: the owner marker, the cwd-holder watch and the blocked reports. */
interface AutosaveSave {
  cwd: string;
  marker: string;
  options: AutosaveOptions;
  holders: AutosaveHolders;
  /** The running Git leader: an unmarked child of it is still Git's. */
  leader?: number | undefined;
  /** A command timed out: the save is unsuccessful, and its shutdown has started. */
  stopping: boolean;
  /** A blocked report went out: every later change is reported at once. */
  blocked: boolean;
  warn(label: string, message: string): void;
  report(label: string, message: string, proof: Omit<AutosaveCleanupProof, 'marker'>): void;
}

/** A clean watch for win32, where the job-object proof in autosave-windows.ts replaces the cwd scan. */
const NO_HOLDERS: AutosaveHolders = Object.assign(async () => false, { diagnostics: () => ({ pids: [] as number[], processes: [], inspectionFailed: false }) });

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
 * Runs one save's Git commands under one owner marker and one cwd-holder watch
 * (hearsay-tools/squawk#1694): the watch scans the worktree's processes once before the
 * first command and once after the last, not twice per command. Each command still waits
 * until its process group is gone. Git descendants that left the group are checked after
 * the last command: the caller holds the worktree for the whole save, so no other writer
 * can start in between. Returns `unsuccessful` when no Git command may start, or when a
 * descendant outlives the budget.
 */
export async function withAutosaveGit<T>(cwd: string, options: AutosaveOptions, unsuccessful: T,
  run: (git: (args: string[]) => Promise<AutosaveGitResult>) => Promise<T>): Promise<T> {
  const marker = randomUUID();
  let blockedWarnings = 0;
  let lastBlocker = '';
  const save: AutosaveSave = {
    cwd, marker, options, holders: NO_HOLDERS, stopping: false, blocked: false,
    warn: (label, message) => {
      const text = `${label} in ${cwd}: ${message}`;
      console.warn(`${logPrefix()} ${text}`);
      try { options.onWarning?.(text); } catch { /* Reporting must not interrupt shutdown. */ }
    },
    report: (label, message, proof) => {
      save.blocked = true;
      const signature = JSON.stringify({ message, proof });
      if (signature === lastBlocker) return;
      lastBlocker = signature;
      // Changing descendant PIDs must not flood the transcript (hearsay-tools/cezarion#958).
      if (blockedWarnings < BLOCKED_WARNINGS) save.warn(label, message);
      else if (blockedWarnings === BLOCKED_WARNINGS) save.warn(label, 'further cleanup changes suppressed until cleanup is confirmed; worktree reuse stays blocked');
      blockedWarnings++;
      try { options.onBlocked?.(message, { ...proof, marker }); } catch { /* Retain cleanup if the caller cannot take its own hold. */ }
    },
  };
  if (process.platform !== 'win32') {
    const holders = await watchAutosaveHolders(cwd, { marker, root: () => save.leader });
    if (!holders) {
      save.warn('autosave', 'cannot inspect worktree processes; save unsuccessful, no Git command started');
      return unsuccessful;
    }
    save.holders = holders;
  }
  const result = await run(args => runAutosaveGit(save, args));
  return await settleHolders(save) ? result : unsuccessful;
}

/** One Git command as a save of its own. */
export function autosaveGit(cwd: string, args: string[], options: AutosaveOptions): Promise<AutosaveGitResult> {
  return withAutosaveGit(cwd, options, UNSUCCESSFUL, git => git(args));
}

/**
 * Waits until no Git descendant holds the worktree: one scan when none does. A holder is
 * never signalled; it may have left Git's group on purpose. Past the budget the save is
 * unsuccessful, and then blocked until the holders exit. False when the save is unsuccessful.
 */
function settleHolders(save: AutosaveSave): Promise<boolean> {
  const { options } = save;
  const timeoutMs = save.stopping ? 0 : options.timeoutMs ?? 30_000;
  const confirmMs = (options.killGraceMs ?? 1_000) + (options.confirmMs ?? 2_000);
  let timedOut = save.stopping;
  let named = { pids: '', text: '' };
  const report = () => {
    const { pids, processes, inspectionFailed } = save.holders.diagnostics();
    // Names cost one read per holder: read them again only when the holders change.
    if (named.pids !== pids.join()) named = { pids: pids.join(), text: describeProcesses(pids) };
    save.report('autosave', `termination not confirmed; Git process groups exited; ${inspectionFailed ? 'cwd inspection failed; ' : ''}` +
      `retained cwd holder PIDs: ${named.text || 'none'}; worktree reuse blocked until cleanup is confirmed`, { processes, groups: [], uncertain: false });
  };
  return new Promise(resolve => {
    let pollTimer: NodeJS.Timeout | undefined;
    const deadline = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      save.warn('autosave', 'Git descendants still hold the worktree; save unsuccessful');
    }, timeoutMs) : undefined;
    const confirmTimer = save.blocked ? undefined : setTimeout(report, timeoutMs + confirmMs);
    const poll = async () => {
      if (!await save.holders()) {
        clearTimeout(deadline); clearTimeout(confirmTimer); clearTimeout(pollTimer);
        resolve(!timedOut);
        return;
      }
      if (save.blocked) report();
      pollTimer = setTimeout(() => { void poll(); }, pollMs());
    };
    void poll();
  });
}

/**
 * Timeout starts shutdown, never completion. The returned promise retains the
 * caller's worktree guard until both the leader and its process group are gone.
 * If the OS cannot prove termination, report it and keep observing; no timer
 * fabricates permission for another writer. Commands never reset/remove files.
 */
async function runAutosaveGit(save: AutosaveSave, args: string[]): Promise<AutosaveGitResult> {
  const { cwd, options } = save;
  const windows = process.platform === 'win32' ? await watchWindowsAutosave() : undefined;
  const label = `autosave git ${args[0]}`;
  const warn = (message: string) => save.warn(label, message);
  if (process.platform === 'win32' && !windows) {
    warn('cannot inspect worktree processes; save unsuccessful, no Git command started');
    return UNSUCCESSFUL;
  }
  return new Promise<AutosaveGitResult>((resolve) => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const killGraceMs = options.killGraceMs ?? 1_000;
    const confirmMs = options.confirmMs ?? 2_000;
    const grouped = process.platform !== 'win32';
    // Git maintenance detaches and may move to the shared git directory.
    // Suppress it for this command only; never rewrite the repository config.
    const child = spawn('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
      cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'], env: autosaveOwnerEnv(save.marker, gitEnv()),
    });
    save.leader = child.pid;
    let stdout = '';
    let bytes = 0;
    let exited = false;
    let closed = false;
    let code: number | null = null;
    let aborted = false;
    let finished = false;
    let checking = false;
    let blocked = false;
    let groupDiagnostic = 'process inspection pending';
    let groupPending = true;
    const leaderToken = child.pid === undefined ? undefined : processStartToken(child.pid);
    const reportBlocked = () => {
      if (!blocked || finished) return;
      const message = `termination not confirmed; Git PID ${child.pid ?? 'unknown'} ${exited ? 'exited' : 'has not exited'}; ${groupDiagnostic}; ` +
        'worktree reuse blocked until cleanup is confirmed';
      save.report(label, message, windows ? windows.cleanupProof() : {
        processes: !exited && child.pid !== undefined ? [{ pid: child.pid, startToken: leaderToken }] : [],
        groups: groupPending && child.pid !== undefined ? [child.pid] : [], uncertain: !exited && child.pid === undefined,
      });
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
      save.leader = undefined;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(confirmTimer);
      clearTimeout(pollTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(aborted ? UNSUCCESSFUL : { ok: code === 0, stdout, code });
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
      checking = false;
      if (finished) return;
      if (exited && !alive && (aborted || closed)) { finish(); return; }
      reportBlocked();
      pollTimer = setTimeout(() => { void observe(); }, pollMs());
    };
    const abort = (reason: string) => {
      if (aborted || finished) return;
      aborted = true;
      save.stopping = true;
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
