import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { workerWaitRequestSchema, type WorkerOutcome, type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import type { WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { reconcileWorkerEntry, reconcileWorkerWait } from './wait.ts';

const now = '2026-09-06T12:00:00.000Z';
const workerId = randomUUID();
const wait: WorkerWait = { id: randomUUID(), workerIds: [workerId], deadline: '2026-09-06T12:10:00.000Z', phase: 'registered', outcomes: [] };
const outcome = (status: WorkerOutcome['status']): WorkerOutcome => ({ workerId, status, observedAt: now });

describe('reconcileWorkerWait', () => {
  it('does not settle a new revision with retained old observations', () => {
    const selected = { ...wait, revisions: [{ workerId, revision: 1 }], outcomes: [outcome('review')] };
    expect(reconcileWorkerWait(selected, [outcome('done')], now)).toMatchObject({ phase: 'registered', outcomes: [] });
    expect(reconcileWorkerWait(selected, [{ ...outcome('review'), revision: 1 }], now)).toMatchObject({ phase: 'wake-pending', reason: 'outcome', outcomes: [{ revision: 1 }] });
  });
  it('keeps an unexpired wait unchanged', () => {
    expect(reconcileWorkerWait(wait, [], now)).toBe(wait);
  });
  it('expires at the exact deadline with a stable wake ID', () => {
    const expired = reconcileWorkerWait(wait, [], wait.deadline!);
    expect(expired.phase).toBe('wake-pending');
    expect(expired.wakeId).toBe(wait.id);
    expect(reconcileWorkerWait(expired, [], wait.deadline!).wakeId).toBe(expired.wakeId);
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
    const expired = reconcileWorkerWait(partial, [], all.deadline!);
    expect(expired).toMatchObject({ phase: 'wake-pending', reason: 'timeout', outcomes: [outcome('done')] });
    expect(reconcileWorkerWait(expired, [{ ...outcome('done'), workerId: secondId }], all.deadline!).reason).toBe('timeout');
  });
  it('preserves outcome and cancellation reasons after the deadline', () => {
    const settled = reconcileWorkerWait(wait, [outcome('done')], now);
    expect(reconcileWorkerWait(settled, [], wait.deadline!).reason).toBe('outcome');
    const cancelled: WorkerWait = { ...wait, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id };
    expect(reconcileWorkerWait(cancelled, [outcome('done')], wait.deadline!).reason).toBe('cancelled');
  });
  it('infers legacy pending settlement from existing evidence before adding later observations', () => {
    const pending: WorkerWait = { ...wait, phase: 'wake-pending', wakeId: wait.id };
    expect(reconcileWorkerWait(pending, [outcome('done')], now).reason).toBe('timeout');
    expect(reconcileWorkerWait({ ...pending, outcomes: [outcome('done')] }, [], wait.deadline!).reason).toBe('outcome');
  });
  it('validates explicit one/any/all modes while preserving omitted legacy mode', () => {
    expect(workerWaitRequestSchema.parse({ workerIds: [workerId, secondId] })).toEqual({ workerIds: [workerId, secondId], timeoutSeconds: 600 });
    for (const mode of ['one', 'any', 'all']) expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId], mode }).success).toBe(true);
    expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId, secondId], mode: 'one' }).success).toBe(false);
    expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId], mode: 'unknown' }).success).toBe(false);
  });
});

describe('request selections in the shared wait', () => {
  const requestId = randomUUID(); const other = randomUUID();
  const selected: WorkerWait = { ...wait, workerIds: [], requestIds: [requestId, other], requestOutcomes: [], mode: 'all' };
  it('accumulates early replies and concurrent failures until every request settles', () => {
    const reply = { requestId, status: 'replied' as const, observedAt: now, replyId: randomUUID() };
    const partial = reconcileWorkerWait(selected, [], now, [reply]);
    expect(partial.phase).toBe('registered');
    expect(partial.requestOutcomes).toEqual([reply]);
    const failed = { requestId: other, status: 'failed' as const, observedAt: now };
    const settled = reconcileWorkerWait(partial, [], now, [reply, failed]);
    expect(settled).toMatchObject({ phase: 'wake-pending', reason: 'outcome', requestOutcomes: [reply, failed] });
    expect(reconcileWorkerWait(settled, [], wait.deadline!, [])).toEqual(settled);
  });
  it('request wait timeout keeps partial outcomes and ignores unrelated replies', () => {
    const partial = reconcileWorkerWait(selected, [], wait.deadline!, [{ requestId, status: 'replied', observedAt: now }, { requestId: randomUUID(), status: 'failed', observedAt: now }]);
    expect(partial.reason).toBe('timeout');
    expect(partial.requestOutcomes).toEqual([{ requestId, status: 'replied', observedAt: now }]);
  });
});

