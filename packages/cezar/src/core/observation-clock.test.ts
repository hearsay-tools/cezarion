import { expect, it } from 'vitest';
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
