import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { workerWaitRequestSchema, type WorkerOutcome, type WorkerWait } from '@open-mercato/cezar-contract';
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
        expect(result).toEqual({ ...wait, phase: 'wake-pending', reason: 'outcome', wakeId: wait.id, outcomes: [outcome(status)] });
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

describe('wait modes and stable settlement', () => {
  const secondId = randomUUID();
  const all: WorkerWait = { ...wait, mode: 'all', workerIds: [workerId, secondId] };
  it('accumulates all-mode partial outcomes without waking until every worker settles', () => {
    const partial = reconcileWorkerWait(all, [outcome('done')], now);
    expect(partial.phase).toBe('registered');
    expect(partial.outcomes).toEqual([outcome('done')]);
    expect(reconcileWorkerWait(partial, [], now)).toBe(partial);
    const complete = reconcileWorkerWait(partial, [{ ...outcome('failed'), workerId: secondId }], now);
    expect(complete).toMatchObject({ phase: 'wake-pending', reason: 'outcome', wakeId: all.id });
    expect(complete.outcomes).toHaveLength(2);
  });
  it('times out all-mode with partial outcomes and never rewrites its reason after later completion', () => {
    const partial = reconcileWorkerWait({ ...all, phase: 'parked' }, [outcome('done')], now);
    expect(partial.phase).toBe('parked');
    const expired = reconcileWorkerWait(partial, [], all.deadline);
    expect(expired).toMatchObject({ phase: 'wake-pending', reason: 'timeout', outcomes: [outcome('done')] });
    expect(reconcileWorkerWait(expired, [{ ...outcome('done'), workerId: secondId }], all.deadline).reason).toBe('timeout');
  });
  it('preserves outcome and cancellation reasons after the deadline', () => {
    const settled = reconcileWorkerWait(wait, [outcome('done')], now);
    expect(reconcileWorkerWait(settled, [], wait.deadline).reason).toBe('outcome');
    const cancelled: WorkerWait = { ...wait, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id };
    expect(reconcileWorkerWait(cancelled, [outcome('done')], wait.deadline).reason).toBe('cancelled');
  });
  it('infers legacy pending settlement from existing evidence before adding later observations', () => {
    const pending: WorkerWait = { ...wait, phase: 'wake-pending', wakeId: wait.id };
    expect(reconcileWorkerWait(pending, [outcome('done')], now).reason).toBe('timeout');
    expect(reconcileWorkerWait({ ...pending, outcomes: [outcome('done')] }, [], wait.deadline).reason).toBe('outcome');
  });
  it('validates explicit one/any/all modes while preserving omitted legacy mode', () => {
    expect(workerWaitRequestSchema.parse({ workerIds: [workerId, secondId] })).toEqual({ workerIds: [workerId, secondId], timeoutSeconds: 600 });
    for (const mode of ['one', 'any', 'all']) expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId], mode }).success).toBe(true);
    expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId, secondId], mode: 'one' }).success).toBe(false);
    expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId], mode: 'unknown' }).success).toBe(false);
  });
});
