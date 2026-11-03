import { vi } from 'vitest';
import { AUTO_END_DELAY_MS } from './runner-runtime.ts';

/** Freeze selected product timers while native processes and their drains keep real time. */
export function observationClock(capture: (delay: number | undefined) => boolean) {
  const realTimeout = globalThis.setTimeout;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
  const fakeTimeout = globalThis.setTimeout;
  let captured = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    if (!capture(args[1])) return realTimeout(...args);
    captured++;
    return fakeTimeout(...args);
  }) as typeof setTimeout;
  return {
    get captured() { return captured; },
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    restore() { globalThis.setTimeout = fakeTimeout; vi.useRealTimers(); },
  };
}

/** Every native runner owns its one-shot close timer in scheduleAutoEnd. */
export function autoEndObservationClock() {
  return observationClock(delay => delay === AUTO_END_DELAY_MS &&
    /\bat (?:[^ (\n]+\.)?scheduleAutoEnd \(/.test(new Error().stack ?? ''));
}
