import { describe, expect, it } from 'vitest';
import { ciWaitSchema } from '@open-mercato/cezar-contract/ci-wait';
import type { CiWaitEntry, HumanWaitEntry, ProcessWaitEntry, TimerWaitEntry, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { chargesBudget, ciWatchRequest, identicalWait, isCezarHumanWait, isMonitoringTimer, MONITORING_WAKE_NUDGE, MONITORING_WAKE_NUDGE_MARKERS, normalizePrUrl, openWaitList, openWaits, openWaitsFooter, resolvedWaits, waitResultText } from './waits.ts';

// hearsay-tools/cezarion#1233: the wait list's pure helpers. RunManager behaviour lives in
// the ci-wait*.test.ts files and the U-cells in waits-parity-cells.testkit.ts.
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
    // hearsay-tools/cezarion#1234: a session without cezar tools was taught the markers instead.
    expect(waitResultText(timer({ via: 'monitoring-line' }), { tools: false })).toBe(MONITORING_WAKE_NUDGE_MARKERS);
    expect(MONITORING_WAKE_NUDGE_MARKERS).toContain('end with CEZ:MONITORING');
    // A session without cezar tools cannot register another wait, so its timer wake names the marker.
    expect(waitResultText(timer({ note: 'check the deploy' }), { tools: false })).toBe(`Timer ${timer().id} fired: check the deploy. Continue toward the task goal. If the watched work is still pending, end your final message with CEZ:MONITORING.`);
    expect(MONITORING_WAKE_NUDGE).not.toContain('CEZ:');
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

  it('omits tool guidance without tools while retaining waits and human reply guidance', () => {
    const human: HumanWaitEntry = { id: '55555555-5555-4555-8555-555555555555', kind: 'human', source: 'agent', via: 'cezar_ask',
      registeredAt: '2026-10-17T10:00:00.000Z', phase: 'open', turnId: 'turn-1', askSeq: 4 };
    const hidden: HumanWaitEntry = { ...human, source: 'cezar', via: 'no-wait' };
    expect(openWaitsFooter([timer({ via: 'monitoring-line' })], { tools: false })).toBe(
      `Still open: timer ${timer().id} at ${timer().deadline}.`);
    expect(openWaitsFooter([human, ci()], { tools: false })).toBe(
      `Still open: your question ${human.id} to the user; CI wait ${ci().id} for Acme/Repo#12, deadline ${ci().deadline}. The user's reply answers it.`);
    expect(openWaitsFooter([human], { tools: false })).toBe(`Still open: your question ${human.id} to the user. The user's reply answers it.`);
    expect(openWaitsFooter([hidden], { tools: false })).toBeUndefined();
    expect(openWaitsFooter([], { tools: false })).toBeUndefined();
    expect(openWaitsFooter([ci({ phase: 'resolved', result })], { tools: false })).toBeUndefined();
    expect(openWaitsFooter([ci()], { tools: true })).toBe(
      `Still open: CI wait ${ci().id} for Acme/Repo#12, deadline ${ci().deadline}. Call cezar_cancel_wait for any you no longer need.`);
  });

  it('footer lists an open worker wait', () => {
    const base = { id: '77777777-7777-4777-8777-777777777777', kind: 'worker', source: 'agent', via: 'cez-worker-wait', turnId: 'turn-1', timeoutSeconds: 600, mode: 'any',
      registeredAt: '2026-10-17T10:00:00.000Z', deadline: '2026-10-17T10:10:00.000Z', phase: 'open' } as const;
    const w = '88888888-8888-4888-8888-888888888888', x = '99999999-9999-4999-8999-999999999999';
    const byWorker: WorkerWaitEntry = { ...base, workerIds: [w, x], revisions: [], outcomes: [] };
    const byRequest: WorkerWaitEntry = { ...base, id: '77777777-7777-4777-8777-777777777778', requestIds: [w], requestOutcomes: [] };
    expect(openWaitsFooter([byWorker])).toBe(`Still open: worker wait ${byWorker.id} on 2 workers, deadline ${base.deadline}. Call cezar_cancel_wait for any you no longer need.`);
    expect(openWaitsFooter([byRequest])).toContain(`worker wait ${byRequest.id} on 1 request reply, deadline`);
    // The cezar_wait answer's open_waits summary reads the same.
    expect(openWaitList([byWorker, byRequest]).map(open => open.summary)).toEqual(['worker wait on 2 workers', 'worker wait on 1 request reply']);
    // Beside a question, the cancel guidance covers worker waits too.
    const human: HumanWaitEntry = { id: '55555555-5555-4555-8555-555555555555', kind: 'human', source: 'agent', via: 'cezar_ask',
      registeredAt: '2026-10-17T10:00:00.000Z', phase: 'open', turnId: 'turn-1', askSeq: 4 };
    expect(openWaitsFooter([human, byWorker])).toContain('call cezar_cancel_wait for any CI wait, worker wait, process wait or timer you no longer need.');
    // Cezar's completion wait has no deadline (hearsay-tools/cezarion#1301).
    const { deadline: _deadline, timeoutSeconds: _timeout, ...undated } = byWorker;
    const completion: WorkerWaitEntry = { ...undated, source: 'cezar', via: 'completion', mode: 'all' };
    expect(openWaitsFooter([completion])).toBe(`Still open: worker wait ${completion.id} on 2 workers, no deadline. Call cezar_cancel_wait for any you no longer need.`);
  });

  // hearsay-tools/cezarion#1234: the user's reply settles a question, and a question the user saw
  // cannot be cancelled, so the footer offers cezar_cancel_wait only for CI waits and timers.
  it('the footer says the reply answers an open question and offers cancel only for the rest', () => {
    const human: HumanWaitEntry = { id: '55555555-5555-4555-8555-555555555555', kind: 'human', source: 'agent', via: 'cezar_ask',
      registeredAt: '2026-10-17T10:00:00.000Z', phase: 'open', turnId: 'turn-1', askSeq: 4 };
    expect(openWaitsFooter([human])).toBe(`Still open: your question ${human.id} to the user. The user's reply answers it.`);
    expect(openWaitsFooter([human, ci()])).toBe(
      `Still open: your question ${human.id} to the user; CI wait ${ci().id} for Acme/Repo#12, deadline ${ci().deadline}. ` +
      `The user's reply answers your question; call cezar_cancel_wait for any CI wait, worker wait, process wait or timer you no longer need.`);
  });

  // Cezar's own wait stands in for a wait the agent never registered (hearsay-tools/cezarion#1234):
  // listing it back would tell the agent it asked the user something.
  it('leaves Cezar\'s own human wait out of the list and the footer the agent reads', () => {
    const noWait: HumanWaitEntry = { id: '66666666-6666-4666-8666-666666666666', kind: 'human', source: 'cezar', via: 'no-wait',
      registeredAt: '2026-10-17T10:00:00.000Z', phase: 'open', turnId: 'no-wait', askSeq: 7 };
    expect(isCezarHumanWait(noWait)).toBe(true);
    expect(isCezarHumanWait({ ...noWait, source: 'agent', via: 'cezar_ask' })).toBe(false);
    expect(openWaitList([noWait])).toEqual([]);
    expect(openWaitsFooter([noWait])).toBeUndefined();
    expect(openWaitsFooter([noWait, ci()])).toBe(
      `Still open: CI wait ${ci().id} for Acme/Repo#12, deadline ${ci().deadline}. Call cezar_cancel_wait for any you no longer need.`);
  });

  it('hands the CI watcher a valid schema-3 wait', () => {
    expect(ciWaitSchema.safeParse(ciWatchRequest(ci())).success).toBe(true);
  });
});

