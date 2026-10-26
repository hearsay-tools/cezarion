import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  groupExists, groupRunning, leaderRunning, processStartToken, startAndForget, startOwnedGroup, stopGroup, watchGroup,
  type GroupLeader,
} from './detached-process.ts';

/**
 * The Process exits cases (AGENTS.md § Case tables) against the one helper that starts detached
 * processes (hearsay-tools/cezarion#1717, hearsay-tools/cezarion#1815). Every case runs real
 * process groups: a leader started through the helper, and the members it forks.
 */

// The Windows cases stand in for `taskkill`; every other spawnSync runs as it is.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const hostPlatform = process.platform;
const posix = hostPlatform !== 'win32';
const linux = hostPlatform === 'linux';

let dir: string;
let strays: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-detached-process-'));
  strays = [];
});

afterEach(() => {
  for (const pid of strays) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, what: string): Promise<void> {
  // bound: hang guard only; each condition is a process the test started, which takes well under a second.
  const deadline = performance.now() + 20_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (!linux) return true;
  // A zombie still answers signal 0 until its parent reaps it.
  try { return !/^[ZX]$/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim().split(/\s+/)[0]!); }
  catch { return false; }
}

/** The pid a fixture script wrote to `name`, once it is there. */
async function pidFrom(name: string): Promise<number> {
  const file = join(dir, name);
  await until(() => existsSync(file) && readFileSync(file, 'utf8').endsWith('\n'), `${name} to be written`);
  return Number(readFileSync(file, 'utf8').trim());
}

/** A Node script as `-e` code: `out` names a file in the test directory. */
const script = (body: string) => ['-e', `const out = (name) => require('node:path').join(${JSON.stringify(dir)}, name); ${body}`];
const IDLE = 'setInterval(() => {}, 1000);';
/** A member that ignores SIGTERM. It records its pid only once its handler is in place. */
const MEMBER = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], process.pid + '\\n'); ${IDLE}`;
/** Forks MEMBER into the leader's group, writing `member.pid`. */
const STUBBORN_MEMBER = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(MEMBER)}, out('member.pid')], { stdio: 'ignore' });`;
/** The leader exits once its member is ready, so the member outlives it. */
const EXIT_WHEN_MEMBER_READY = "setInterval(() => { if (require('node:fs').existsSync(out('member.pid'))) process.exit(0); }, 20);";

async function startLeader(body: string, options: Parameters<typeof startOwnedGroup>[2] = {}): Promise<{ child: ChildProcess; leader: GroupLeader }> {
  const started = await startOwnedGroup(process.execPath, script(body), { stdio: 'ignore', ...options });
  strays.push(started.leader.pid);
  return started;
}

describe.runIf(posix)('startOwnedGroup', () => {
  it('starts the leader of its own process group and records its start identity', async () => {
    const { child, leader } = await startLeader(IDLE);
    expect(leader.pid).toBe(child.pid);
    expect(leader.start).toBe(processStartToken(leader.pid));
    expect(groupRunning(leader)).toBe(true);
    expect(leaderRunning(leader)).toBe(true);
  });

  it('rejects a command that cannot start', async () => {
    await expect(startOwnedGroup(join(dir, 'missing-command'), [], { stdio: 'ignore' })).rejects.toThrow(/ENOENT/);
  });

  it('stops the whole group and throws when the start identity cannot be read', async () => {
    let leaderPid = 0;
    // Unreadable only once the leader has forked its member, so only a stop of the whole group ends both.
    const readStart = (pid: number): undefined => {
      leaderPid = pid;
      const file = join(dir, 'member.pid');
      // bound: hang guard only; the leader writes the file as its first statement.
      const deadline = performance.now() + 20_000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(file) && performance.now() < deadline) Atomics.wait(sleeper, 0, 0, 20);
      return undefined;
    };
    await expect(startOwnedGroup(process.execPath, script(STUBBORN_MEMBER + IDLE), { stdio: 'ignore', readStart, requireStart: true }))
      .rejects.toThrow(/^cannot read the start identity of pid \d+$/);
    expect(leaderPid).toBeGreaterThan(0);
    strays.push(leaderPid);
    const member = await pidFrom('member.pid');
    strays.push(member);
    await until(() => !alive(member) && !alive(leaderPid), 'the group to end');
  });

  it('keeps a process whose start identity cannot be read when the caller does not require one', async () => {
    const { leader } = await startLeader(IDLE, { readStart: () => undefined });
    expect(leader.start).toBeUndefined();
    expect(alive(leader.pid)).toBe(true);
  });
});

