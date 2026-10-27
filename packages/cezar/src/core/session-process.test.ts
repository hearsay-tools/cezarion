import { EventEmitter } from 'node:events';
import { execFile, execFileSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));

vi.mock('./runner-runtime.ts', async (original) => ({
  ...await original<typeof import('./runner-runtime.ts')>(),
  KILL_GRACE_MS: 100,
}));

import { leaderState, probeLeaderState, psLeaderState, forwardToSessionGroups, procStatExited, sessionGroupOf, signalSession, spawnSessionLeader } from './session-process.ts';
import { requirePid } from '../pid-file.testkit.ts';

/** A zombie has exited; only its reaper's wait remains. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z';
  } catch { return false; }
}

const IGNORES_TERM = "process.on('SIGTERM',()=>{}); setTimeout(()=>{},20000)";
const DEFAULT_TERM = 'setTimeout(()=>{},20000)';
/** Ignores SIGTERM, leaving a receipt in its cwd that it got one. */
const TERM_RECEIPT = "process.on('SIGTERM',()=>{require('fs').writeFileSync('member.term','')}); setTimeout(()=>{},20000)";

/** A leader that starts one member in its cwd, then stays or exits. The member publishes its pid
 * once its signal handlers are in place, and an exiting leader waits for that, so no signal the
 * leader's exit sets off can reach the member first. */
function leaderScript(member: string, opts: { detached?: boolean; exit?: boolean } = {}): string {
  const published = `${member}; const fs = require('fs'); fs.writeFileSync('member.pid.tmp', String(process.pid)); fs.renameSync('member.pid.tmp', 'member.pid');`;
  // The exiting leader's hang guard: it exits 3 if the member never reports.
  return `const { spawn } = require('child_process');
const m = spawn(process.execPath, ['-e', ${JSON.stringify(published)}], { stdio: 'ignore', detached: ${!!opts.detached} });
${opts.exit ? "m.unref(); setTimeout(() => process.exit(3), 15000); setInterval(() => { if (require('fs').existsSync('member.pid')) process.exit(0); }, 10);" : "console.log('ready'); setTimeout(()=>{},20000);"}`;
}

// A crashed leader closes its sockets inside do_exit(), before it is a zombie: the runner can
// see the connection drop and stop the session in that window (OpenCode, harness row S19).
describe('procStatExited (hearsay-tools/cezarion#890)', () => {
  const stat = (state: string, flags: number) => `1234 (node (x) y) ${state} 1 1234 1234 0 -1 ${flags} 0 0 0 0 0 0 0 0 20 0 1 0 5555 0 0`;
  it('reads a zombie, or a task already in do_exit (PF_EXITING), as exited', () => {
    expect(procStatExited(stat('Z', 0x400100))).toBe(true);
    expect(procStatExited(stat('S', 0x400104))).toBe(true);
    expect(procStatExited(stat('D', 0x404044))).toBe(true);
  });
  it('reads a running or sleeping task as alive, and an unparsable line as alive', () => {
    expect(procStatExited(stat('S', 0x400100))).toBe(false);
    expect(procStatExited(stat('R', 0x400040))).toBe(false);
    expect(procStatExited('1234 (node) S')).toBe(false);
  });
});

