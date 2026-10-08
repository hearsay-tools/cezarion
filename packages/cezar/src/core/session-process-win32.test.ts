import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][], throws: false }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => {
    spawned.calls.push(args);
    if (spawned.throws) throw new Error('spawn EAGAIN');
    return Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  } };
});

import { signalSession, spawnSessionLeader } from './session-process.ts';

const fake = (exitCode: number | null) =>
  ({ pid: 4242, exitCode, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;

// hearsay-tools/cezarion#890: win32 has no process groups to signal; the tree is ended by parent pid.
describe('session signals on win32', () => {
  beforeEach(() => { spawned.calls.length = 0; spawned.throws = false; });

  /** A leader as `spawnSessionLeader` returns it; the mocked spawn hands back a pid-4242 fake. */
  const leader = () => {
    const child = spawnSessionLeader('agent', [], { cwd: '.', env: {} }) as unknown as ChildProcess;
    spawned.calls.length = 0;
    return child;
  };

  it('ends a live leader\'s tree with taskkill /T /F', () => {
    const child = leader();
    signalSession(child, 'SIGTERM', 'win32');
    expect(spawned.calls).toEqual([['taskkill', ['/T', '/F', '/PID', '4242'], { stdio: 'ignore', windowsHide: true }]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('runs no taskkill for a leader that already exited', () => {
    const child = leader();
    Object.assign(child, { exitCode: 0 });
    signalSession(child, 'SIGTERM', 'win32');
    expect(spawned.calls).toEqual([]);
  });

  it('never runs taskkill for a child it did not spawn', () => {
    const child = fake(null);
    signalSession(child, 'SIGTERM', 'win32');
    expect(spawned.calls).toEqual([]);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to the leader alone when taskkill cannot start', () => {
    const child = leader();
    spawned.throws = true;
    signalSession(child, 'SIGKILL', 'win32');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
