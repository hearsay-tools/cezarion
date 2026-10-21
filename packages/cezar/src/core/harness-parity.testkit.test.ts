import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './harness-parity.testkit.ts';

describe('waitFor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => vi.useRealTimers());

  it('reports the predicate and actual elapsed time after crossing the timeout', async () => {
    const ready = false;
    const cond = () => ready;
    // bound: fake time exercises the timeout boundary without a real delay.
    const result = waitFor(cond, 20).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    // The limit is strict: the poll at exactly 20 ms must not time out.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('waitFor timed out after 30ms:');
    expect((error as Error).message).toContain(cond.toString());
    expect((error as Error).message).toContain('ready');
  });

  it('returns immediately for a satisfied predicate without reading its source', async () => {
    const cond = () => true;
    cond.toString = () => { throw new Error('source must not be read on success'); };
    await expect(waitFor(cond)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves when the predicate becomes true on a later poll', async () => {
    let ready = false;
    const result = waitFor(() => ready);
    ready = true;
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the original predicate error', async () => {
    const error = new Error('predicate failed');
    await expect(waitFor(() => { throw error; })).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
