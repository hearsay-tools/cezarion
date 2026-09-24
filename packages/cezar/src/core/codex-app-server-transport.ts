import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS } from './runner-runtime.ts';

export interface CodexAppServerMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export function resolveCodexExecutable(override?: string): string {
  return override ?? process.env.CEZ_CODEX_BIN ?? (process.env.CEZ_DRY_RUN === '1'
    ? fileURLToPath(new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url)) : 'codex');
}

export function buildCodexAppServerEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  return buildChildEnv({ backend: 'codex', extraEnv });
}

/** Spawn the authenticated host's app-server with the same least-privilege env used by runs. */
export function spawnCodexAppServer(
  bin: string,
  cwd: string,
  extraEnv?: Record<string, string>,
): ChildProcessWithoutNullStreams {
  try {
    return nodeSpawn(bin, ['app-server'], {
      cwd,
      env: buildCodexAppServerEnv(extraEnv),
    });
  } catch (error) {
    throw codexSpawnError(error, bin);
  }
}

/** Minimal newline-JSON request correlator shared by runs and short-lived discovery. */
/** The server answered the request with a JSON-RPC error — a definitive refusal,
 * unlike a timeout or a closed transport (#505). */
export class CodexRpcResponseError extends Error {}

export class CodexAppServerRpc {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed: Error | undefined;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly onFailure?: (error: Error) => void,
  ) {
    // An idle session may have no pending RPC to reject. Unexpected transport
    // loss must reach its owner as well as the outstanding request callers.
    child.stdin.on('error', () => this.fail('codex app-server stdin failed'));
    child.stdin.once('close', () => this.fail('codex app-server stdin closed'));
    child.stdin.once('finish', () => this.fail('codex app-server stdin closed'));
  }

  get open(): boolean {
    return !this.closed && !this.child.stdin.destroyed && !this.child.stdin.writableEnded;
  }

  allocateId(): number {
    return this.nextId++;
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.allocateId();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(message: unknown): void {
    this.write(message);
  }

  dispatchResponse(message: CodexAppServerMessage): boolean {
    if (typeof message.id !== 'number' || (message.result === undefined && message.error === undefined)) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new CodexRpcResponseError(codexErrorText(message.error)));
    else pending.resolve((message.result as Record<string, unknown>) ?? {});
    return true;
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'cezar', title: 'cezar', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  rejectPending(message = 'codex app-server exited'): void {
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }

  /** Revoke this connection, independently of whether its process has exited. */
  close(message = 'codex app-server connection closed'): void {
    this.closed ??= new Error(message);
    this.rejectPending(this.closed.message);
  }

  private fail(message: string): void {
    if (this.closed) return; // deliberate close, or an already-reported fault
    const error = new Error(message);
    this.close(message);
    this.onFailure?.(error);
  }

  private write(message: unknown): void {
    if (this.closed) return;
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      this.fail('codex app-server stdin closed');
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.fail('codex app-server stdin write failed');
      });
    } catch {
      this.fail('codex app-server stdin write failed');
    }
  }
}

/**
 * Close stdin, then escalate SIGTERM→SIGKILL for a server that ignores EOF.
 * `onSignal` fires when the watchdog actually signals: the caller needs to
 * know a non-zero exit was its own doing, not a codex failure (#703).
 */
export function endCodexAppServer(
  child: ChildProcessWithoutNullStreams,
  onTimers?: (term: NodeJS.Timeout, kill: NodeJS.Timeout | undefined) => void,
  onSignal?: () => void,
): void {
  try {
    child.stdin.end();
  } catch {
    // already gone
  }
  // Real termination, not `child.killed` — the latter is set by the SIGTERM
  // this very watchdog sends, which would then suppress its own SIGKILL for an
  // app-server that handles the signal instead of dying from it (#844).
  const hasExited = trackChildExit(child);
  let killTimer: NodeJS.Timeout | undefined;
  const termTimer = setTimeout(() => {
    if (!hasExited()) {
      onSignal?.();
      child.kill('SIGTERM');
    }
    killTimer = setTimeout(() => {
      if (!hasExited()) {
        onSignal?.();
        child.kill('SIGKILL');
      }
    }, EOF_KILL_GRACE_MS);
    killTimer.unref?.();
    onTimers?.(termTimer, killTimer);
  }, EOF_TERM_GRACE_MS);
  termTimer.unref?.();
  onTimers?.(termTimer, killTimer);
}

/** Observe from spawn, not after the RPC/read loop: an exited process may leave
 * inherited stdout open. A timer or a failed kill is never termination proof. */
export function waitForCodexAppServerExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const finish = (code: number | null) => {
      child.off('close', onClose);
      child.off('exit', finish);
      child.off('error', onError);
      resolve(code);
    };
    const onClose = (code: number | null) => finish(code);
    const onError = () => {
      // ENOENT/EACCES never created a process. Other child errors (including
      // unsuccessful signals) must not pretend a live process terminated.
      if (child.pid === undefined) finish(child.exitCode);
    };
    child.once('close', onClose);
    child.once('exit', finish);
    child.on('error', onError);
  });
}

export function codexSpawnError(error: unknown, bin: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install the Codex CLI (npm i -g @openai/codex) and run \`codex\` once to log in`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function codexErrorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
