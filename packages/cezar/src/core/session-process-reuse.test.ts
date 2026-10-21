import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A leader as spawnSessionLeader registers it, and a fake /proc: every `process.kill` below is a
// mock, so no signal can reach a real process or group.
const PGID = 4_000_123;
const proc = vi.hoisted(() => new Map<number, { pgrp: number; start: string }>());
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: () => Object.assign(new actual.ChildProcess(), { pid: 4_000_123 }) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const stat = (pid: number) => {
    const entry = proc.get(pid);
    if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return `${pid} (node) S 1 ${entry.pgrp} ${entry.pgrp} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${entry.start} 0 0`;
  };
  return {
    ...actual,
    readdirSync: ((path: unknown, ...rest: unknown[]) => String(path) === '/proc'
      ? [...proc.keys()].map(String) : Reflect.apply(actual.readdirSync, actual, [path, ...rest])) as typeof actual.readdirSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) => /^\/proc\/\d+\/stat$/.test(String(path))
      ? stat(Number(String(path).split('/')[2])) : Reflect.apply(actual.readFileSync, actual, [path, ...rest])) as typeof actual.readFileSync,
  };
});

import { forwardToSessionGroups, sessionGroupOf, spawnSessionLeader } from './session-process.ts';

/** `process.kill(-PGID, 0)` and `process.kill(PGID, 0)` answer from the fake /proc; `onSignal`
 * plays what a real signal would do to it. */
function kernel(onSignal?: (target: number, signal: string | number) => void) {
  const esrch = () => Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  return vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
    if (signal !== 0) { onSignal?.(target, signal ?? 'SIGTERM'); return true; }
    if (target < 0 ? [...proc.values()].some(entry => entry.pgrp === -target) : proc.has(target)) return true;
    throw esrch();
  }) as typeof process.kill);
}

function exitedLeader(): ChildProcess {
  const leader = spawnSessionLeader('agent', [], { cwd: '.', env: {} }) as unknown as ChildProcess;
  Object.assign(leader, { exitCode: 0 });
  leader.emit('exit', 0, null);
  return leader;
}

const forwarded = (kill: ReturnType<typeof kernel>) => kill.mock.calls.filter(([target, signal]) => target === -PGID && signal !== 0);

// hearsay-tools/cezarion#890 review: once its leader exits, a group is ours only while a member
// recorded at that exit is still in it. Only then can its number not have been reused.
describe.runIf(process.platform === 'linux')('session group registry after the leader exits', () => {
  // Fake timers keep the post-exit reap (hearsay-tools/cezarion#1286) from firing after a test
  // restored the real process.kill: switching back drops whatever is still scheduled.
  beforeEach(() => { vi.useFakeTimers(); proc.clear(); proc.set(4_000_124, { pgrp: PGID, start: '777' }); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('forwards to the members an exited leader left behind', () => {
    const kill = kernel();
    exitedLeader();
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([[-PGID, 'SIGTERM']]);
  });

  it('never forwards to the number once a new live leader holds it', () => {
    const kill = kernel();
    exitedLeader();
    proc.clear();
    proc.set(PGID, { pgrp: PGID, start: '9001' });
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([]);
    expect(sessionGroupOf(PGID)).toBeUndefined();
  });

  it('never forwards to a reused group whose new leader already exited', () => {
    const kill = kernel();
    exitedLeader();
    // A double-fork daemon: its intermediate leader took the number and exited, its child lives.
    proc.clear();
    proc.set(4_000_200, { pgrp: PGID, start: '9002' });
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([]);
  });

  it('a recorded member that moved to another group no longer vouches for this one', () => {
    const kill = kernel();
    exitedLeader();
    proc.set(4_000_124, { pgrp: 4_000_124, start: '777' });
    proc.set(4_000_200, { pgrp: PGID, start: '9002' });
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([]);
  });

  it('a pid reused by a new incarnation no longer vouches for the group', () => {
    const kill = kernel();
    exitedLeader();
    proc.set(4_000_124, { pgrp: PGID, start: '778' });
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([]);
  });

  // hearsay-tools/cezarion#1286: a leader that exits on its own ended its session; what it left in
  // its group is ended too, after the exit drain, under the same reuse guard.
  describe('the reap after a leader exits on its own', () => {
    // Past the exit drain (250 ms counted in ticks, then one immediate), short of the grace.
    const DRAIN = 400;
    const GRACE = 10_000;

    it('sends SIGTERM after the exit drain and SIGKILL after the grace', () => {
      const kill = kernel();
      exitedLeader();
      expect(forwarded(kill)).toEqual([]);
      vi.advanceTimersByTime(DRAIN);
      expect(forwarded(kill)).toEqual([[-PGID, 'SIGTERM']]);
      vi.advanceTimersByTime(GRACE);
      expect(forwarded(kill)).toEqual([[-PGID, 'SIGTERM'], [-PGID, 'SIGKILL']]);
    });

    it('sends no SIGKILL once every member ended on the SIGTERM', () => {
      const kill = kernel((target, signal) => { if (target === -PGID && signal === 'SIGTERM') proc.clear(); });
      exitedLeader();
      vi.advanceTimersByTime(DRAIN + GRACE);
      expect(forwarded(kill)).toEqual([[-PGID, 'SIGTERM']]);
    });

    it('never signals a group whose recorded members are gone and whose number was reused', () => {
      const kill = kernel();
      exitedLeader();
      // A double-fork daemon took the emptied number before the drain ended.
      proc.clear();
      proc.set(4_000_200, { pgrp: PGID, start: '9002' });
      vi.advanceTimersByTime(DRAIN + GRACE);
      expect(forwarded(kill)).toEqual([]);
    });

    it('never sends the SIGKILL to a number emptied and reused after the SIGTERM', () => {
      const kill = kernel((target, signal) => {
        if (target !== -PGID || signal !== 'SIGTERM') return;
        proc.clear();
        proc.set(4_000_200, { pgrp: PGID, start: '9002' });
      });
      exitedLeader();
      vi.advanceTimersByTime(DRAIN + GRACE);
      expect(forwarded(kill)).toEqual([[-PGID, 'SIGTERM']]);
    });

    // The rescan precedes the SIGTERM: a member with the default action is usually gone before a
    // scan after the signal could read it, and a later child would then lose its voucher.
    it('still SIGKILLs a child that ignores SIGTERM, started after the exit, when every recorded member ends on the SIGTERM', () => {
      const kill = kernel((target, signal) => { if (target === -PGID && signal === 'SIGTERM') proc.delete(4_000_124); });
      exitedLeader();
      proc.set(4_000_300, { pgrp: PGID, start: '800' });
      vi.advanceTimersByTime(DRAIN + GRACE);
      expect(forwarded(kill)).toEqual([[-PGID, 'SIGTERM'], [-PGID, 'SIGKILL']]);
    });

    it('a rescan that shares no recorded member does not vouch for the group', () => {
      const kill = kernel();
      exitedLeader();
      // The recorded member was replaced by a new incarnation of its pid, and a stranger joined.
      proc.set(4_000_124, { pgrp: PGID, start: '778' });
      proc.set(4_000_300, { pgrp: PGID, start: '800' });
      vi.advanceTimersByTime(DRAIN + GRACE);
      expect(forwarded(kill)).toEqual([]);
    });
  });
});
