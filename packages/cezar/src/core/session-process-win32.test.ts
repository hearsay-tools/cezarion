import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][], throws: false }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => {
    spawned.calls.push(args);
    if (spawned.throws) throw new Error('spawn EAGAIN');
    return new EventEmitter();
  } };
});

import { signalSession } from './session-process.ts';

const fake = (exitCode: number | null) =>
  ({ pid: 4242, exitCode, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;

// hearsay-tools/cezarion#890: win32 has no process groups to signal; the tree is ended by parent pid.
describe('session signals on win32', () => {
  beforeEach(() => { spawned.calls.length = 0; spawned.throws = false; });

  it('ends a live leader\'s tree with taskkill /T /F', () => {
    const child = fake(null);
    signalSession(child, 'SIGTERM', 'win32');
    expect(spawned.calls).toEqual([['taskkill', ['/T', '/F', '/PID', '4242'], { stdio: 'ignore', windowsHide: true }]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('runs no taskkill for a leader that already exited', () => {
    signalSession(fake(0), 'SIGTERM', 'win32');
    expect(spawned.calls).toEqual([]);
  });

  it('falls back to the leader alone when taskkill cannot start', () => {
    spawned.throws = true;
    const child = fake(null);
    signalSession(child, 'SIGKILL', 'win32');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
