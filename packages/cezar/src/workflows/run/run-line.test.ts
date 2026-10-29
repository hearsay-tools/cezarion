import { describe, expect, it, vi } from 'vitest';
import { RunLine } from './run-line.ts';

describe('RunLine', () => {
  it('keeps queue identity and only removes a queued entry with its wake marker', () => {
    const line = new RunLine();
    const push = vi.spyOn(line.queue, 'push');
    line.enqueueWake('wake', 10);
    line.enqueueWake('wake', 20);
    line.markWake('sessionless', 30);
    expect(push).toHaveBeenCalledTimes(1);
    expect(line.queue).toEqual(['wake']);
    line.removeWake('sessionless');
    expect(line.queue).toEqual(['wake']);
    line.removeWake('wake', false);
    expect(line.queue).toEqual(['wake']);
    line.markWake('wake', 40);
    line.forget('wake');
    expect(line.queue).toEqual([]);
  });

  it('retains the existing teardown exceptions and clears only the owned transient state', () => {
    const line = new RunLine();
    line.park('run'); line.markStarting('run'); line.joinPool('run');
    line.enqueueWake('run', 10); line.admitWake('run'); line.markForced('run');
    line.dispose();
    expect(line.waiting.size).toBe(0);
    expect(line.starting.size).toBe(0);
    expect(line.queue).toEqual([]);
    expect(line.inPool('run')).toBe(true);
    expect(line.wakeAt('run')).toBe(10);
    expect(line.isAdmitted('run')).toBe(true);
    expect(line.isForced('run')).toBe(true);
  });
});