// hearsay-tools/cezarion#1235 phase 3a: the same rules, applied to a `worker` entry in the wait list.
describe('reconcileWorkerEntry', () => {
  const entry: WorkerWaitEntry = { id: randomUUID(), kind: 'worker', source: 'agent', via: 'cezar_wait', registeredAt: now,
    deadline: wait.deadline, timeoutSeconds: 600, turnId: 'turn', phase: 'open', workerIds: [workerId], revisions: [], outcomes: [] };
  it('reconcileWorkerEntry keeps first observations and matches revisions', () => {
    const selected = { ...entry, revisions: [{ workerId, revision: 1 }], outcomes: [outcome('review')] };
    expect(reconcileWorkerEntry(selected, [outcome('done')], now)).toEqual({ entry: { ...selected, outcomes: [] } });
    expect(reconcileWorkerEntry(selected, [{ ...outcome('review'), revision: 1 }], now))
      .toEqual({ entry: { ...selected, outcomes: [{ ...outcome('review'), revision: 1 }] }, reason: 'outcome' });
    // Unchanged and unexpired: the same object, so the caller writes nothing.
    expect(reconcileWorkerEntry(entry, [], now)).toEqual({ entry });
    expect(reconcileWorkerEntry(entry, [], now).entry).toBe(entry);
    expect(reconcileWorkerEntry(entry, [], entry.deadline!)).toEqual({ entry, reason: 'timeout' });
    // All mode: a partial outcome is kept and does not resolve; the first observation is durable.
    const other = randomUUID();
    const all = { ...entry, mode: 'all' as const, workerIds: [workerId, other] };
    const partial = reconcileWorkerEntry(all, [outcome('review')], now);
    expect(partial).toEqual({ entry: { ...all, outcomes: [outcome('review')] } });
    const complete = reconcileWorkerEntry(partial.entry, [outcome('done'), { ...outcome('failed'), workerId: other }], now);
    expect(complete).toEqual({ entry: { ...all, outcomes: [outcome('review'), { ...outcome('failed'), workerId: other }] }, reason: 'outcome' });
    // A timed-out all-mode wait keeps its partial outcomes.
    expect(reconcileWorkerEntry(partial.entry, [], all.deadline!)).toEqual({ entry: partial.entry, reason: 'timeout' });
    // Unrelated workers change nothing.
    expect(reconcileWorkerEntry(entry, [{ ...outcome('done'), workerId: other }], now).entry).toBe(entry);
    // A settled entry is never reconciled again.
    const resolved = { ...entry, phase: 'resolved' as const, result: { reason: 'outcome' as const } };
    expect(reconcileWorkerEntry(resolved, [outcome('done')], now)).toEqual({ entry: resolved });
  });
  it('reconcileWorkerEntry settles request entries by their own outcomes only', () => {
    const requestId = randomUUID(); const other = randomUUID();
    const { workerIds: _w, revisions: _r, outcomes: _o, ...base } = entry;
    const requests: WorkerWaitEntry = { ...base, requestIds: [requestId, other], requestOutcomes: [], mode: 'all' };
    const reply = { requestId, status: 'replied' as const, observedAt: now, replyId: randomUUID() };
    const partial = reconcileWorkerEntry(requests, [], now, [reply, { requestId: randomUUID(), status: 'failed', observedAt: now }]);
    expect(partial).toEqual({ entry: { ...requests, requestOutcomes: [reply] } });
    const failed = { requestId: other, status: 'failed' as const, observedAt: now };
    expect(reconcileWorkerEntry(partial.entry, [], now, [reply, failed])).toEqual({ entry: { ...requests, requestOutcomes: [reply, failed] }, reason: 'outcome' });
    expect(reconcileWorkerEntry(partial.entry, [], wait.deadline!, [])).toEqual({ entry: partial.entry, reason: 'timeout' });
  });
});
