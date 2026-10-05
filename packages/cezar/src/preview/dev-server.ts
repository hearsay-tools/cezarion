import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, truncateSync, appendFileSync, writeFileSync, fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { buildCommandEnv } from '../core/agent-env.ts';
import { processStartToken, recordedProcessLive } from '../delegation/process-liveness.ts';
import { CHROMIUM_PID_FILE } from './chromium.ts';

/**
 * Supervisor for one cezar-owned dev server (#781, spec 2026-10-02-live-preview-v1): spawn the
 * registered command in its own process group, TCP-probe until the port answers, and kill the
 * whole group on stop so a command that forks (`npm` -> `node` -> `vite`) frees its port.
 */

export const PREVIEW_PORT_WAIT_MS = 2 * 60_000;
export const PREVIEW_PROBE_MS = 2_000;
const PROBE_CONNECT_MS = 500;
const KILL_GRACE_MS = 5_000;
/** How long a SIGKILLed group gets to disappear before the stop resolves anyway. */
const KILL_SETTLE_MS = 2_000;
const LOG_TRIM_ABOVE = 5 * 1024 * 1024;
const LOG_KEEP = 1024 * 1024;
const LOG_CHECK_MS = 60_000;
const TAIL_READ = 64 * 1024;

export type DevServerState = 'starting' | 'up' | 'stalled' | 'exited' | 'stopped';
export type DevServerStopReason = 'user' | 'idle' | 'release';

function connects(host: string, port: number): Promise<boolean> {
  return new Promise(resolveConnect => {
    const socket = new Socket();
    const done = (up: boolean) => { socket.destroy(); resolveConnect(up); };
    socket.setTimeout(PROBE_CONNECT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Does anything answer on `port`? Vite resolves `localhost` to `::1` on some hosts, so both loopbacks count. */
export async function probePort(port: number): Promise<boolean> {
  return (await connects('127.0.0.1', port)) || (await connects('::1', port));
}

const sleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms));

function signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/pid', String(pgid), '/t', '/f'], { windowsHide: true, timeout: 5_000 }).status === 0;
  }
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}

function groupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** SIGTERM one process, SIGKILL it if it is still there after the grace period. */
async function terminatePid(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + KILL_GRACE_MS;
  while (alive() && Date.now() < deadline) await sleep(50);
  if (alive()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ } }
}

/** SIGTERM the group, SIGKILL whatever is still there after the grace period. */
async function terminateGroup(pgid: number): Promise<void> {
  if (!signalGroup(pgid, 'SIGTERM')) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(50);
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, 'SIGKILL');
  // SIGKILL is delivered, not done: until the kernel tears the processes down they still hold
  // their sockets. Return once the group is gone, so "stopped" means the port is free.
  const killDeadline = Date.now() + KILL_SETTLE_MS;
  while (groupAlive(pgid) && Date.now() < killDeadline) await sleep(20);
}

/** Keep the last 1 MiB once the log passes 5 MiB. The child holds the file open in append mode, so it keeps writing at the end. */
export function trimLog(path: string): void {
  try {
    if (statSync(path).size <= LOG_TRIM_ABOVE) return;
    const fd = openSync(path, 'r');
    const tail = Buffer.alloc(LOG_KEEP);
    try { readSync(fd, tail, 0, LOG_KEEP, fstatSync(fd).size - LOG_KEEP); } finally { closeSync(fd); }
    truncateSync(path, 0);
    appendFileSync(path, tail);
  } catch { /* a log we cannot trim only grows */ }
}

function readTail(path: string, lines: number): string[] {
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TAIL_READ);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8').split('\n').filter(line => line.trim()).slice(-lines);
    } finally { closeSync(fd); }
  } catch { return []; }
}

export class DevServer extends EventEmitter {
  state: DevServerState = 'starting';
  exitCode?: number;
  attempts = 0;
  stopReason?: DevServerStopReason;

