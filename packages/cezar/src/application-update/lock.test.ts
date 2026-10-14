import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withDirectoryLock } from './lock.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'cez-update-lock-')); roots.push(root); return join(root, 'concurrency.lock'); }

describe('npm-compatible directory lock', () => {
  it('waits for an owner and releases after its operation', async () => {
    const lock = path();
    const order: string[] = [];
    let release!: () => void;
    // Wait for the first owner's operation itself, not a fixed 10 ms: under load the lock was not
    // taken yet and `release` was still unassigned (#900).
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const first = withDirectoryLock(lock, () => new Promise<void>((resolve) => {
      order.push('first');
      release = () => { order.push('first released'); resolve(); };
      started();
    }));
    await running;
    const second = withDirectoryLock(lock, async () => { order.push('second'); return 'second'; }, 1000);
    // Released on a later turn, so a second call that did not wait would run before it. A slow
    // machine only delays the release, which cannot fail this.
    setTimeout(() => release(), 50);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first', 'first released', 'second']);
    expect(existsSync(lock)).toBe(false);
  });

  it('detects replaced lock ownership and leaves the replacement untouched', async () => {
    const lock = path();
    await expect(withDirectoryLock(lock, async (assertOwned) => {
      rmSync(lock, { recursive: true }); mkdirSync(lock);
      utimesSync(lock, 1, 1);
      await assertOwned();
    })).rejects.toThrow('ownership changed');
    expect(existsSync(lock)).toBe(true);
  });

  it('aborts an active operation when heartbeat detects replaced ownership', async () => {
    const lock = path();
    await expect(withDirectoryLock(lock, async (_assertOwned, signal) => {
      rmSync(lock, { recursive: true }); mkdirSync(lock);
      utimesSync(lock, 1, 1);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      expect(signal.aborted).toBe(true);
    })).rejects.toThrow('ownership changed');
  }, 4000);

  it('honors the deadline when stale lock removal fails', async () => {
    const lock = path();
    mkdirSync(lock);
    writeFileSync(join(lock, 'unexpected'), '');
    utimesSync(lock, 1, 1);
    const started = Date.now();
    await expect(withDirectoryLock(lock, async () => 'acquired', 25)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
    expect(existsSync(lock)).toBe(true);
  });

  it('honors the deadline when a stale lock is not removable by permissions', async () => {
    const lock = path();
    mkdirSync(lock); utimesSync(lock, 1, 1);
    const parent = join(lock, '..');
    chmodSync(parent, 0o555);
    try {
      await expect(withDirectoryLock(lock, async () => 'acquired', 25)).rejects.toThrow();
      expect(existsSync(lock)).toBe(true);
    } finally { chmodSync(parent, 0o755); }
  });
});
