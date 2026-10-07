import { spawn } from 'node:child_process';

/** Stop on a workflow check: SIGTERM first, SIGKILL to its process group after this grace. */
export const CHECK_KILL_GRACE_MS = 3_000;
/** After SIGKILL, how long to wait for the group to disappear before resolving unconfirmed. */
export const CHECK_TERMINATION_CONFIRM_MS = 5_000;

export interface GroupedCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Called with the stop function when the command starts and with a no-op when it settles. */
  setInterrupt: (stop: () => void) => void;
  /** Stop the command after this long, exactly as a Stop would, and report it as timed out. */
  timeoutMs?: number;
  /** `head` keeps the first `cap` characters (check steps); `tail` keeps the last ones (worktree
   *  setup, #917 — an install reports its error at the end). */
  keep: 'head' | 'tail';
  cap: number;
}

export interface GroupedCommandResult {
  /** `null` when a signal ended the command or it never started. */
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Run `bash -lc <command>` in its own process group (POSIX) — the runner check steps and worktree
 * setup share. Stop signals the group we created, never a recycled pid or an unrelated process:
 * SIGTERM, then SIGKILL after `CHECK_KILL_GRACE_MS`, and the result waits until the group is
 * confirmed gone or the confirmation bound passes, which the output then says.
 */
export function runGroupedCommand(opts: GroupedCommandOptions): Promise<GroupedCommandResult> {
  const { command, cwd, env, setInterrupt, timeoutMs, keep, cap } = opts;
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn('bash', ['-lc', command], { cwd, env, detached: grouped });
    const pid = child.pid;

    let output = '';
    let truncated = false;
    let finished = false;
    let stopping = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let stopAt = 0;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (finished || !pid) return;
      try { if (grouped) process.kill(-pid, signal); else child.kill(signal); } catch { /* already gone */ }
    };
    const groupAlive = () => {
      if (!grouped || !pid) return false;
      try { process.kill(-pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
    };
    const settle = () => {
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      setInterrupt(() => undefined);
    };
    const finish = (code: number | null) => {
      if (finished) return;
      settle();
      child.stdout?.destroy();
      child.stderr?.destroy();
      let text = output.trim() || '(no output)';
      if (keep === 'tail' && truncated) text = `… (earlier output truncated)\n${text}`;
      if (timedOut) text += `\n… (timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s)`;
      resolve({ exitCode: code, output: text, timedOut });
    };
    // After Stop: the KILL timer escalates; resolve only once the group is
    // confirmed gone (or the confirmation bound passes, reported honestly).
    let reaping = false;
    const confirmTermination = async (code: number | null) => {
      if (reaping) return;
      reaping = true;
      const deadline = stopAt + CHECK_KILL_GRACE_MS + CHECK_TERMINATION_CONFIRM_MS;
      while (groupAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      if (groupAlive()) {
        output += '\n… (process group did not confirm termination)';
      }
      finish(code);
    };
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      stopAt = Date.now();
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), CHECK_KILL_GRACE_MS);
      killTimer.unref?.();
      // Leader already gone but a descendant holds the pipes: no `exit` will follow.
      if (child.exitCode !== null || child.signalCode !== null) void confirmTermination(child.exitCode);
    };
    setInterrupt(stop);
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        if (finished || stopping) return;
        timedOut = true;
        stop();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const collect = keep === 'head'
      ? (chunk: Buffer) => {
          if (output.length < cap) {
            output += chunk.toString('utf8');
            if (output.length >= cap) output += '\n… (output truncated)';
          }
        }
      : (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.length > cap) {
            output = output.slice(-cap);
            truncated = true;
          }
        };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      if (finished) return;
      settle();
      resolve({ exitCode: null, output: `failed to spawn: ${err.message}`, timedOut: false, spawnError: err.message });
    });
    // A descendant can hold the inherited pipes open, so `close` may never
    // fire after Stop. `exit` of the leader is the signal to reap the group.
    child.on('exit', (code) => {
      if (stopping) void confirmTermination(code);
    });
    child.on('close', (code) => {
      if (stopping) void confirmTermination(code);
      else finish(code);
    });
  });
}
