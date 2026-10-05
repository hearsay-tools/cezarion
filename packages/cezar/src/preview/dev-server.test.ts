import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processStartToken } from '../delegation/process-liveness.ts';
import { DevServer, probePort, sweepPreviewLeftovers, trimLog } from './dev-server.ts';

vi.mock('../delegation/process-liveness.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../delegation/process-liveness.ts')>();
  return { ...actual, processStartToken: vi.fn(actual.processStartToken) };
});

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-dev-server.mjs', import.meta.url));

let root: string;
let supervisors: DevServer[];
let strays: ChildProcess[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-devserver-'));
  supervisors = [];
  strays = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(supervisors.map(supervisor => supervisor.stop('release')));
  for (const stray of strays) { try { process.kill(-stray.pid!, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function fixtureCommand(args: string[]): string {
  return [process.execPath, FIXTURE, ...args].map(part => JSON.stringify(part)).join(' ');
}

function supervise(port: number, fixtureArgs: string[], opts: { probeMs?: number; waitMs?: number } = {}): DevServer {
  const server: PreviewServer = { port, command: fixtureCommand(['--port', String(port), ...fixtureArgs]), label: 'fake', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false };
  const supervisor = new DevServer({ server, worktreePath: root, dir: join(root, 'preview'), ...opts });
  supervisors.push(supervisor);
  return supervisor;
}

function stateChanges(supervisor: DevServer): string[] {
  const seen: string[] = [];
  supervisor.on('state', state => seen.push(state));
  return seen;
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('probePort', () => {
  it('is true for a listener on 127.0.0.1 and false for a closed port', async () => {
    const port = await freePort();
    expect(await probePort(port)).toBe(false);
    const listener = createServer().listen(port, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    expect(await probePort(port)).toBe(true);
    await new Promise(resolve => listener.close(resolve));
  });

  it('counts a listener on ::1 only (Vite resolving localhost to IPv6)', async () => {
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '::1', resolve));
    const { port } = listener.address() as { port: number };
    expect(await probePort(port)).toBe(true);
    await new Promise(resolve => listener.close(resolve));
  });
});

describe('DevServer', () => {
  it('goes starting -> up when the fixture listens after 300 ms', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--delay', '300'], { probeMs: 50 });
    const seen = stateChanges(supervisor);
    supervisor.start();
    expect(supervisor.state).toBe('starting');
    await until(() => supervisor.state === 'up');
    expect(seen).toEqual(['up']);
    expect(supervisor.attempts).toBeGreaterThan(1);
  });

  it('emits attempt on every probe', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--delay', '60000'], { probeMs: 30 });
    const attempts: number[] = [];
    supervisor.on('attempt', attempt => attempts.push(attempt));
    supervisor.start();
    await until(() => attempts.length >= 3);
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('counts a fixture listening on ::1 only as up', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--host', '::1'], { probeMs: 50 });
    supervisor.start();
    await until(() => supervisor.state === 'up');
  });

  it('goes starting -> stalled after waitMs, and keepWaiting returns to starting with a fresh window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const port = await freePort();
    const supervisor = supervise(port, ['--delay', '600000'], { probeMs: 2_000, waitMs: 10_000 });
    const seen = stateChanges(supervisor);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(supervisor.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.state).toBe('stalled');

    supervisor.keepWaiting();
    expect(supervisor.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(supervisor.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.state).toBe('stalled');
    expect(seen).toEqual(['stalled', 'starting', 'stalled']);
  });

  it('keepWaiting is a no-op outside stalled', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--delay', '60000']);
    supervisor.start();
    supervisor.keepWaiting();
    expect(supervisor.state).toBe('starting');
  });

  it('goes to exited with the exit code, and logTail returns the last lines', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--lines', '7', '--exit-code', '1'], { probeMs: 50 });
    supervisor.start();
    await until(() => supervisor.state === 'exited');
    expect(supervisor.exitCode).toBe(1);
    expect(supervisor.logTail()).toEqual(['fake-dev-server line 4', 'fake-dev-server line 5', 'fake-dev-server line 6', 'fake-dev-server line 7']);
    expect(supervisor.logTail(2)).toEqual(['fake-dev-server line 6', 'fake-dev-server line 7']);
  });

  it('reports a failed spawn as exited with the reason in the log', async () => {
    const port = await freePort();
    const server: PreviewServer = { port, command: 'true', cwd: 'missing', label: 'fake', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false };
    const supervisor = new DevServer({ server, worktreePath: root, dir: join(root, 'preview') });
    supervisors.push(supervisor);
    supervisor.start();
    await until(() => supervisor.state === 'exited');
    expect(supervisor.logTail().join('\n')).toMatch(/ENOENT/);
  });

  it('closes stdin: a fixture that reads it gets EOF and exits', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--stdin-eof'], { probeMs: 50 });
    supervisor.start();
    await until(() => supervisor.state === 'exited');
    expect(supervisor.exitCode).toBe(0);
    expect(supervisor.logTail()).toContain('stdin-eof');
  });

  it('runs in its own process group and writes a pid record that stop removes', async () => {
    const port = await freePort();
    const supervisor = supervise(port, [], { probeMs: 50 });
    supervisor.start();
    await until(() => supervisor.state === 'up');
    const recordPath = join(root, 'preview', `${port}.pid.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { pid: number; pgid: number; startToken?: string };
    expect(record.pgid).toBe(record.pid);
    expect(record.startToken).toBe(processStartToken(record.pid));
    expect(record.pid).not.toBe(process.pid);
    await supervisor.stop('user');
    expect(existsSync(recordPath)).toBe(false);
  });

  it('stop("user") on a command that forks a port-holding child frees the port within 6 s', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--fork'], { probeMs: 50 });
    const seen = stateChanges(supervisor);
    supervisor.start();
    await until(() => supervisor.state === 'up');
    expect(await probePort(port)).toBe(true);
    await supervisor.stop('user');
    expect(supervisor.state).toBe('stopped');
    expect(seen).toEqual(['up', 'stopped']);
    const deadline = Date.now() + 6_000;
    while (await probePort(port)) {
      if (Date.now() > deadline) throw new Error('port still held after stop');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }, 15_000);

  it('runs the command in the curated env: host secrets and session authority stay out (#427)', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_leak');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-leak');
    vi.stubEnv('CEZ_TOOL_TOKEN', 'tool-leak');
    vi.stubEnv('CEZ_ENV_PASSTHROUGH', 'MY_DEV_FLAG');
    vi.stubEnv('MY_DEV_FLAG', 'kept');
    try {
      const port = await freePort();
      const command = 'echo "gh=${GITHUB_TOKEN:-unset} ant=${ANTHROPIC_API_KEY:-unset} tool=${CEZ_TOOL_TOKEN:-unset} flag=${MY_DEV_FLAG:-unset} path=${PATH:+set}"';
      const server: PreviewServer = { port, command, label: 'fake', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false };
      const supervisor = new DevServer({ server, worktreePath: root, dir: join(root, 'preview') });
      supervisors.push(supervisor);
      supervisor.start();
      await until(() => supervisor.state === 'exited');
      expect(supervisor.logTail()).toEqual(['gh=unset ant=unset tool=unset flag=kept path=set']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a leader that exits on its own takes its SIGTERM-ignoring holder with it, and keeps the pid record until the group is gone', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--fork', '--leader-exits', '--ignore-term'], { probeMs: 50 });
    supervisor.start();
    const recordPath = join(root, 'preview', `${port}.pid.json`);
    await until(() => supervisor.state === 'exited');
    expect(supervisor.exitCode).toBe(3);
    expect(existsSync(recordPath)).toBe(true);
    await supervisor.stop('user');
    expect(existsSync(recordPath)).toBe(false);
    expect(await probePort(port)).toBe(false);
  }, 15_000);

  it('Start again shows only the new run in the log tail', async () => {
    const port = await freePort();
    const first = supervise(port, ['--lines', '3', '--exit-code', '1'], { probeMs: 50 });
    first.start();
    await until(() => first.state === 'exited');
    const again = supervise(port, ['--exit-code', '2'], { probeMs: 50 });
    again.start();
    await until(() => again.state === 'exited');
    expect(again.logTail()).toEqual([]);
  });

  it('stop is idempotent and safe after the process exited by itself', async () => {
    const port = await freePort();
    const supervisor = supervise(port, ['--exit-code', '2'], { probeMs: 50 });
    supervisor.start();
    await until(() => supervisor.state === 'exited');
    await supervisor.stop('release');
    await supervisor.stop('release');
    expect(supervisor.state).toBe('exited');
  });
});

describe('trimLog', () => {
  it('keeps the last 1 MiB once the log passes 5 MiB', () => {
    const path = join(root, 'big.log');
    const head = Buffer.alloc(5 * 1024 * 1024 + 10, 'a');
    writeFileSync(path, Buffer.concat([head, Buffer.from('THE-END\n')]));
    trimLog(path);
    const kept = readFileSync(path);
    expect(kept.length).toBe(1024 * 1024);
    expect(kept.toString('utf8').endsWith('THE-END\n')).toBe(true);
  });

  it('leaves a log at or under 5 MiB alone', () => {
    const path = join(root, 'small.log');
    writeFileSync(path, Buffer.alloc(5 * 1024 * 1024, 'a'));
    trimLog(path);
    expect(statSync(path).size).toBe(5 * 1024 * 1024);
  });
});

describe('sweepPreviewLeftovers', () => {
  function strayFixture(): ChildProcess {
    const child = spawn(process.execPath, [FIXTURE, '--port', '0', '--delay', '600000'], { detached: true, stdio: 'ignore' });
    strays.push(child);
    return child;
  }
  const exited = (child: ChildProcess) => new Promise<void>(resolve => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));

  function writeRecord(dataDir: string, runId: string, port: number, record: unknown): string {
    const dir = join(dataDir, 'preview', runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${port}.pid.json`);
    writeFileSync(path, JSON.stringify(record));
    return path;
  }

  it('kills a live recorded group and deletes the record', async () => {
    const child = strayFixture();
    const pid = child.pid!;
    const record = writeRecord(root, 'run-a', 5173, { pid, pgid: pid, startToken: processStartToken(pid) });
    expect(await sweepPreviewLeftovers(root)).toBe(1);
    await exited(child);
    expect(existsSync(record)).toBe(false);
  });

  it('never kills a group the live host still owns, and keeps its record (#781 review)', async () => {
    const child = strayFixture();
    const pid = child.pid!;
    const record = writeRecord(root, 'run-live', 5179, { pid, pgid: pid, startToken: processStartToken(pid) });
    const keep = vi.fn((runId: string, port: number | 'browser') => runId === 'run-live' && port === 5179);
    expect(await sweepPreviewLeftovers(root, { keep })).toBe(0);
    expect(keep).toHaveBeenCalledWith('run-live', 5179);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(record)).toBe(true);
  });

  it('skips a record whose startToken differs (a reused pid) but still deletes it', async () => {
    const child = strayFixture();
    const pid = child.pid!;
    const record = writeRecord(root, 'run-b', 5174, { pid, pgid: pid, startToken: 'some-other-incarnation' });
    expect(await sweepPreviewLeftovers(root)).toBe(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(record)).toBe(false);
  });

  it('skips a live pid whose record has no startToken, but deletes the record', async () => {
    const child = strayFixture();
    const pid = child.pid!;
    const record = writeRecord(root, 'run-d', 5177, { pid, pgid: pid });
    expect(await sweepPreviewLeftovers(root)).toBe(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(record)).toBe(false);
  });

  it('skips a live pid whose current start token cannot be read, but deletes the record', async () => {
    const child = strayFixture();
    const pid = child.pid!;
    const record = writeRecord(root, 'run-e', 5178, { pid, pgid: pid, startToken: processStartToken(pid) });
    vi.mocked(processStartToken).mockReturnValue(undefined);
    try {
      expect(await sweepPreviewLeftovers(root)).toBe(0);
    } finally {
      vi.mocked(processStartToken).mockRestore();
    }
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(record)).toBe(false);
  });

  it('skips a record whose pgid is not its verified pid, but deletes it', async () => {
    const child = strayFixture();
    const pid = child.pid!;
    const other = strayFixture();
    const record = writeRecord(root, 'run-f', 5180, { pid, pgid: other.pid!, startToken: processStartToken(pid) });
    expect(await sweepPreviewLeftovers(root)).toBe(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
    expect(existsSync(record)).toBe(false);
  });

  it('deletes the record of a dead process and a malformed record, killing nothing', async () => {
    const dead = writeRecord(root, 'run-c', 5175, { pid: 2_147_483_000, pgid: 2_147_483_000, startToken: 'x' });
    const malformed = writeRecord(root, 'run-c', 5176, 'not an object');
    expect(await sweepPreviewLeftovers(root)).toBe(0);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(malformed)).toBe(false);
  });

  describe("a task's Chromium (chromium.pid.json)", () => {
    // Chromium is not detached: it shares cezar's process group, so only its pid may be signalled.
    function strayBrowser(): ChildProcess {
      const child = spawn(process.execPath, [FIXTURE, '--port', '0', '--delay', '600000'], { stdio: 'ignore' });
      strays.push(child);
      return child;
    }
    function writeBrowserRecord(runId: string, record: unknown): string {
      const dir = join(root, 'preview', runId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'chromium.pid.json');
      writeFileSync(path, JSON.stringify(record));
      return path;
    }

    it('kills the recorded pid, never its group, and deletes the record', async () => {
      const child = strayBrowser();
      const pid = child.pid!;
      const record = writeBrowserRecord('run-h', { pid, startToken: processStartToken(pid) });
      expect(await sweepPreviewLeftovers(root)).toBe(1);
      await exited(child);
      expect(existsSync(record)).toBe(false);
    });

    it('spares a browser the live host owns, and keeps its record', async () => {
      const child = strayBrowser();
      const pid = child.pid!;
      const record = writeBrowserRecord('run-i', { pid, startToken: processStartToken(pid) });
      const keep = vi.fn((runId: string, what: number | 'browser') => runId === 'run-i' && what === 'browser');
      expect(await sweepPreviewLeftovers(root, { keep })).toBe(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(existsSync(record)).toBe(true);
    });

    it('skips a reused pid (another start token) but deletes the record', async () => {
      const child = strayBrowser();
      const pid = child.pid!;
      const record = writeBrowserRecord('run-j', { pid, startToken: 'another-incarnation' });
      expect(await sweepPreviewLeftovers(root)).toBe(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(existsSync(record)).toBe(false);
    });
  });

  it('returns 0 when there is no preview directory', async () => {
    expect(await sweepPreviewLeftovers(join(root, 'absent'))).toBe(0);
  });
});
