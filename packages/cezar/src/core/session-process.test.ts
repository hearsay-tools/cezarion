import { execFileSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runner-runtime.ts', async (original) => ({
  ...await original<typeof import('./runner-runtime.ts')>(),
  KILL_GRACE_MS: 100,
}));

import { forwardToSessionGroups, procStatExited, sessionGroupOf, signalSession, spawnSessionLeader } from './session-process.ts';

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

/** A leader that starts one member in its cwd, writes the member's pid, then stays or exits. */
function leaderScript(member: string, opts: { detached?: boolean; exit?: boolean } = {}): string {
  return `const { spawn } = require('child_process');
const m = spawn(process.execPath, ['-e', ${JSON.stringify(member)}], { stdio: 'ignore', detached: ${!!opts.detached} });
require('fs').writeFileSync('member.pid', String(m.pid));
${opts.exit ? 'm.unref(); process.exit(0);' : "console.log('ready'); setTimeout(()=>{},20000);"}`;
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

describe.skipIf(process.platform === 'win32')('session process groups (hearsay-tools/cezarion#890)', () => {
  const pids: number[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function start(script: string): Promise<{ leader: ChildProcessWithoutNullStreams; member: number; cwd: string }> {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-session-group-'));
    dirs.push(cwd);
    const leader = spawnSessionLeader(process.execPath, ['-e', script], { cwd, env: process.env });
    pids.push(leader.pid!);
    await vi.waitFor(() => expect(existsSync(join(cwd, 'member.pid')) && readFileSync(join(cwd, 'member.pid'), 'utf8')).toMatch(/^\d+$/), { timeout: 5000 });
    const member = Number(readFileSync(join(cwd, 'member.pid'), 'utf8'));
    pids.push(member);
    return { leader, member, cwd };
  }
  const exited = (child: ChildProcess) => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
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
    await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 2000 });
  });

  it('a setsid member is never signalled', async () => {
    const { leader, member } = await start(leaderScript(IGNORES_TERM, { detached: true }));
    signalSession(leader, 'SIGTERM');
    await exited(leader);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(alive(member)).toBe(true);
  });

  it('a leader that exits on its own signals nothing', async () => {
    const { leader, member } = await start(leaderScript(DEFAULT_TERM, { exit: true }));
    await exited(leader);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(alive(member)).toBe(true);
    expect(sessionGroupOf(leader.pid!)).toBeUndefined();
  });

  it('signalling a session whose leader already exited on its own signals nothing', async () => {
    const { leader, member } = await start(leaderScript(IGNORES_TERM, { exit: true }));
    await exited(leader);
    const kill = vi.spyOn(process, 'kill');
    signalSession(leader, 'SIGTERM');
    signalSession(leader, 'SIGKILL');
    expect(kill.mock.calls.filter(([pid, signal]) => pid === -leader.pid! && signal !== 0)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(alive(member)).toBe(true);
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
    await vi.waitFor(() => expect(alive(member)).toBe(false), { timeout: 2000 });
    // Reaped by init: the group number is free, so nothing may signal it again.
    await vi.waitFor(() => expect(() => process.kill(member, 0)).toThrow(), { timeout: 2000 });
    const kill = vi.spyOn(process, 'kill');
    forwardToSessionGroups('SIGTERM');
    forwardToSessionGroups('SIGTERM');
    expect(kill.mock.calls.filter(([pid, signal]) => pid === -leader.pid! && signal === 'SIGTERM')).toEqual([]);
  });
});
