import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, truncateSync, appendFileSync, writeFileSync, fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { processStartToken, recordedProcessLive } from '../delegation/process-liveness.ts';

/**
 * Supervisor for one cezar-owned dev server (#781, spec 2026-10-02-live-preview-v1): spawn the
 * registered command in its own process group, TCP-probe until the port answers, and kill the
 * whole group on stop so a command that forks (`npm` -> `node` -> `vite`) frees its port.
 */

export const PREVIEW_PORT_WAIT_MS = 2 * 60_000;
export const PREVIEW_PROBE_MS = 2_000;
const PROBE_CONNECT_MS = 500;
const KILL_GRACE_MS = 5_000;
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

/** SIGTERM the group, SIGKILL whatever is still there after the grace period. */
async function terminateGroup(pgid: number): Promise<void> {
  if (!signalGroup(pgid, 'SIGTERM')) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(50);
  if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL');
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
    trimLog(this.logPath);
    const logFd = openSync(this.logPath, 'a');
    const cwd = resolve(this.worktreePath, this.server.cwd ?? '.');
    // stdin is closed: nobody can answer a prompt from the cockpit, so one fails fast into `exited` with its log.
    const child = process.platform === 'win32'
      ? spawn(this.server.command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', logFd, logFd] })
      : spawn('/bin/sh', ['-c', this.server.command], { cwd, detached: true, stdio: ['ignore', logFd, logFd] });
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
        // A leader that dies on its own can leave a forked server holding the port.
        if (!this.stopping && child.pid !== undefined) signalGroup(child.pid, 'SIGTERM');
        this.finish(this.stopping ? 'stopped' : 'exited');
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

  /** A terminal state: the process is gone, so timers and the pid record go with it. */
  private finish(state: 'exited' | 'stopped'): void {
    if (this.state === 'exited' || this.state === 'stopped') return;
    this.endWaiting();
    clearInterval(this.logTimer);
    rmSync(this.pidPath, { force: true });
    this.setState(state);
  }

  private setState(state: DevServerState): void {
    this.state = state;
    this.emit('state', state);
  }
}

/**
 * Boot sweep: a crashed cezar leaves pid records behind. Kill a record's group only when its
 * leader is still the process we started (pid AND start token), so a reused pid is never hit.
 * The record goes either way. Returns how many groups were killed.
 */
export async function sweepPreviewLeftovers(dataDir: string): Promise<number> {
  const root = join(dataDir, 'preview');
  if (!existsSync(root)) return 0;
  const kills: Promise<void>[] = [];
  for (const run of readdirSync(root, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    for (const file of readdirSync(join(root, run.name))) {
      if (!file.endsWith('.pid.json')) continue;
      const path = join(root, run.name, file);
      let record: unknown;
      try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable: nothing to kill */ }
      rmSync(path, { force: true });
      const { pid, pgid, startToken } = (record ?? {}) as { pid?: unknown; pgid?: unknown; startToken?: unknown };
      if (typeof pid !== 'number' || typeof pgid !== 'number' || (startToken !== undefined && typeof startToken !== 'string')) continue;
      if (!recordedProcessLive({ pid, ...(startToken !== undefined ? { startToken } : {}) })) continue;
      kills.push(terminateGroup(pgid));
    }
  }
  await Promise.all(kills);
  return kills.length;
}