describe.runIf(posix)('stopGroup', () => {
  it('stops a running group with SIGTERM', async () => {
    const { leader } = await startLeader(IDLE);
    expect(await stopGroup(leader, { graceMs: 20_000 })).toBe(true);
    // Stopped means no member runs; this test process reaps its own child's zombie on a later turn.
    expect(groupRunning(leader)).toBe(false);
  });

  it('kills a member that ignores SIGTERM and outlives its leader', async () => {
    const { leader } = await startLeader(STUBBORN_MEMBER + EXIT_WHEN_MEMBER_READY);
    const member = await pidFrom('member.pid');
    strays.push(member);
    await until(() => !alive(leader.pid), 'the leader to exit');
    expect(groupRunning(leader)).toBe(true);
    expect(await stopGroup(leader, { graceMs: 200 })).toBe(true);
    await until(() => !alive(member), 'the stubborn member to exit');
  });

  it.runIf(linux)('treats a group of zombies only as stopped, while other processes start and exit', async () => {
    // `true` stays in the group as a zombie: the shell that forked it becomes `sleep` in a session of
    // its own, which never reaps it.
    const { leader } = await startLeader(`const sh = require('node:child_process').spawn('sh', ['-c', 'true & exec setsid sleep 1000'], { stdio: 'ignore' });
require('node:fs').writeFileSync(out('sleeper.pid'), sh.pid + '\\n'); ${IDLE}`);
    const sleeper = await pidFrom('sleeper.pid');
    strays.push(sleeper);
    const states = () => readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const fields = readFileSync(`/proc/${name}/stat`, 'utf8').split(')').at(-1)!.trim().split(/\s+/);
        return Number(fields[2]) === leader.pid ? [fields[0]!] : [];
      } catch { return []; }
    });
    await until(() => states().includes('Z'), 'a zombie in the group');
    // A busy host: the process list changes while the stop scans it (CI run 40158867000 attempt 1,
    // job 121065993069). Without it the scans of a quiet host hide the race.
    const churn = spawn('sh', ['-c', 'while :; do /bin/true; done'], { stdio: 'ignore' });
    try {
      expect(await stopGroup(leader, { graceMs: 300 })).toBe(true);
    } finally {
      churn.kill('SIGKILL');
    }
    expect(states().filter((state) => state !== 'Z')).toEqual([]);
  });

  it('never signals a live process whose start identity differs from the record: a reused or forged pid', async () => {
    const { leader: other } = await startLeader(IDLE);
    const forged: GroupLeader = { pid: other.pid, start: `${other.start}-forged` };
    expect(groupExists(forged)).toBe(false);
    expect(await stopGroup(forged, { graceMs: 200 })).toBe(true);
    expect(alive(other.pid)).toBe(true);
  });

  it('never signals a live leader whose start identity cannot be read now: its pid may lead another group', async () => {
    const { leader } = await startLeader(IDLE);
    const unreadable = () => undefined;
    expect(groupExists(leader, unreadable)).toBe(true);
    expect(await stopGroup(leader, { graceMs: 200, readStart: unreadable })).toBe(false);
    expect(alive(leader.pid)).toBe(true);
  });

  it('never signals a leader whose start identity was not recorded: its pid may name another process', async () => {
    const { leader } = await startLeader(IDLE);
    const unrecorded: GroupLeader = { pid: leader.pid };
    expect(leaderRunning(unrecorded)).toBe(false);
    expect(await stopGroup(unrecorded, { graceMs: 200 })).toBe(false);
    expect(alive(leader.pid)).toBe(true);
  });
});

/** A leader whose main thread exits while another thread keeps a listening port: `/proc` reads it Z. */
const THREAD_HOLDS_PORT = [
  'import ctypes, os, signal, socket, sys, threading, time',
  'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
  "s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen()",
  'threading.Thread(target=lambda: time.sleep(60)).start()',
  "open(os.path.join(sys.argv[1], 'thread.port'), 'w').write('%d\\n' % s.getsockname()[1])",
  'ctypes.CDLL(None).pthread_exit(None)',
].join('\n');
const python = linux && spawnSync('python3', ['-I', '-c', 'import ctypes'], { stdio: 'ignore' }).status === 0;

