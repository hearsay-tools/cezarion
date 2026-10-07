import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A leader as spawnSessionLeader registers it, without a real process: every `process.kill` below
// is a mock, so no signal can reach a real process or group.
const PGID = 4_000_123;
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: () => Object.assign(new actual.ChildProcess(), { pid: PGID }) };
});

import { forwardToSessionGroups, sessionGroupOf, spawnSessionLeader } from './session-process.ts';

/** `group`: some process is still in group PGID. `pid`: some live process has pid PGID. */
function kernel(state: { group: boolean; pid: boolean }) {
  const esrch = () => Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  return vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
    if (signal !== 0) return true;
    if (target === -PGID && state.group) return true;
    if (target === PGID && state.pid) return true;
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

// hearsay-tools/cezarion#890 review: an exited leader's entry must not outlive the group it names.
describe.skipIf(process.platform === 'win32')('session group registry after the leader exits', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('never forwards to a group number that a new process took after ours emptied', () => {
    const state = { group: true, pid: false };
    const kill = kernel(state);
    exitedLeader();
    // Our members exited; a new process took the number and made it a group with setsid.
    state.pid = true;
    forwardToSessionGroups('SIGTERM');
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([]);
    expect(sessionGroupOf(PGID)).toBeUndefined();
  });

  it('drops an exited leader\'s group once it empties, before any forward', () => {
    vi.useFakeTimers();
    const state = { group: true, pid: false };
    const kill = kernel(state);
    exitedLeader();
    vi.advanceTimersByTime(5_000);
    state.group = false;
    vi.advanceTimersByTime(5_000);
    // Reused, and its new leader already gone: nothing but the drop can tell this group apart.
    state.group = true;
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([]);
  });

  it('still forwards to the members an exited leader left behind', () => {
    const kill = kernel({ group: true, pid: false });
    exitedLeader();
    forwardToSessionGroups('SIGTERM');
    expect(forwarded(kill)).toEqual([[-PGID, 'SIGTERM']]);
  });
});