// hearsay-tools/cezarion#1446: a background command the agent started, watched by its PID.
describe('process waits', () => {
  const proc = (over: Partial<ProcessWaitEntry> = {}): ProcessWaitEntry => ({
    id: '77777777-7777-4777-8777-777777777777', kind: 'process', source: 'agent', via: 'cezar_wait', turnId: 'turn-1', timeoutSeconds: 1800,
    pid: 4242, startToken: 'boot:1', registeredAt: '2026-10-17T10:00:00.000Z', deadline: '2026-10-17T10:30:00.000Z', phase: 'open', ...over,
  });
  const observedAt = '2026-10-17T10:05:00.000Z';
  const settled = (result: ProcessWaitEntry['result'], over: Partial<ProcessWaitEntry> = {}) => proc({ phase: 'resolved', resolvedAt: observedAt, result, ...over });

  it('lists an open process wait with its deadline and PID', () => {
    expect(openWaitList([proc(), proc({ id: '88888888-8888-4888-8888-888888888888', note: 'build' })])).toEqual([
      { wait_id: proc().id, kind: 'process', deadline: proc().deadline, summary: 'process 4242' },
      { wait_id: '88888888-8888-4888-8888-888888888888', kind: 'process', deadline: proc().deadline, summary: 'process 4242: build' },
    ]);
  });

  it('a repeat matches the same PID, start token and exit file, whatever the timeout or note', () => {
    const open = proc({ exitFile: '/t/build.exit' });
    expect(identicalWait([open], { kind: 'process', pid: 4242, exit_file: 'build.exit', timeout_seconds: 60, note: 'x' }, 'turn-2', { startToken: 'boot:1', exitFile: '/t/build.exit' })).toBe(open);
    expect(identicalWait([open], { kind: 'process', pid: 4242, timeout_seconds: 60 }, 'turn-2', { startToken: 'boot:2', exitFile: '/t/build.exit' })).toBeUndefined();
    expect(identicalWait([open], { kind: 'process', pid: 4242, timeout_seconds: 60 }, 'turn-2', { startToken: 'boot:1' })).toBeUndefined();
    expect(identicalWait([{ ...open, phase: 'resolved' }], { kind: 'process', pid: 4242, timeout_seconds: 60 }, 'turn-2', { startToken: 'boot:1', exitFile: '/t/build.exit' })).toBeUndefined();
  });

  it('wakes with the outcome, the PID and the note, and nothing read from the command', () => {
    const id = proc().id;
    expect(waitResultText(settled({ outcome: 'exit_file', observedAt, exitCode: 0 }, { note: 'build' }))).toBe(`Process wait ${id} for PID 4242 (build): exited with code 0. Read the command's output with your own tools.`);
    expect(waitResultText(settled({ outcome: 'exit_file', observedAt, exitFileNote: 'not-an-exit-code' }))).toBe(`Process wait ${id} for PID 4242: exit file present, not an exit code. Read the command's output with your own tools.`);
    expect(waitResultText(settled({ outcome: 'exited', observedAt }))).toBe(`Process wait ${id} for PID 4242: exited, code unknown. Read the command's output with your own tools.`);
    expect(waitResultText(settled({ outcome: 'deadline', observedAt }))).toBe(`Process wait ${id} for PID 4242: still running at the deadline. Register another wait if you still need it.`);
    expect(waitResultText(settled({ outcome: 'error', observedAt, diagnostic: 'EACCES' }))).toBe(`Process wait ${id} for PID 4242: could not be checked (EACCES). Check it with your own tools.`);
  });

  it('the footer names the PID, the note and the deadline, and offers cancel', () => {
    const open = proc({ note: 'build' });
    expect(openWaitsFooter([open])).toBe(`Still open: process wait ${open.id} on PID 4242 (build), deadline ${open.deadline}. Call cezar_cancel_wait for any you no longer need.`);
  });

  it('a process wake is automatic, as a timer wake is; CI and worker wakes are not', () => {
    expect(chargesBudget(proc())).toBe(true);
    expect(chargesBudget(timer())).toBe(true);
    expect(chargesBudget(ci())).toBe(false);
  });
});
