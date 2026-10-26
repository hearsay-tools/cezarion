import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevServer } from './dev-server.ts';

// The Windows paths run on any host: `spawn` and `spawnSync` are fakes file-wide, so no command
// starts and no process is signalled.
const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

const hostPlatform = process.platform;
const server: PreviewServer = { port: 1, command: 'npm run dev', label: 'fake', registeredAt: '2026-10-26T10:00:00.000Z', answeredAtRegistration: false };

/** A shell leader that has started and not exited, with the fields Node sets when it reaps one. */
function fakeLeader(pid: number): EventEmitter & { pid: number; exitCode: number | null; signalCode: null } {
  return Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-devserver-win-'));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe('DevServer on Windows', () => {
  it('ends the process tree at the pid of a shell leader that exited on its own, as before the detached-process helper', async () => {
    const leader = fakeLeader(4242);
    spawnMock.mockReturnValue(leader);
    const supervisor = new DevServer({ server, worktreePath: root, dir: join(root, 'preview'), probeMs: 60_000 });
    supervisor.start();
    leader.exitCode = 3;
    leader.emit('exit', 3, null);
    expect(supervisor.state).toBe('exited');
    // A Job Object per started server replaces this call (hearsay-tools/cezarion#1876).
    expect(spawnSyncMock).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/t', '/f'], { windowsHide: true, timeout: 5_000 });
    await supervisor.stop('release');
  });
});
