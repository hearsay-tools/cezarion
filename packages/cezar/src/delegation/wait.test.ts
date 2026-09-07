import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkerOutcome, WorkerWait } from '@open-mercato/cezar-contract';
import { reconcileWorkerWait } from './wait.ts';

const now = '2026-09-06T12:00:00.000Z';
const workerId = randomUUID();
const wait: WorkerWait = { id: randomUUID(), workerIds: [workerId], deadline: '2026-09-06T12:10:00.000Z', phase: 'registered', outcomes: [] };
const outcome = (status: WorkerOutcome['status']): WorkerOutcome => ({ workerId, status, observedAt: now });

describe('reconcileWorkerWait', () => {
  it('keeps an unexpired wait unchanged', () => {
    expect(reconcileWorkerWait(wait, [], now)).toBe(wait);
  });
  it('expires at the exact deadline with a stable wake ID', () => {
    const expired = reconcileWorkerWait(wait, [], wait.deadline);
    expect(expired.phase).toBe('wake-pending');
    expect(expired.wakeId).toBe(wait.id);
    expect(reconcileWorkerWait(expired, [], wait.deadline).wakeId).toBe(expired.wakeId);
    expect(wait.phase).toBe('registered');
  });
  for (const phase of ['registered', 'parked'] as const) {
    for (const status of ['review', 'done', 'failed', 'cancelled'] as const) {
      it(`${phase}: reconciles ${status} even before park`, () => {
        const result = reconcileWorkerWait({ ...wait, phase }, [outcome(status)], now);
        expect(result).toEqual({ ...wait, phase: 'wake-pending', wakeId: wait.id, outcomes: [outcome(status)] });
      });
    }
  }
  it('ignores unrelated workers and retains earlier outcomes across reconciliations', () => {
    const other = randomUUID();
    expect(reconcileWorkerWait(wait, [{ ...outcome('done'), workerId: other }], now)).toBe(wait);
    const first = reconcileWorkerWait({ ...wait, workerIds: [workerId, other] }, [outcome('review')], now);
    const second = reconcileWorkerWait(first, [{ ...outcome('failed'), workerId: other }], now);
    expect(second.outcomes).toEqual([outcome('review'), { ...outcome('failed'), workerId: other }]);
    expect(reconcileWorkerWait(second, [], now)).toEqual(second);
    expect(reconcileWorkerWait(second, [outcome('done')], now).outcomes).toEqual(second.outcomes);
  });
});
