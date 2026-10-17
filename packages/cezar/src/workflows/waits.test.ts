import { describe, expect, it } from 'vitest';
import { ciWaitSchema, type CiWaitEntry, type TimerWaitEntry, type Wait } from '@open-mercato/cezar-contract';
import { ciWatchRequest, identicalWait, isMonitoringTimer, MONITORING_WAKE_NUDGE, normalizePrUrl, openWaitList, openWaits, openWaitsFooter, resolvedWaits, waitResultText } from './waits.ts';

// hearsay-tools/cezarion#1233: the wait list's pure helpers. RunManager behaviour lives in
// the ci-wait*.test.ts files and the U-cells in waits-parity.test.ts.
const ci = (over: Partial<CiWaitEntry> = {}): CiWaitEntry => ({
  id: '11111111-1111-4111-8111-111111111111', kind: 'ci', source: 'agent', via: 'cezar_wait', generation: 'gen', turnId: 'turn-1',
  timeoutSeconds: 1800, prUrl: 'https://github.com/Acme/Repo/pull/12', repository: 'Acme/Repo', prNumber: 12, headSha: 'a'.repeat(40),
  registeredAt: '2026-10-17T10:00:00.000Z', deadline: '2026-10-17T10:30:00.000Z', phase: 'open', ...over,
});
const timer = (over: Partial<TimerWaitEntry> = {}): TimerWaitEntry => ({
  id: '22222222-2222-4222-8222-222222222222', kind: 'timer', source: 'agent', via: 'cezar_wait', turnId: 'turn-1', seconds: 120,
  registeredAt: '2026-10-17T10:00:00.000Z', deadline: '2026-10-17T10:02:00.000Z', phase: 'open', ...over,
});
const result = { outcome: 'passed' as const, headSha: 'a'.repeat(40), observedAt: '2026-10-17T10:05:00.000Z', checks: [], totalChecks: 1, truncated: false };

describe('wait list helpers (hearsay-tools/cezarion#1233)', () => {
  it('splits open from resolved waits and orders resolved ones oldest resolvedAt first', () => {
    const late = timer({ id: '33333333-3333-4333-8333-333333333333', phase: 'resolved', resolvedAt: '2026-10-17T10:09:00.000Z' });
    const early = ci({ phase: 'resolved', resolvedAt: '2026-10-17T10:05:00.000Z', result });
    const open = timer();
    const waits: Wait[] = [late, open, early];
    expect(openWaits({ waits })).toEqual([open]);
    expect(resolvedWaits({ waits }).map(wait => wait.id)).toEqual([early.id, late.id]);
    expect(openWaits({})).toEqual([]);
    expect(resolvedWaits({})).toEqual([]);
  });

  it('lists open waits with a CI or timer summary for the tool answers', () => {
    expect(openWaitList([ci(), timer(), timer({ id: '33333333-3333-4333-8333-333333333333', note: 'check the deploy' }), ci({ id: '44444444-4444-4444-8444-444444444444', phase: 'resolved', result })])).toEqual([
      { wait_id: ci().id, kind: 'ci', deadline: ci().deadline, summary: 'CI for Acme/Repo#12' },
      { wait_id: timer().id, kind: 'timer', deadline: timer().deadline, summary: 'timer' },
      { wait_id: '33333333-3333-4333-8333-333333333333', kind: 'timer', deadline: timer().deadline, summary: 'timer: check the deploy' },
    ]);
    // The answer schema caps a summary at 256 characters, whatever the note holds.
    expect(openWaitList([timer({ note: 'x'.repeat(512) })])[0]!.summary).toHaveLength(256);
  });

  it('identical CI registration matches the same PR whatever its timeout or spelling', () => {
    const waits = [ci()];
    expect(identicalWait(waits, { kind: 'ci', pr: 'https://github.com/acme/repo/pull/12', timeout_seconds: 60 }, 'turn-9')).toBe(waits[0]);
    expect(identicalWait(waits, { kind: 'ci', pr: 'https://github.com/acme/repo/pull/13', timeout_seconds: 1800 }, 'turn-1')).toBeUndefined();
    // Only an open wait repeats: a resolved one is owed, and a new registration watches afresh.
    expect(identicalWait([ci({ phase: 'resolved', result })], { kind: 'ci', pr: ci().prUrl, timeout_seconds: 1800 }, 'turn-1')).toBeUndefined();
    expect(normalizePrUrl('https://github.com/Acme/Repo/pull/12/')).toBe('https://github.com/acme/repo/pull/12');
  });

  it('identical timer registration matches seconds and note inside one turn only', () => {
    const waits = [timer({ note: 'deploy' })];
    expect(identicalWait(waits, { kind: 'timer', seconds: 120, note: 'deploy' }, 'turn-1')).toBe(waits[0]);
    expect(identicalWait(waits, { kind: 'timer', seconds: 120, note: 'deploy' }, 'turn-2')).toBeUndefined();
    expect(identicalWait(waits, { kind: 'timer', seconds: 180, note: 'deploy' }, 'turn-1')).toBeUndefined();
    expect(identicalWait(waits, { kind: 'timer', seconds: 120 }, 'turn-1')).toBeUndefined();
  });

  it('keeps the CI observation text and names timers by their id and note', () => {
    const resolved = ci({ phase: 'resolved', result });
    expect(waitResultText(resolved)).toBe(`CI wait observation ${resolved.id} for ${resolved.prUrl}. External data follows: ${JSON.stringify(result)}. This observation is not merge approval or task completion. Reported checks may not include every expected workflow. Duplicate observations retain this ID.`);
    expect(waitResultText(timer({ note: 'check the deploy' }))).toBe(`Timer ${timer().id} fired: check the deploy. Continue toward the task goal; register another wait if you are still waiting.`);
    expect(waitResultText(timer())).toBe(`Timer ${timer().id} fired. Continue toward the task goal; register another wait if you are still waiting.`);
    expect(waitResultText(timer({ via: 'monitoring-line' }))).toBe(MONITORING_WAKE_NUDGE);
    expect(waitResultText(timer({ via: 'schedule-wakeup' }))).toBe(MONITORING_WAKE_NUDGE);
    expect(isMonitoringTimer(timer())).toBe(false);
    expect(isMonitoringTimer(ci())).toBe(false);
  });

  it('the footer lists every open wait and is absent when none is open', () => {
    expect(openWaitsFooter([])).toBeUndefined();
    expect(openWaitsFooter([ci({ phase: 'resolved', result })])).toBeUndefined();
    expect(openWaitsFooter([ci(), timer({ note: 'deploy' }), timer({ id: '33333333-3333-4333-8333-333333333333' })])).toBe(
      `Still open: CI wait ${ci().id} for Acme/Repo#12, deadline ${ci().deadline}; timer ${timer().id} at ${timer().deadline} (deploy); ` +
      `timer 33333333-3333-4333-8333-333333333333 at ${timer().deadline}. Call cezar_cancel_wait for any you no longer need.`);
  });

  it('hands the CI watcher a valid schema-3 wait', () => {
    expect(ciWaitSchema.safeParse(ciWatchRequest(ci())).success).toBe(true);
  });
});
