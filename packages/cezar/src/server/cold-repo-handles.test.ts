import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const resolveRepoHandle = vi.hoisted(() => vi.fn());
vi.mock('./forge/github.ts', () => ({ resolveRepoHandle }));
import { ColdRepoHandles } from './cold-repo-handles.ts';
import type { RepoHandle } from '../runs/store.ts';

const handle = { owner: 'local', name: 'repo' };
const settle = async () => { await vi.advanceTimersByTimeAsync(0); };

describe('bounded cold repository discovery', () => {
  beforeEach(() => { vi.useFakeTimers(); resolveRepoHandle.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns immediately, deduplicates concurrent demand and retains the discovered identity', async () => {
    let finish!: (value: RepoHandle) => void;
    resolveRepoHandle.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const cache = new ColdRepoHandles();
    expect(cache.get('/a')).toBeUndefined();
    expect(cache.get('/a')).toBeUndefined();
    expect(resolveRepoHandle).toHaveBeenCalledTimes(1);
    finish(handle);
    await settle();
    expect(cache.get('/a')).toEqual(handle);
    expect(resolveRepoHandle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits active lookups and drains queued roots without another index request', async () => {
    const finish: Array<(value: RepoHandle | null) => void> = [];
    let active = 0;
    let peak = 0;
    resolveRepoHandle.mockImplementation(() => {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => { finish.push((value) => { active--; resolve(value); }); });
    });
    const cache = new ColdRepoHandles();
    for (let i = 0; i < 12; i++) {
      cache.get(`/repo-${i}`);
      cache.get(`/repo-${i}`);
    }
    expect(finish).toHaveLength(4);
    for (let i = 0; i < 12; i++) {
      finish[i]!(handle);
      await settle();
    }
    expect(peak).toBe(4);
    expect(resolveRepoHandle).toHaveBeenCalledTimes(12);
    expect(cache.get('/repo-11')).toEqual(handle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['null', 'reject', 'throw'])(
    'cools down %s failures and retries only on fresh demand', async (failure) => {
      if (failure === 'null') resolveRepoHandle.mockResolvedValueOnce(null);
      if (failure === 'reject') resolveRepoHandle.mockRejectedValueOnce(new Error('offline'));
      if (failure === 'throw') resolveRepoHandle.mockImplementationOnce(() => { throw new Error('offline'); });
      resolveRepoHandle.mockResolvedValue(handle);
      const cache = new ColdRepoHandles();
      expect(cache.get('/a')).toBeUndefined();
      await settle();
      expect(cache.get('/a')).toBeUndefined();
      expect(resolveRepoHandle).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolveRepoHandle).toHaveBeenCalledTimes(1); // no recurring background retry
      expect(cache.get('/a')).toBeUndefined();
      await settle();
      expect(cache.get('/a')).toEqual(handle);
    },
  );

  it('aborts timed-out lookups, releases queued work and ignores late results', async () => {
    const signals: AbortSignal[] = [];
    let late!: (value: RepoHandle) => void;
    resolveRepoHandle.mockImplementation((_root: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((resolve) => { late = resolve; });
    });
    const cache = new ColdRepoHandles();
    for (let i = 0; i < 5; i++) cache.get(`/repo-${i}`);
    const finishOld = late;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals.slice(0, 4).every((signal) => signal.aborted)).toBe(true);
    expect(signals).toHaveLength(5);
    finishOld(handle);
    await settle();
    expect(cache.get('/repo-3')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forgets removed roots, cancels their queued work and ignores old results after re-registration', async () => {
    const signals: AbortSignal[] = [];
    const finish: Array<(value: RepoHandle) => void> = [];
    resolveRepoHandle.mockImplementation((_root: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((resolve) => { finish.push(resolve); });
    });
    const cache = new ColdRepoHandles();
    for (let i = 0; i < 5; i++) cache.get(`/repo-${i}`);
    cache.retainRoots(new Set());
    await settle();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(resolveRepoHandle).toHaveBeenCalledTimes(4); // queued fifth root was discarded
    expect(cache.get('/repo-0')).toBeUndefined();
    finish[0]!(handle);
    await settle();
    expect(cache.get('/repo-0')).toBeUndefined();
    finish[4]!({ owner: 'new', name: 'repo' });
    await settle();
    expect(cache.get('/repo-0')).toEqual({ owner: 'new', name: 'repo' });
    cache.retainRoots(new Set());
    expect(cache.get('/repo-0')).toBeUndefined(); // successful entries are forgotten too
    cache.retainRoots(new Set());
    await settle();
  });
});
