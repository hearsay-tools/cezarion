import { expect, it, vi } from 'vitest';
import { autoEndObservationClock, observationClock } from './observation-clock.testkit.ts';

it('advances only selected timers and leaves unrelated timers on the native clock', async () => {
  const clock = observationClock(delay => delay === 250);
  try {
    let fired = false;
    setTimeout(() => { fired = true; }, 250);
    // bound: the test timeout guards native scheduling; this timer is the real-clock signal.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(clock.captured).toBe(1);
    expect(fired).toBe(false);
    await clock.advance(249);
    expect(fired).toBe(false);
    await clock.advance(1);
    expect(fired).toBe(true);
  } finally { clock.restore(); }
});

it('selects the auto-end armer while a same-delay native drain keeps real time', async () => {
  const clock = autoEndObservationClock();
  try {
    let closed = false;
    function scheduleAutoEnd() { setTimeout(() => { closed = true; }, 250); }
    scheduleAutoEnd();
    // bound: a real same-delay timer is the drain signal; the test timeout guards a hang.
    const drained = new Promise<void>(resolve => setTimeout(resolve, 250));
    expect(clock.captured).toBe(1);
    expect(closed).toBe(false);
    await clock.advance(250);
    expect(closed).toBe(true);
    await drained;
    expect(clock.captured).toBe(1);
  } finally { clock.restore(); }
});


it.each([true, false])('shares one fake clock between selective observers (first restored first: %s)', async firstRestoredFirst => {
  const nativeTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const first = observationClock(delay => delay === 100);
  const second = observationClock(delay => delay === 200);
  const fired: string[] = [];
  setTimeout(() => fired.push('first'), 100);
  setTimeout(() => fired.push('second'), 200);
  expect(first.captured).toBe(1);
  expect(second.captured).toBe(1);
  expect(first.pending).toBe(1);
  expect(second.pending).toBe(1);
  // bound: this unmatched native timer is the scheduling signal.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(fired).toEqual([]);
  const early = firstRestoredFirst ? first : second;
  const late = firstRestoredFirst ? second : first;
  early.restore();
  expect(vi.isFakeTimers()).toBe(true);
  late.fire(0);
  expect(fired).toEqual([firstRestoredFirst ? 'second' : 'first']);
  expect(late.pending).toBe(0);
  late.restore();
  expect(vi.isFakeTimers()).toBe(false);
  expect(globalThis.setTimeout).toBe(nativeTimeout);
  expect(globalThis.clearTimeout).toBe(nativeClearTimeout);
});

it('records cancellation but permits firing an owned stale callback', () => {
  const clock = observationClock(delay => delay === 100);
  const callback = vi.fn();
  const handle = setTimeout(callback, 100);
  expect(clock.captured).toBe(1);
  expect(clock.pending).toBe(1);
  clearTimeout(handle);
  expect(clock.pending).toBe(0);
  expect(callback).not.toHaveBeenCalled();
  clock.fire(0);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(clock.pending).toBe(0);
  clock.restore();
});

it.fails('releases an observer when its test throws before manual restoration', () => {
  observationClock(delay => delay === 100);
  throw new Error('intentional failure before restoration');
});

it('starts with native timers after the preceding test failed', () => {
  expect(vi.isFakeTimers()).toBe(false);
  const clock = observationClock(delay => delay === 100);
  setTimeout(() => {}, 100);
  expect(clock.captured).toBe(1);
  clock.restore();
  expect(vi.isFakeTimers()).toBe(false);
});
