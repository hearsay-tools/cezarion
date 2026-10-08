import { spawn } from 'node:child_process';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS } from './runner-runtime.ts';

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
  readonly pid?: number;
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
  callbacks: { onStdout(chunk: string): void; onStderr(chunk: string): void },
): CursorPrintProcess {
  const isNodeScript = /\.[cm]?js$/.test(options.bin);
  const command = isNodeScript ? process.execPath : options.bin;
  const args = isNodeScript ? [options.bin, ...options.args] : [...options.args];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let closed = false;
  let inputClosed = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  const useGroup = process.platform !== 'win32';
  const groupAlive = (): boolean => {
    if (!pid) return false;
    try { process.kill(useGroup ? -pid : pid, 0); return true; } catch { return false; }
  };
  const signal = (name: NodeJS.Signals): void => {
    if (!pid) return;
    try { process.kill(useGroup ? -pid : pid, name); } catch { /* already gone */ }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { if (!closed) callbacks.onStdout(chunk); });
  child.stderr.on('data', (chunk: string) => { if (!closed) callbacks.onStderr(chunk); });
  // The input pipe can fail after an interrupted turn even if no writer is
  // pending. Keep it observed so an EPIPE cannot crash the server.
  child.stdin.on('error', () => {});

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    child.once('error', reject);
  });
  const settled = (async () => {
    try { await exit; } catch { /* failed spawn is reported through exit */ }
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
    // The leader can exit while a child retains stdout/stderr. End its owned
    // process group, allow buffered final frames, then force pipe closure.
    signal('SIGTERM');
    const drainMs = options.drainMs ?? 250;
    await new Promise<void>(resolve => { drainTimer = setTimeout(resolve, drainMs); });
    if (groupAlive()) signal('SIGKILL');
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
    if (termGrace === 0) signal('SIGTERM');
    else termTimer = setTimeout(() => signal('SIGTERM'), termGrace);
    killTimer = setTimeout(() => { if (groupAlive()) signal('SIGKILL'); }, termGrace + killGrace);
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
