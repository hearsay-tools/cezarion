import { afterEach, expect, it, vi } from 'vitest';
import { waitForTestAppWatcher } from './idle-test-app.ts';

const probe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: probe }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it.each(['linux', 'win32'])('waits for a watcher outside the checkout on %s', async platform => {
  vi.useFakeTimers();
  vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }));
  const command = 'node /tools/test-env-lease.mjs watch-app 123 start /checkout /checkout';
  probe.mockReturnValue({ status: 0, stdout: platform === 'win32' ? JSON.stringify([command]) : command });
  let finished = false;
  const waiting = waitForTestAppWatcher('/checkout').then(result => { finished = true; return result; });
  await vi.advanceTimersByTimeAsync(1000);
  expect(finished).toBe(false);
  probe.mockReturnValue({ status: 0, stdout: platform === 'win32' ? '[]' : '' });
  await vi.advanceTimersByTimeAsync(250);
  expect(await waiting).toBe(true);
});

it.each(['running watcher', 'unreadable process table'])('refuses removal after timeout: %s', async reason => {
  vi.useFakeTimers();
  probe.mockReturnValue(reason === 'running watcher'
    ? { status: 0, stdout: 'node test-env-lease.mjs watch-app 123 start /checkout /checkout' }
    : { status: 1, stdout: '' });
  const waiting = waitForTestAppWatcher('/checkout');
  await vi.advanceTimersByTimeAsync(33_000);
  expect(await waiting).toBe(false);
});