/** Whether anything accepts a connection on `port` at 127.0.0.1. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

describe.runIf(python)('stopGroup and a leader whose main thread exited', () => {
  it('counts it running while another thread holds its port, and stops it only once the port is free', async () => {
    const started = await startOwnedGroup('python3', ['-I', '-c', THREAD_HOLDS_PORT, dir], { stdio: 'ignore' });
    strays.push(started.leader.pid);
    const port = await pidFrom('thread.port');
    await until(() => readFileSync(`/proc/${started.leader.pid}/stat`, 'utf8').split(')').at(-1)!.trim().startsWith('Z'), 'the main thread to exit');
    expect(groupRunning(started.leader)).toBe(true);
    expect(await stopGroup(started.leader, { graceMs: 200, killWaitMs: 20_000 })).toBe(true);
    expect(await answers(port)).toBe(false);
  });
});

describe.runIf(posix)('stopGroup with the leader\'s handle', () => {
  const unreadable = () => undefined;

  it('stops a leader this process holds, though its start identity cannot be read', async () => {
    const { child, leader } = await startLeader(IDLE);
    const held: GroupLeader = { pid: leader.pid, child };
    expect(groupExists(held, unreadable)).toBe(true);
    expect(await stopGroup(held, { graceMs: 20_000, readStart: unreadable })).toBe(true);
    expect(alive(leader.pid)).toBe(false);
  });

  it('stops what is left of the group once Node reaped its leader, a member that ignores SIGTERM included', async () => {
    const { child, leader } = await startLeader(STUBBORN_MEMBER + EXIT_WHEN_MEMBER_READY);
    const member = await pidFrom('member.pid');
    strays.push(member);
    await until(() => child.exitCode !== null, 'Node to reap the leader');
    const reaped: GroupLeader = { pid: leader.pid, child };
    expect(groupRunning(reaped, unreadable)).toBe(true);
    expect(await stopGroup(reaped, { graceMs: 200, readStart: unreadable })).toBe(true);
    await until(() => !alive(member), 'the stubborn member to exit');
  });

  it('never signals a live process at the pid of a reaped leader: the pid names another process now', async () => {
    const { leader: other } = await startLeader(IDLE);
    const reaped = { pid: other.pid, child: { exitCode: 0, signalCode: null } as ChildProcess };
    expect(groupExists(reaped, unreadable)).toBe(false);
    expect(await stopGroup(reaped, { graceMs: 200, readStart: unreadable })).toBe(true);
    expect(alive(other.pid)).toBe(true);
  });
});

describe.runIf(posix)('startAndForget', () => {
  it('starts the leader of its own process group and reports it started', async () => {
    expect(await startAndForget(process.execPath, script(`require('node:fs').writeFileSync(out('forgotten.pid'), process.pid + '\\n'); ${IDLE}`))).toBe(true);
    const pid = await pidFrom('forgotten.pid');
    strays.push(pid);
    // Its own group: signal 0 to the group its pid names reaches it.
    expect(() => process.kill(-pid, 0)).not.toThrow();
  });

  it('reports a command that cannot start', async () => {
    expect(await startAndForget(join(dir, 'no-such-binary'), [])).toBe(false);
  });

  it('keeps nothing alive: its caller exits while the process runs and before the settle window ends', async () => {
    const helper = new URL('./detached-process.ts', import.meta.url).href;
    const child = `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'forgotten.pid'))}, process.pid + '\\n'); ${IDLE}`;
    const caller = `const { startAndForget } = await import(${JSON.stringify(helper)});
startAndForget(process.execPath, ['-e', ${JSON.stringify(child)}], { settleMs: 600_000 });`;
    // bound: hang guard only; a caller that waited for the 600 s window or the child would hit it.
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', caller], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    const pid = await pidFrom('forgotten.pid');
    strays.push(pid);
    expect(alive(pid)).toBe(true);
  });
});

describe.runIf(posix)('watchGroup', () => {
  it('leaves the group to its starter, then stops it once the starter dies during boot', async () => {
    const starter = spawn(process.execPath, ['-e', IDLE], { stdio: 'ignore' });
    strays.push(starter.pid!);
    const { leader } = await startLeader(IDLE);
    let asked = 0;
    // The handle the starter writes once the boot finishes: an interrupted boot never writes it.
    const watching = watchGroup({
      leader, intervalMs: 50, starter: { pid: starter.pid!, start: processStartToken(starter.pid!) },
      decide: () => { asked += 1; return existsSync(join(dir, 'descriptor')) ? undefined : { reason: 'unowned' }; },
    });
    await delay(300); // bound: proves a negative; six polls while the starter runs must decide nothing.
    expect(asked).toBe(0);
    expect(alive(leader.pid)).toBe(true);
    starter.kill('SIGKILL');
    expect(await watching).toBe('unowned');
    expect(groupRunning(leader)).toBe(false);
  });

  it('stops the group once its handle is deleted, and settles the verdict after the stop', async () => {
    const handle = join(dir, 'descriptor');
    writeFileSync(handle, '{}');
    const { leader } = await startLeader(IDLE);
    const settled: boolean[] = [];
    const watching = watchGroup({
      leader, intervalMs: 50,
      decide: () => existsSync(handle) ? undefined : { reason: 'handle deleted', settle: (stopped) => { settled.push(stopped, groupRunning(leader)); } },
    });
    rmSync(handle);
    expect(await watching).toBe('handle deleted');
    expect(settled).toEqual([true, false]);
  });

  it('stops what is left of a group whose leader exited on its own', async () => {
    const { leader } = await startLeader(STUBBORN_MEMBER + EXIT_WHEN_MEMBER_READY);
    const member = await pidFrom('member.pid');
    strays.push(member);
    const watching = watchGroup({ leader, intervalMs: 50, stop: { graceMs: 200 }, decide: () => undefined });
    expect(await watching).toBe('exited');
    await until(() => !alive(member), 'the member the leader left behind to exit');
  });
});

describe.runIf(posix)('on Windows', () => {
  // The host's own identity reader: the cases test the helper's Windows branches, not the reader.
  const readStart = (pid: number) => processStartToken(pid, hostPlatform);
  let taskkills: number[];

  beforeEach(async () => {
    taskkills = [];
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    // `taskkill /pid N /t /f` ends a process tree; a SIGKILL of the group is its stand-in here.
    vi.mocked(spawnSync).mockImplementation(((file: string, args: readonly string[], options: object) => {
      if (file !== 'taskkill') return actual.spawnSync(file, args, options);
      const pid = Number(args[1]);
      taskkills.push(pid);
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      return { pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null };
    }) as typeof spawnSync);
  });

  afterEach(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
  });

  /** Runs `body` as the helper sees a Windows host. The leaders start before it, on the host. */
  async function asWindows<T>(body: () => Promise<T> | T): Promise<T> {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try { return await body(); }
    finally { Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true }); }
  }

  it('ends the recorded leader\'s process tree', async () => {
    const { leader } = await startLeader(IDLE);
    expect(await asWindows(() => groupExists(leader, readStart))).toBe(true);
    expect(await asWindows(() => stopGroup(leader, { readStart }))).toBe(true);
    expect(taskkills).toEqual([leader.pid]);
    expect(alive(leader.pid)).toBe(false);
  });

  it('never ends the tree of a pid whose start identity differs from the record: a reused or forged pid', async () => {
    const { leader: other } = await startLeader(IDLE);
    const forged: GroupLeader = { pid: other.pid, start: `${other.start}-forged` };
    expect(await asWindows(() => groupExists(forged, readStart))).toBe(false);
    expect(await asWindows(() => stopGroup(forged, { readStart }))).toBe(true);
    expect(taskkills).toEqual([]);
    expect(alive(other.pid)).toBe(true);
  });

  it('never ends the tree of a leader whose start identity was not recorded', async () => {
    const { leader } = await startLeader(IDLE);
    expect(await asWindows(() => stopGroup({ pid: leader.pid }, { readStart }))).toBe(false);
    expect(taskkills).toEqual([]);
    expect(alive(leader.pid)).toBe(true);
  });

  it('leaves a process whose start identity cannot be read, and does not report it stopped', async () => {
    const { leader } = await startLeader(IDLE);
    const unreadable = () => undefined;
    expect(await asWindows(() => groupExists(leader, unreadable))).toBe(true);
    expect(await asWindows(() => stopGroup(leader, { readStart: unreadable }))).toBe(false);
    expect(taskkills).toEqual([]);
    expect(alive(leader.pid)).toBe(true);
  });

  it('ends the tree of a leader this process holds, with no start identity', async () => {
    const { child, leader } = await startLeader(IDLE);
    expect(await asWindows(() => stopGroup({ pid: leader.pid, child }, { readStart: () => undefined }))).toBe(true);
    expect(taskkills).toEqual([leader.pid]);
    expect(alive(leader.pid)).toBe(false);
  });

  it('never ends the tree of a live process at the pid of a reaped leader', async () => {
    const { leader: other } = await startLeader(IDLE);
    const reaped = { pid: other.pid, child: { exitCode: 0, signalCode: null } as ChildProcess };
    expect(await asWindows(() => stopGroup(reaped, { readStart }))).toBe(true);
    expect(taskkills).toEqual([]);
    expect(alive(other.pid)).toBe(true);
  });
});
