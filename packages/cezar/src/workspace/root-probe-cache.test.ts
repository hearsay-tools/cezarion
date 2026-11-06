import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { createRootProbeCache } from './root-probe-cache.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('root probe cache', () => {
  it('joins cold and expired reads by resolved root and reuses warm results', async () => {
    let time = 0;
    let work = deferred<object>();
    const compute = vi.fn(() => work.promise);
    const cache = createRootProbeCache({ compute, now: () => time, ttlMs: 5000 });
    const first = cache.get('./repo');
    expect(cache.get(resolve('repo'))).toBe(first);
    await Promise.resolve();
    expect(compute).toHaveBeenCalledExactlyOnceWith(resolve('repo'));
    const result = {};
    work.resolve(result);
    expect(await first).toBe(result);
    time = 4999;
    expect(await cache.get('repo')).toBe(result);
    expect(compute).toHaveBeenCalledTimes(1);
    time = 5000;
    work = deferred<object>();
    const expired = cache.get('repo');
    expect(cache.get('repo')).toBe(expired);
    await Promise.resolve();
    expect(compute).toHaveBeenCalledTimes(2);
    work.resolve({});
    await expired;
  });

  it('shares a rejection and releases the flight for a retry', async () => {
    const work = deferred<string>();
    const compute = vi.fn().mockReturnValueOnce(work.promise).mockResolvedValue('retry');
    const cache = createRootProbeCache({ compute, now: () => 0, ttlMs: 5000 });
    const first = cache.get('repo');
    const joined = cache.get('repo');
    const error = new Error('failed');
    const failures = Promise.all([expect(first).rejects.toBe(error), expect(joined).rejects.toBe(error)]);
    work.reject(error);
    await failures;
    expect(await cache.get('repo')).toBe('retry');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('does not serve an expired success after a failed refresh', async () => {
    let time = 0;
    const compute = vi.fn().mockResolvedValueOnce('old').mockRejectedValueOnce(new Error('refresh')).mockResolvedValueOnce('new');
    const cache = createRootProbeCache({ compute, now: () => time, ttlMs: 5000 });
    expect(await cache.get('repo')).toBe('old');
    time = 5000;
    await expect(cache.get('repo')).rejects.toThrow('refresh');
    expect(await cache.get('repo')).toBe('new');
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it.each(['invalidate', 'clear'] as const)('%s fences a late flight and preserves its replacement', async (operation) => {
    const old = deferred<string>();
    const fresh = deferred<string>();
    const compute = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const cache = createRootProbeCache({ compute, now: () => 0, ttlMs: 5000 });
    const first = cache.get('repo');
    await Promise.resolve();
    if (operation === 'clear') cache.clear(); else cache.invalidate('./repo');
    const replacement = cache.get('repo');
    old.resolve('old');
    expect(await first).toBe('old');
    expect(cache.get('repo')).toBe(replacement);
    fresh.resolve('fresh');
    expect(await replacement).toBe('fresh');
    expect(await cache.get('repo')).toBe('fresh');
  });

  it.each(['invalidate', 'clear'] as const)('%s prevents an older completion overwriting a new result', async (operation) => {
    const old = deferred<string>();
    const compute = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce('new');
    const cache = createRootProbeCache({ compute, now: () => 0, ttlMs: 5000 });
    const first = cache.get('repo');
    await Promise.resolve();
    if (operation === 'clear') cache.clear(); else cache.invalidate('repo');
    expect(await cache.get('repo')).toBe('new');
    old.resolve('old');
    await first;
    expect(await cache.get('repo')).toBe('new');
  });

  it('does not serialize unrelated roots', async () => {
    const compute = vi.fn(async (root: string) => root);
    const cache = createRootProbeCache({ compute, now: () => 0, ttlMs: 5000 });
    expect(await Promise.all([cache.get('a'), cache.get('b')])).toEqual([resolve('a'), resolve('b')]);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
