import { vi } from 'vitest';
import { setTimeout as nodeTimeout, clearTimeout as nodeClearTimeout } from 'node:timers';
import { AUTO_END_DELAY_MS } from './runner-runtime.ts';

// Fake timers also replace node:timers exports. Keep the original functions by value.
const nativeTimeout = nodeTimeout;
const nativeClearTimeout = nodeClearTimeout;

type OwnedTimer = { handle: ReturnType<typeof setTimeout>; active: boolean; fire(): void };
type Observer = { capture(delay: number | undefined): boolean; timers: OwnedTimer[] };
const observers = new Set<Observer>();

/** One fake clock serves every observer; unmatched process and drain timers keep real time. */
function installObservationClock(): void {
  if (observers.size && vi.isFakeTimers()) return;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
  const fakeTimeout = globalThis.setTimeout;
  const fakeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const owners = [...observers].filter(observer => observer.capture(args[1]));
    if (!owners.length) return nativeTimeout(...args);
    let timer!: OwnedTimer;
    const invoke = () => {
      timer.active = false;
      const [callback, , ...parameters] = args;
      callback(...parameters);
    };
    const handle = fakeTimeout(invoke, args[1]);
    timer = { handle, active: true, fire() { fakeClearTimeout(handle); invoke(); } };
    for (const owner of owners) owner.timers.push(timer);
    return handle;
  }) as typeof setTimeout;
  // Preserve fake-timer metadata so useRealTimers restores the global functions.
  Object.assign(globalThis.setTimeout, fakeTimeout);
  globalThis.clearTimeout = ((handle) => {
    for (const observer of observers) for (const timer of observer.timers) if (timer.handle === handle) timer.active = false;
    fakeClearTimeout(handle);
  }) as typeof clearTimeout;
  Object.assign(globalThis.clearTimeout, fakeClearTimeout);
}

/** Freeze selected product timers while native processes and their drains keep real time. */
export function observationClock(capture: (delay: number | undefined) => boolean) {
  installObservationClock();
  const observer: Observer = { capture, timers: [] };
  observers.add(observer);
  return {
    get captured() { return observer.timers.length; },
    get pending() { return observer.timers.filter(timer => timer.active).length; },
    /** Also permits a stale callback: the product must refuse a cancelled wait itself. */
    fire(index: number) {
      const timer = observer.timers[index];
      if (!timer) throw new Error(`No captured timer at ${index}`);
      timer.fire();
    },
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    restore() {
      observers.delete(observer);
      if (observers.size) return;
      vi.useRealTimers();
      globalThis.setTimeout = nativeTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    },
  };
}

/** Every native runner owns its one-shot close timer in scheduleAutoEnd. */
export function autoEndObservationClock() {
  return observationClock(delay => delay === AUTO_END_DELAY_MS &&
    /\bat (?:[^ (\n]+\.)?scheduleAutoEnd \(/.test(new Error().stack ?? ''));
}