  private readonly server: PreviewServer;
  private readonly worktreePath: string;
  private readonly dir: string;
  private readonly probeMs: number;
  private readonly waitMs: number;
  private child?: ChildProcess;
  private childExited?: Promise<void>;
  private probeTimer?: NodeJS.Timeout;
  private waitTimer?: NodeJS.Timeout;
  private logTimer?: NodeJS.Timeout;
  private probing = false;
  private stopping?: Promise<void>;

  constructor(opts: { server: PreviewServer; worktreePath: string; dir: string; probeMs?: number; waitMs?: number }) {
    super();
    this.server = opts.server;
    this.worktreePath = opts.worktreePath;
    this.dir = opts.dir;
    this.probeMs = opts.probeMs ?? PREVIEW_PROBE_MS;
    this.waitMs = opts.waitMs ?? PREVIEW_PORT_WAIT_MS;
  }

  private get pidPath() { return join(this.dir, `${this.server.port}.pid.json`); }
  private get logPath() { return join(this.dir, `${this.server.port}.log`); }

  start(): void {
    if (this.child) return;
    mkdirSync(this.dir, { recursive: true });
    // One log per start: after Start again, 5.8 must show this run's failure, not the last one's tail.
    writeFileSync(this.logPath, '', { mode: 0o600 });
    const logFd = openSync(this.logPath, 'a');
    const cwd = resolve(this.worktreePath, this.server.cwd ?? '.');
    // stdin is closed: nobody can answer a prompt from the cockpit, so one fails fast into `exited` with its log.
    // The command is the agent's and runs outside its sandbox: it gets the curated env, never cezar's secrets (#427).
    const env = buildCommandEnv();
    const child = process.platform === 'win32'
      ? spawn(this.server.command, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', logFd, logFd] })
      : spawn('/bin/sh', ['-c', this.server.command], { cwd, env, detached: true, stdio: ['ignore', logFd, logFd] });
    closeSync(logFd);
    this.child = child;
    this.childExited = new Promise<void>(resolveExit => {
      child.once('error', error => {
        try { appendFileSync(this.logPath, `cezar could not start the command: ${error.message}\n`); } catch { /* log is best effort */ }
        resolveExit();
        this.finish('exited');
      });
      child.once('exit', (code) => {
        resolveExit();
        if (code !== null) this.exitCode = code;
        const pid = child.pid;
        if (this.stopping || pid === undefined) return this.finish(this.stopping ? 'stopped' : 'exited');
        // A leader that dies on its own can leave a forked server holding the port. Reap the group
        // the way a stop does (SIGKILL after the grace period, so a holder that ignores SIGTERM goes
        // too), and keep the pid record until the group is gone: `stop()` awaits the same cleanup.
        this.finish('exited', { keepRecord: true });
        this.stopping = terminateGroup(pid).finally(() => this.removeRecord(pid));
      });
    });
    if (child.pid !== undefined) {
      writeFileSync(this.pidPath, JSON.stringify({ pid: child.pid, pgid: child.pid, startToken: processStartToken(child.pid) }), { mode: 0o600 });
      this.beginWaiting();
      this.logTimer = setInterval(() => trimLog(this.logPath), LOG_CHECK_MS);
      this.logTimer.unref();
    }
  }

  /** The owner pressed "keep waiting" on a stalled server: probe again for another full window. */
  keepWaiting(): void {
    if (this.state !== 'stalled') return;
    this.setState('starting');
    this.beginWaiting();
  }

  stop(reason: DevServerStopReason): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state === 'exited' || this.state === 'stopped') return Promise.resolve();
    this.stopping ??= this.terminate(reason);
    return this.stopping;
  }

  logTail(lines = 4): string[] {
    return readTail(this.logPath, lines);
  }

  private async terminate(reason: DevServerStopReason): Promise<void> {
    this.stopReason = reason;
    const pid = this.child?.pid;
    if (pid === undefined) { this.finish('stopped'); return; }
    await terminateGroup(pid);
    await this.childExited;
    this.finish('stopped');
  }

  private beginWaiting(): void {
    this.endWaiting();
    this.probeTimer = setInterval(() => { void this.probeOnce(); }, this.probeMs);
    this.waitTimer = setTimeout(() => {
      if (this.state !== 'starting') return;
      this.endWaiting();
      this.setState('stalled');
    }, this.waitMs);
  }

  private endWaiting(): void {
    clearInterval(this.probeTimer);
    clearTimeout(this.waitTimer);
    this.probeTimer = this.waitTimer = undefined;
  }

  private async probeOnce(): Promise<void> {
    if (this.probing || this.state !== 'starting') return;
    this.probing = true;
    this.attempts += 1;
    this.emit('attempt', this.attempts);
    const up = await probePort(this.server.port);
    this.probing = false;
    if (up && this.state === 'starting') {
      this.endWaiting();
      this.setState('up');
    }
  }

  /** A terminal state: the process is gone, so timers and (unless its group is still being reaped) the pid record go with it. */
  private finish(state: 'exited' | 'stopped', opts: { keepRecord?: boolean } = {}): void {
    if (this.state === 'exited' || this.state === 'stopped') return;
    this.endWaiting();
    clearInterval(this.logTimer);
    if (!opts.keepRecord && this.child?.pid !== undefined) this.removeRecord(this.child.pid);
    this.setState(state);
  }

  /** Only our own record: a Start again on the same port may already have written its successor's. */
  private removeRecord(pid: number): void {
    try {
      if ((JSON.parse(readFileSync(this.pidPath, 'utf8')) as { pid?: unknown }).pid !== pid) return;
    } catch { /* missing or unreadable: nothing of ours to keep */ }
    rmSync(this.pidPath, { force: true });
  }

  private setState(state: DevServerState): void {
    this.state = state;
    this.emit('state', state);
  }
}

