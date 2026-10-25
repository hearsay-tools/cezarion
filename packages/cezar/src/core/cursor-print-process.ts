import { finished } from 'node:stream/promises';
import {
  afterExitDrain, CRASH_EXIT_DRAIN_MS, EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS, isCrashExit,
} from './runner-runtime.ts';
import { signalExitedSession, signalSession, spawnSessionLeader } from './session-process.ts';

export interface CursorPrintProcessOptions {
  bin: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Test overrides; production uses the shared runner deadlines. */
  drainMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

export interface CursorPrintProcess {
  readonly pid?: number | undefined;
  write(content: string): Promise<void>;
  closeInput(): void;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly settled: Promise<void>;
  stop(mode: 'graceful' | 'interrupt'): Promise<void>;
}

/**
 * Own one Cursor print turn and its process group. `exit` means the leader
 * exited; `settled` means inherited pipes were bounded and descendants were
 * signalled. A subsequent turn must await `settled`, never just `exit`.
 */
export function startCursorPrintProcess(
  options: CursorPrintProcessOptions,
  callbacks: { onStdout(chunk: string): void; onStderr(chunk: string): void; onOutputError?(error: Error): void },
): CursorPrintProcess {
  const isNodeScript = /\.[cm]?js$/.test(options.bin);
  const command = isNodeScript ? process.execPath : options.bin;
  const args = isNodeScript ? [options.bin, ...options.args] : [...options.args];
  // A registered session leader (hearsay-tools/cezarion#1286): cezar's own SIGINT/SIGTERM and the
  // worker ledger reach its group, and every signal after its exit keeps the reuse guard.
  const child = spawnSessionLeader(command, args, { cwd: options.cwd, env: options.env });
  const pid = child.pid;
  let closed = false;
  let inputClosed = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { if (!closed) callbacks.onStdout(chunk); });
  child.stderr.on('data', (chunk: string) => { if (!closed) callbacks.onStderr(chunk); });
  child.stdout.on('error', error => { if (!closed) callbacks.onOutputError?.(error); });
  child.stderr.on('error', error => { if (!closed) callbacks.onOutputError?.(error); });
  // The input pipe can fail after an interrupted turn even if no writer is
  // pending. Keep it observed so an EPIPE cannot crash the server.
  child.stdin.on('error', () => {});

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    child.once('error', reject);
  });
  const settled = (async () => {
    let failedExit = false;
    let exitCode: number | null = null;
    try { exitCode = (await exit).code; failedExit = exitCode !== 0; } catch { failedExit = true; }
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
    // The leader can exit while a child retains stdout/stderr. End its owned
    // process group, allow buffered final frames, then force pipe closure.
    // On a crash, allow a short bounded drain for a descendant's final
    // diagnostic before terminating the group (#499/S19). It is the shared
    // crash budget, counted so a host stall cannot spend it, and ends early
    // once both pipes have closed (hearsay-tools/cezarion#887).
    if (failedExit) {
      await new Promise<void>(resolve => {
        const cancel = afterExitDrain(resolve, isCrashExit(exitCode) ? CRASH_EXIT_DRAIN_MS : 200, true);
        void Promise.all([child.stdout, child.stderr].map(stream => finished(stream, { cleanup: true }).catch(() => undefined)))
          .then(() => { cancel(); resolve(); });
      });
    }
    // This ends Cursor's `worker-server` and its `typescript-language-server`: Cursor spawns
    // them `detached: false`, so they stay in this group after the leader exits, and nothing
    // else ends them before Cursor's own 300 s idle exit (hearsay-tools/cezarion#1285).
    signalExitedSession(child, 'SIGTERM');
    const drainMs = options.drainMs ?? 250;
    await new Promise<void>(resolve => { drainTimer = setTimeout(resolve, drainMs); });
    signalExitedSession(child, 'SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
    if (drainTimer) clearTimeout(drainTimer);
    closed = true;
  })();

  const closeInput = (): void => {
    if (inputClosed) return;
    inputClosed = true;
    child.stdin.end();
  };
  const stop = async (mode: 'graceful' | 'interrupt'): Promise<void> => {
    if (closed) return;
    closeInput();
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
    const termGrace = mode === 'interrupt' ? 0 : options.termGraceMs ?? EOF_TERM_GRACE_MS;
    const killGrace = options.killGraceMs ?? EOF_KILL_GRACE_MS;
    if (termGrace === 0) signalSession(child, 'SIGTERM');
    else termTimer = setTimeout(() => signalSession(child, 'SIGTERM'), termGrace);
    killTimer = setTimeout(() => signalSession(child, 'SIGKILL'), termGrace + killGrace);
    await settled;
  };
  return {
    pid,
    exit,
    settled,
    closeInput,
    stop,
    write(content: string): Promise<void> {
      if (inputClosed || closed) return Promise.reject(new Error('Cursor print input is closed'));
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(content, error => error ? reject(error) : resolve());
      });
    },
  };
}
