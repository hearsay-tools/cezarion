import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { workerWaitRequestSchema, type WorkerOutcome } from '@open-mercato/cezar-contract/delegation';
import type { DeadlinedWorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { reconcileWorkerEntry } from './wait.ts';

const now = '2026-09-06T12:00:00.000Z';
const workerId = randomUUID();
const wait: DeadlinedWorkerWaitEntry = { id: randomUUID(), kind: WAIT_KIND.worker, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait,
  registeredAt: now, deadline: '2026-09-06T12:10:00.000Z', timeoutSeconds: 600, turnId: 'turn', phase: WAIT_PHASE.open,
  workerIds: [workerId], revisions: [], outcomes: [] };
const outcome = (status: WorkerOutcome['status']): WorkerOutcome => ({ workerId, status, observedAt: now });

describe('native worker entry reconciliation', () => {
  it('does not settle a new revision with retained old observations', () => {
    const selected = { ...wait, revisions: [{ workerId, revision: 1 }], outcomes: [outcome('review')] };
    expect(reconcileWorkerEntry(selected, [outcome('done')], now)).toEqual({ entry: { ...selected, outcomes: [] } });
    expect(reconcileWorkerEntry(selected, [{ ...outcome('review'), revision: 1 }], now))
      .toMatchObject({ entry: { outcomes: [{ revision: 1 }] }, reason: 'outcome' });
  });
  it('keeps an unexpired wait unchanged', () => {
    expect(reconcileWorkerEntry(wait, [], now).entry).toBe(wait);
  });
  it('expires at the exact deadline without changing the input phase', () => {
    expect(reconcileWorkerEntry(wait, [], wait.deadline)).toEqual({ entry: wait, reason: 'timeout' });
    expect(wait.phase).toBe(WAIT_PHASE.open);
  });
  for (const status of ['review', 'done', 'failed', 'cancelled'] as const) {
    it(`reconciles ${status} even before park`, () => {
      expect(reconcileWorkerEntry(wait, [outcome(status)], now)).toEqual({ entry: { ...wait, outcomes: [outcome(status)] }, reason: 'outcome' });
    });
  }
  it('never times out a completion wait without a deadline', () => {
    const { deadline: _d, timeoutSeconds: _t, ...base } = wait;
    const completion = { ...base, source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion };
    expect(reconcileWorkerEntry(completion, [], '2027-09-06T12:00:00.000Z').entry).toBe(completion);
    expect(reconcileWorkerEntry(completion, [outcome('done')], now).reason).toBe('outcome');
  });
  it('ignores unrelated workers', () => {
    expect(reconcileWorkerEntry(wait, [{ ...outcome('done'), workerId: randomUUID() }], now).entry).toBe(wait);
  });
  for (const mode of ['one', 'any'] as const) {
    it(`resolves ${mode} mode on an observed worker`, () => {
      expect(reconcileWorkerEntry({ ...wait, mode }, [outcome('done')], now).reason).toBe('outcome');
    });
  }
});

describe('wait modes', () => {
  const secondId = randomUUID();
  const all: DeadlinedWorkerWaitEntry = { ...wait, mode: 'all', workerIds: [workerId, secondId] };
  it('accumulates all-mode partial outcomes without waking until every worker settles', () => {
    const partial = reconcileWorkerEntry(all, [outcome('done')], now);
    expect(partial).toEqual({ entry: { ...all, outcomes: [outcome('done')] } });
    expect(reconcileWorkerEntry(partial.entry, [], now).entry).toBe(partial.entry);
    const complete = reconcileWorkerEntry(partial.entry, [{ ...outcome('failed'), workerId: secondId }], now);
    expect(complete.reason).toBe('outcome');
    expect(complete.entry.outcomes).toHaveLength(2);
  });
  it('keeps the same open entry when a later snapshot reports a different worker outcome', () => {
    const partial = { ...all, outcomes: [outcome('review')] };
    const result = reconcileWorkerEntry(partial, [outcome('done')], now);
    expect(result).toEqual({ entry: partial });
    expect(result.entry).toBe(partial);
    expect(result.entry.outcomes).toEqual([outcome('review')]);
  });
  it('times out all-mode with partial outcomes', () => {
    const partial = reconcileWorkerEntry(all, [outcome('done')], now);
    expect(reconcileWorkerEntry(partial.entry, [], all.deadline)).toEqual({ entry: partial.entry, reason: 'timeout' });
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
  const { workerIds: _w, revisions: _r, outcomes: _o, ...base } = wait;
  const selected: DeadlinedWorkerWaitEntry = { ...base, requestIds: [requestId, other], requestOutcomes: [], mode: 'all' };
  it('accumulates early replies and concurrent failures until every request settles', () => {
    const reply = { requestId, status: 'replied' as const, observedAt: now, replyId: randomUUID() };
    const partial = reconcileWorkerEntry(selected, [], now, [reply]);
    expect(partial).toEqual({ entry: { ...selected, requestOutcomes: [reply] } });
    const failed = { requestId: other, status: requestOutcomeSchema.shape.status.enum.failed, observedAt: now };
    expect(reconcileWorkerEntry(partial.entry, [], now, [reply, failed]))
      .toEqual({ entry: { ...selected, requestOutcomes: [reply, failed] }, reason: 'outcome' });
  });
  it('keeps the first request outcome and the same open entry on a repeated request', () => {
    const reply = { requestId, status: 'replied' as const, observedAt: now };
    const partial = { ...selected, requestOutcomes: [reply] };
    const result = reconcileWorkerEntry(partial, [], now, [{ requestId, status: requestOutcomeSchema.shape.status.enum.failed, observedAt: now }]);
    expect(result).toEqual({ entry: partial });
    expect(result.entry).toBe(partial);
    expect(result.entry.requestOutcomes).toEqual([reply]);
  });
  it('request wait timeout keeps partial outcomes and ignores unrelated replies', () => {
    const partial = reconcileWorkerEntry(selected, [], wait.deadline, [{ requestId, status: 'replied', observedAt: now }, { requestId: randomUUID(), status: requestOutcomeSchema.shape.status.enum.failed, observedAt: now }]);
    expect(partial.reason).toBe('timeout');
    expect(partial.entry.requestOutcomes).toEqual([{ requestId, status: 'replied', observedAt: now }]);
  });
});

// hearsay-tools/cezarion#1235 phase 3a: the same rules, applied to a `worker` entry in the wait list.
describe('reconcileWorkerEntry', () => {
  const entry: DeadlinedWorkerWaitEntry = { id: randomUUID(), kind: WAIT_KIND.worker, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: now,
    deadline: wait.deadline, timeoutSeconds: 600, turnId: 'turn', phase: WAIT_PHASE.open, workerIds: [workerId], revisions: [], outcomes: [] };
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
    const resolved = { ...entry, phase: WAIT_PHASE.resolved, result: { reason: 'outcome' as const } };
    expect(reconcileWorkerEntry(resolved, [outcome('done')], now)).toEqual({ entry: resolved });
  });
  it('reconcileWorkerEntry settles request entries by their own outcomes only', () => {
    const requestId = randomUUID(); const other = randomUUID();
    const { workerIds: _w, revisions: _r, outcomes: _o, ...base } = entry;
    const requests: DeadlinedWorkerWaitEntry = { ...base, requestIds: [requestId, other], requestOutcomes: [], mode: 'all' };
    const reply = { requestId, status: 'replied' as const, observedAt: now, replyId: randomUUID() };
    const partial = reconcileWorkerEntry(requests, [], now, [reply, { requestId: randomUUID(), status: requestOutcomeSchema.shape.status.enum.failed, observedAt: now }]);
    expect(partial).toEqual({ entry: { ...requests, requestOutcomes: [reply] } });
    const failed = { requestId: other, status: requestOutcomeSchema.shape.status.enum.failed, observedAt: now };
    expect(reconcileWorkerEntry(partial.entry, [], now, [reply, failed])).toEqual({ entry: { ...requests, requestOutcomes: [reply, failed] }, reason: 'outcome' });
    expect(reconcileWorkerEntry(partial.entry, [], wait.deadline!, [])).toEqual({ entry: partial.entry, reason: 'timeout' });
  });
});