/**
 * Boot sweep: a crashed cezar leaves pid records behind, `<port>.pid.json` for each dev server and
 * `chromium.pid.json` for the task's browser. Kill only when the recorded pid is still the process
 * we started (an exactly matching start token), so a reused pid is never hit; a missing or
 * unreadable token means skip. A dev server's whole group goes; Chromium shares cezar's group, so
 * only its pid is signalled.
 * The record goes either way, except one `keep` claims: a server or browser the live host still runs.
 * Returns how many processes were killed.
 */
export async function sweepPreviewLeftovers(dataDir: string, opts: { keep?: (runId: string, what: number | 'browser') => boolean } = {}): Promise<number> {
  const root = join(dataDir, 'preview');
  if (!existsSync(root)) return 0;
  const kills: Promise<void>[] = [];
  for (const run of readdirSync(root, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    for (const file of readdirSync(join(root, run.name))) {
      if (!file.endsWith('.pid.json')) continue;
      const what = file === CHROMIUM_PID_FILE ? 'browser' : Number(file.slice(0, -'.pid.json'.length));
      if (opts.keep?.(run.name, what)) continue;
      const path = join(root, run.name, file);
      let record: unknown;
      try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable: nothing to kill */ }
      rmSync(path, { force: true });
      const { pid, pgid, startToken } = (record ?? {}) as { pid?: unknown; pgid?: unknown; startToken?: unknown };
      if (typeof pid !== 'number' || typeof startToken !== 'string') continue;
      // A dev server leads its own group. The token verifies the pid only, so a record naming
      // another group is not one cezar wrote, and that group is never signalled.
      if (what !== 'browser' && pgid !== pid) continue;
      // `recordedProcessLive` answers "alive" on any uncertainty; a kill needs an exact token match,
      // so a record without a token, or a pid whose token cannot be read now, is skipped.
      if (!recordedProcessLive({ pid, startToken }) || processStartToken(pid) !== startToken) continue;
      kills.push(what === 'browser' ? terminatePid(pid) : terminateGroup(pid));
    }
  }
  await Promise.all(kills);
  return kills.length;
}