describe('leader exit evidence (hearsay-tools/cezarion#1899)', () => {
  const child = () => Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null }) as ChildProcess;
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function mockPs(stdout: string, error: Error | null = null, stderr = '') {
    const probe = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess;
    const run = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(error, stdout, stderr);
      return probe;
    }) as typeof childProcess.execFile);
    return { run, probe };
  }

  it('accepts an observed exit or a missing process, including without proc support', () => {
    expect(leaderState({ ...child(), exitCode: 143 } as ChildProcess)).toBe('exited');
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(leaderState(child(), 'win32')).toBe('exited');
  });

  it('does not infer exit or liveness from an unavailable PID or denied process probe', () => {
    expect(leaderState({ ...child(), pid: undefined } as unknown as ChildProcess)).toBe('unknown');
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(leaderState(child(), 'win32')).toBe('unknown');
  });

  it.each(['EACCES', 'ENOENT'])('keeps unknown evidence when proc cannot be read (%s)', code => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw Object.assign(new Error('unavailable'), { code }); });
    expect(leaderState(child(), 'linux')).toBe('unknown');
  });

  it.each([
    ['123456 (node) Z 1 123456 123456 0 -1 0', 'exited'],
    ['123456 (node) D 1 123456 123456 0 -1 4', 'exited'],
    ['123456 (node) S 1 123456 123456 0 -1 0', 'live'],
    ['123456 (node) X 1 123456 123456 0 -1 0', 'exited'],
    ['123456 (node) ? 1 123456 123456 0 -1 0', 'unknown'],
    ['999999 (node) S 1 123456 123456 0 -1 0', 'unknown'],
    ['123456 (node) S 1 123456 123456 0 -1 999999999999999999999', 'unknown'],
    ['unparseable', 'unknown'],
  ] as const)('requires positive process-state evidence: %s', (stat, expected) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(stat);
    expect(leaderState(child(), 'linux')).toBe(expected);
  });

  it.each([
    ['Z', 'exited'], ['Z+', 'exited'], ['Zs', 'exited'], ['E', 'exited'], ['E+', 'exited'],
    ['S', 'live'], ['R+', 'live'], ['T', 'live'], ['', 'unknown'], ['STAT', 'unknown'],
    ['ZOMBIE', 'unknown'], ['ERROR: denied', 'unknown'], ['R\nZ', 'unknown'],
  ] as const)('Darwin requires one positive ps state: %s', (stdout, expected) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const { run } = mockPs(stdout);
    expect(probeLeaderState(child(), 50, 'darwin')()).toBe(expected);
    expect(run).toHaveBeenCalledWith('ps', ['-o', 'stat=', '-p', '123456'],
      { encoding: 'utf8', timeout: 50, killSignal: 'SIGKILL', maxBuffer: 128 }, expect.any(Function));
  });

  it.each([
    [1, ''], [1, 'Z'], ['ETIMEDOUT', 'Z'], ['ENOENT', ''], ['EACCES', 'Z'],
  ])('Darwin keeps cleanup on unavailable ps evidence: %s %s', (code, stdout) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    mockPs(String(stdout), Object.assign(new Error('unavailable'), { code }));
    expect(probeLeaderState(child(), 50, 'darwin')()).toBe('unknown');
  });

  it('Darwin keeps cleanup when starting the ps probe throws', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.spyOn(childProcess, 'execFile').mockImplementation(() => { throw new Error('probe unavailable'); });
    expect(probeLeaderState(child(), 50, 'darwin')()).toBe('unknown');
  });

  it.each(['T', 'Sl', 'R+'])('Linux fallback preserves live evidence with unreadable proc: %s', state => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('unreadable'); });
    mockPs(state);
    expect(probeLeaderState(child(), 50, 'linux')()).toBe('live');
  });

  it('rejects contradictory ps diagnostics and contradictory live proc/exited ps', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    mockPs('T', null, 'permission denied');
    expect(probeLeaderState(child(), 50, 'darwin')()).toBe('unknown');
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('unavailable'); });
    mockPs('Z');
    const sample = probeLeaderState(child(), 50, 'linux');
    read.mockReturnValue('123456 (node) S 1 123456 123456 0 -1 0');
    expect(sample()).toBe('unknown');
  });

  it('never waits past the existing grace and ignores late ps output', () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    let deliver!: (error: Error | null, stdout: string, stderr: string) => void;
    const { run, probe } = mockPs('');
    run.mockImplementation(((...args: unknown[]) => { deliver = args.at(-1) as typeof deliver; return probe; }) as typeof childProcess.execFile);
    const sample = probeLeaderState(child(), 8000, 'darwin');
    vi.advanceTimersByTime(7949);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(sample()).toBe('unknown');
    expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
    deliver(null, 'S', '');
    expect(sample()).toBe('unknown');
  });

  it('cancels an in-flight probe at native exit and a scheduled probe before launch', () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const { run, probe } = mockPs('');
    const first = child();
    probeLeaderState(first, 50, 'darwin');
    first.emit('exit', 0);
    expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
    const second = child();
    probeLeaderState(second, 8000, 'darwin');
    second.emit('exit', 0);
    vi.advanceTimersByTime(8000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps cleanup and unknown attribution without a supported state probe', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const { run } = mockPs('S');
    expect(probeLeaderState(child(), 50, 'win32')()).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('session process groups (hearsay-tools/cezarion#890)', () => {
  const pids: number[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function start(script: string): Promise<{ leader: ChildProcessWithoutNullStreams; member: number; cwd: string }> {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-session-group-'));
    dirs.push(cwd);
    const leader = spawnSessionLeader(process.execPath, ['-e', script], { cwd, env: process.env });
    pids.push(leader.pid!);
    // bound: wait for this process signal or PID publication on a loaded host.
    const member = await vi.waitFor(() => requirePid(join(cwd, 'member.pid')), { timeout: 10_000 });
    pids.push(member);
    return { leader, member, cwd };
  }
  const exited = (child: ChildProcess) => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

  it('reads a real ps live state independently of the runner probe budget', async () => {
    const { leader } = await start(leaderScript(DEFAULT_TERM));
    leader.kill('SIGSTOP');
    // Integration bound only: production cleanup still gives the probe at most 50ms.
    const { stdout } = await promisify(execFile)('ps', ['-o', 'stat=', '-p', String(leader.pid)],
      { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
    expect(psLeaderState(stdout, process.platform)).toBe('live');
  });

  it('spawns a leader that leads its own process group', async () => {
    const { leader } = await start(leaderScript(DEFAULT_TERM));
    expect(execFileSync('ps', ['-o', 'pgid=', '-p', String(leader.pid)], { encoding: 'utf8' }).trim()).toBe(String(leader.pid));
    expect(sessionGroupOf(leader.pid!)).toBe(leader.pid);
  });

  it('signalling a session reaches a member that ignores SIGTERM after its leader exits', async () => {
    const { leader, member } = await start(leaderScript(IGNORES_TERM));
    signalSession(leader, 'SIGTERM');
    await exited(leader);
    // bound: wait for this process signal or PID publication on a loaded host.
    await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 10_000 });
  });

  it('a setsid member is never signalled', async () => {
    const { leader, member } = await start(leaderScript(IGNORES_TERM, { detached: true }));
    vi.useFakeTimers();
    signalSession(leader, 'SIGTERM');
    await exited(leader);
    await vi.advanceTimersByTimeAsync(400);
    expect(alive(member)).toBe(true);
  });

  // hearsay-tools/cezarion#1286: a leader that exits on its own ended its session, so what it left
  // in its group (an MCP server that ignores EOF, a background job) ends with it.
  it('a leader that exits on its own ends a member that handles SIGTERM', async () => {
    const { leader, member } = await start(leaderScript(DEFAULT_TERM, { exit: true }));
    await exited(leader);
    expect(sessionGroupOf(leader.pid!)).toBeUndefined();
    // bound: the exit drain, then signal delivery and reaping by the subreaper.
    await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 5000 });
  });

  it('a member that ignores SIGTERM is killed after the grace once its leader exits on its own', async () => {
    const { leader, member, cwd } = await start(leaderScript(TERM_RECEIPT, { exit: true }));
    await exited(leader);
    // bound: the exit drain, the grace, then signal delivery and reaping by the subreaper.
    await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 5000 });
    // Written by the member's SIGTERM handler, which does not exit: SIGKILL ended it.
    expect(existsSync(join(cwd, 'member.term'))).toBe(true);
  });

  it('a setsid member survives a leader that exits on its own', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-session-group-'));
    dirs.push(cwd);
    const leader = spawnSessionLeader(process.execPath, ['-e', `const { spawn } = require('child_process'); const fs = require('fs');
const g = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_TERM)}], { stdio: 'ignore' });
const s = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_TERM)}], { stdio: 'ignore', detached: true });
fs.writeFileSync('pids.tmp', g.pid + ' ' + s.pid); fs.renameSync('pids.tmp', 'pids');
g.unref(); s.unref(); process.exit(0);`], { cwd, env: process.env });
    pids.push(leader.pid!);
    // bound: three node processes starting on a loaded host.
    const [group, setsid] = await vi.waitFor(() => {
      const found = readFileSync(join(cwd, 'pids'), 'utf8').split(' ').map(Number);
      expect(found).toHaveLength(2);
      return found as [number, number];
    }, { timeout: 5000 });
    pids.push(group, setsid);
    await exited(leader);
    // The group member's SIGKILL is the last signal the reap sends.
    // bound: the exit drain, the grace, then signal delivery and reaping by the subreaper.
    await vi.waitFor(() => expect(alive(group)).toBe(false), { timeout: 5000 });
    expect(alive(setsid)).toBe(true);
  });

  it('a child spawned in the group after its leader exits on its own is still ended', async () => {
    // The member starts the late child once the leader's exit closes its stdin pipe.
    const member = `const { spawn } = require('child_process'); const fs = require('fs'); process.on('SIGTERM', () => {});
process.stdin.on('end', () => { const c = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_TERM)}], { stdio: 'ignore' });
  fs.writeFileSync('late.pid.tmp', String(c.pid)); fs.renameSync('late.pid.tmp', 'late.pid'); });
process.stdin.resume(); setTimeout(() => {}, 20000);`;
    const cwd = mkdtempSync(join(tmpdir(), 'cez-session-group-'));
    dirs.push(cwd);
    const leader = spawnSessionLeader(process.execPath, ['-e', `const { spawn } = require('child_process');
const m = spawn(process.execPath, ['-e', ${JSON.stringify(member)}], { stdio: ['pipe', 'ignore', 'ignore'] });
require('fs').writeFileSync('member.pid.tmp', String(m.pid)); require('fs').renameSync('member.pid.tmp', 'member.pid');
setTimeout(() => process.exit(0), 50);`], { cwd, env: process.env });
    pids.push(leader.pid!);
    // bound: two node processes starting on a loaded host.
    pids.push(await vi.waitFor(() => requirePid(join(cwd, 'member.pid')), { timeout: 5000 }));
    await exited(leader);
    // bound: the member's stdin EOF and one spawn.
    const late = await vi.waitFor(() => requirePid(join(cwd, 'late.pid')), { timeout: 5000 });
    pids.push(late);
    // bound: the exit drain, the grace, then signal delivery and reaping by the subreaper.
    await vi.waitFor(() => expect(alive(late)).toBe(false), { timeout: 5000 });
  });

  it('signalling a session after its leader exited on its own leaves the ending to the reap', async () => {
    const { leader, member } = await start(leaderScript(IGNORES_TERM, { exit: true }));
    await exited(leader);
    const kill = vi.spyOn(process, 'kill');
    signalSession(leader, 'SIGTERM');
    signalSession(leader, 'SIGKILL');
    expect(kill.mock.calls.filter(([pid, signal]) => pid === -leader.pid! && signal !== 0)).toEqual([]);
    // bound: the exit drain, the grace, then signal delivery and reaping by the subreaper.
    await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 5000 });
  });

  // hearsay-tools/cezarion#1286 review: a headless `cez run` ends by letting its event loop drain,
  // so what the reap waits on must keep such a host up until the group it ends is empty.
  describe('a host with nothing else to wait for', () => {
    const sessionProcess = fileURLToPath(new URL('./session-process.ts', import.meta.url));
    /** Start one leader from a fresh host that holds no handle of its own; settle when the host exits. */
    async function host(leader: string): Promise<{ member: number; cwd: string }> {
      const cwd = mkdtempSync(join(tmpdir(), 'cez-session-host-'));
      dirs.push(cwd);
      await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `import { spawnSessionLeader } from ${JSON.stringify(sessionProcess)};
spawnSessionLeader(process.execPath, ['-e', ${JSON.stringify(leader)}], { cwd: ${JSON.stringify(cwd)}, env: process.env });`]);
      const member = requirePid(join(cwd, 'member.pid'));
      pids.push(member);
      return { member, cwd };
    }

    it('stays up until the group a leader left behind is empty', async () => {
      const { member } = await host(leaderScript(DEFAULT_TERM, { exit: true }));
      expect(alive(member)).toBe(false);
    });

    // The real KILL_GRACE_MS (10 s) runs in the host, so the host lives for about that long.
    it('stays up to SIGKILL a member that ignores SIGTERM', async () => {
      const { member, cwd } = await host(leaderScript(TERM_RECEIPT, { exit: true }));
      // bound: SIGKILL delivery and reaping by the subreaper, after the host sent it and exited.
      await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 5000 });
      expect(existsSync(join(cwd, 'member.term'))).toBe(true);
    }, 30_000);
  });

  it('never group-signals a fake child', () => {
    const kill = vi.spyOn(process, 'kill');
    const fake = { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn(() => true) } as unknown as ChildProcess;
    signalSession(fake, 'SIGTERM');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill.mock.calls.filter(([pid]) => pid === -4242)).toEqual([]);
    expect(sessionGroupOf(4242)).toBeUndefined();
  });

  it('forwardToSessionGroups reaches a member whose leader exited, and is harmless twice', async () => {
    const { leader, member } = await start(leaderScript(DEFAULT_TERM, { exit: true }));
    await exited(leader);
    expect(alive(member)).toBe(true);
    forwardToSessionGroups('SIGTERM');
    // bound: wait for this process signal or PID publication on a loaded host.
    await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 10_000 });
    // Reaped by init: the group number is free, so nothing may signal it again.
    // bound: wait for this process signal or PID publication on a loaded host.
    await vi.waitFor(() => expect(() => process.kill(member, 0)).toThrow(), { timeout: 10_000 });
    const kill = vi.spyOn(process, 'kill');
    forwardToSessionGroups('SIGTERM');
    forwardToSessionGroups('SIGTERM');
    expect(kill.mock.calls.filter(([pid, signal]) => pid === -leader.pid! && signal === 'SIGTERM')).toEqual([]);
  });
});
