import type { RunManager } from './run.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, expect, vi } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import { observationClock } from '../core/observation-clock.testkit.ts';
import type { TimerWaitEntry, Wait } from '@open-mercato/cezar-contract';
import { isMonitoringTimer } from './waits.ts';

// hearsay-tools/cezarion#1233: a monitoring park's re-check is an open timer on the wait list.
// `monitoringWakeAt` became its deadline and `ActiveRun.monitoringWakeTimer` its armed timer.

export function monitoringTimerWait(run?: { waits?: Wait[] | undefined }): TimerWaitEntry | undefined {
  return run?.waits?.find((wait): wait is TimerWaitEntry => wait.kind === 'timer' && wait.phase === 'open' && isMonitoringTimer(wait));
}

/** A CI or timer wait: the kinds with a deadline. */
export type TimedWait = Exclude<Wait, { kind: 'human' }>;

/** Narrows a registration the test made with a CI or timer request. */
export function timed(wait: Wait): TimedWait {
  if (wait.kind === 'human') throw new Error(`expected a CI or timer wait, got human wait ${wait.id}`);
  return wait;
}

export function monitoringWakeOf(run?: { waits?: Wait[] | undefined }): string | undefined {
  return monitoringTimerWait(run)?.deadline;
}

type TimerCapture = { id?: string; due(): number | undefined; indices: number[] };
const registering = new AsyncLocalStorage<TimerCapture[]>();
let clock: ReturnType<typeof observationClock> | undefined;
const capturedTimers = new Map<string, number>();

function registrationClock() {
  return clock ??= observationClock(delay => {
    const pending = registering.getStore()?.find(entry => entry.indices.length === 0 && delay !== undefined && entry.due() !== undefined && Math.abs(delay - Math.max(0, entry.due()! - Date.now())) <= 2);
    if (!pending) return false;
    pending.indices.push(clock!.captured);
    return true;
  });
}

afterEach(() => { clock?.restore(); clock = undefined; capturedTimers.clear(); });

/** Own timers at the public registration boundary, including a restart's restored waits. */
export function observeWaitTimers(manager: RunManager, store: RunStore): void {
  const register = manager.registerWait.bind(manager);
  vi.spyOn(manager, 'registerWait').mockImplementation(async (...args) => {
    if (args[1].kind !== 'timer') return register(...args);
    registrationClock();
    const request = args[1];
    const capture: TimerCapture = { due: () => {
      const wait = store.getRun(args[0])?.waits?.find(wait => wait.kind === 'timer' && wait.phase === 'open' && wait.seconds === request.seconds && wait.note === request.note);
      return wait && wait.kind === 'timer' ? Date.parse(wait.deadline) : undefined;
    }, indices: [] };
    const wait = await registering.run([capture], () => register(...args));
    if (!capturedTimers.has(wait.id)) {
      expect(capture.indices).toHaveLength(1);
      capturedTimers.set(wait.id, capture.indices[0]!);
    }
    return wait;
  });
  const recover = manager.recover.bind(manager);
  vi.spyOn(manager, 'recover').mockImplementation(async (...args) => {
    const captures = store.listRunIds().flatMap(id => { const run = store.getRun(id); return run && ['running', 'waiting', 'queued'].includes(run.status) ? run.waits ?? [] : []; })
      .filter((wait): wait is TimerWaitEntry => wait.kind === 'timer' && wait.phase === 'open' && Date.parse(wait.deadline) > Date.now())
      .map(wait => ({ id: wait.id, due: () => Date.parse(wait.deadline), indices: [] as number[] }));
    if (!captures.length) return recover(...args);
    registrationClock();
    await registering.run(captures, () => recover(...args));
    for (const capture of captures) {
      // Recovery may keep a blocked run's wait open without arming it.
      if (capture.indices.length) {
        expect(capture.indices).toHaveLength(1);
        capturedTimers.set(capture.id, capture.indices[0]!);
      }
    }
  });
}

/** Fire one timer captured during this test's own registration, then assert its durable result. */
export function fireCapturedTimer(waitId: string): void {
  const index = capturedTimers.get(waitId);
  if (!clock || index === undefined) throw new Error(`No timer registration captured for ${waitId}`);
  clock.fire(index);
}
