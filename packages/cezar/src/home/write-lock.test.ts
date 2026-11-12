import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { processStartToken } from '../core/process-stat.ts';
import { Home } from './home.ts';
import { withHomeLock } from './write-lock.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

vi.mock('../core/process-stat.ts', async original => ({
  ...await original<typeof import('../core/process-stat.ts')>(),
  recordedProcessLive: vi.fn(() => true),
  processStartToken: vi.fn(() => 'confirmed'),
}));
afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each([
  { recorded: undefined, current: 'confirmed', age: 30_001, expired: true },
  { recorded: undefined, current: 'confirmed', age: 30_000, expired: false },
  { recorded: 'confirmed', current: undefined, age: 30_001, expired: true },
  { recorded: 'confirmed', current: undefined, age: 30_000, expired: false },
  { recorded: 'confirmed', current: 'confirmed', age: 60_000, expired: false },
])('handles a claim with recorded=$recorded, current=$current, age=$age', ({ recorded, current, age, expired }) => {
  const home = Home.sandbox(storeRoot());
  const now = Math.floor(Date.now() / 1000) * 1000;
  const path = join(home.root, '.locks', 'write.lock', 'peer.json');
  writeFileSync(path, JSON.stringify({ pid: process.pid, startToken: recorded, ticket: 0 }));
  utimesSync(path, new Date(now - age), new Date(now - age));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.mocked(processStartToken).mockReturnValue(current);
  const pause = vi.spyOn(Atomics, 'wait').mockImplementation(() => { throw new Error('peer still holds the lock'); });
  const operation = vi.fn();
  if (expired) {
    withHomeLock(home.root, operation);
    expect(operation).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  } else {
    expect(() => withHomeLock(home.root, operation)).toThrow('peer still holds the lock');
    expect(operation).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
  }
});
