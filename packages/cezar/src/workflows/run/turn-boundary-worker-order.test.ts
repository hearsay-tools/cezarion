import { seedWaits } from '../../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { makeHumanWait, makeTimerWait, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_LIMIT } from '@open-mercato/cezar-contract/waits';
import { observationClock } from '../../core/observation-clock.testkit.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { TurnNudges } from './turn-nudges.ts';
import { WORKER_FALLBACK_NOTE } from '../turn-end.ts';

function workerFixture() {
  const f = boundaryOrderFixture();
  const parent = f.store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  f.store.updateRun(parent.id, { delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer'], receipts: [] } });
  f.store.move(parent.id, 'start');
  f.store.updateRun(f.run.id, { delegation: { role: 'worker', permissions: [], parentRunId: parent.id,
    workspace: { ownerRunId: f.run.id, resourceId: randomUUID(), kind: 'owned-isolated', path: f.root, branch: 'worker', baselineSha: 'a'.repeat(40) } } });
  vi.spyOn(f.questionHost, 'deliverConversationInput').mockImplementation(() => { f.log.push('parent-input'); });
  vi.spyOn(f.questionHost, 'routeWorkerQuestion').mockImplementation(id => {
    f.log.push('route');
    expect(f.store.getRun(parent.id)?.status).toBe(RUN_STATUS.running);
    f.questions.routeWorkerQuestion(id);
  });
  vi.spyOn(f.host, 'releaseSlot').mockImplementation(() => {
    f.log.push('release');
    f.log.push('reconcile');
    f.store.move(parent.id, 'fail', { error: 'synchronous release reconciliation' });
  });
  f.log.length = 0;
  return { ...f, parent };
}
function order(log: string[], expected: string[]): void {
  const selected = new Set(expected);
  expect(log.filter(item => selected.has(item))).toEqual(expected);
}
function clock() {
  return observationClock(() => /\bat (?:[^ (\n]+\.)?(?:armIdleTimer|armNoWaitNudgeReplyTimer) \(/.test(new Error().stack ?? ''));
}
afterEach(() => vi.restoreAllMocks());

it('worker turn-end no-wait routes parent ask before park and slot release', () => {
  clock();
  const f = workerFixture();
  f.settler.openTurnEndHumanWait(f.run.id, f.state, 'step', 'no-wait', 'cause', true);
  order(f.log, ['event:note', 'alias', 'event:ask.requested', 'prepare', 'boundary:human-wait-opened/prepare', 'surfaced', 'route',
    'event:worker-question-routed', 'parent-input', 'move', 'flush', 'line-park', 'release', 'reconcile', 'wake']);
  const parent = f.store.getRun(f.parent.id)!;
  const messages = parent.delegation?.role === 'root' ? parent.delegation.conversation?.messages ?? [] : [];
  expect(messages).toHaveLength(1); expect(messages[0]?.senderRunId).toBe(f.run.id);
  expect(parent.agentInputs?.map(input => input.id)).toEqual([messages[0]!.id]);
  expect(parent.status).toBe(RUN_STATUS.failed);
  expect(f.store.readEvents(f.run.id).filter(event => event.type === 'human-ask-closed')).toEqual([]);
  expect(f.store.getRun(f.run.id)?.status).toBe(RUN_STATUS.waiting);
  expect(f.store.readEvents(f.run.id).some(event => event.message === WORKER_FALLBACK_NOTE)).toBe(true);
});

it.each(['full', 'existing'] as const)('worker turn-end no-wait with %s ask parks without duplicate routing', mode => {
  clock();
  const f = workerFixture();
  if (mode === 'full') seedWaits(f.store, f.run.id, { waits: Array.from({ length: WAIT_LIMIT }, () => makeTimerWait()) });
  else {
    const event = f.store.appendEvent(f.run.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'Choice', question: 'Next?' }] });
    seedWaits(f.store, f.run.id, { waits: [makeHumanWait({ askSeq: event.seq })] });
  }
  const before = f.store.readEvents(f.run.id).filter(event => event.type === 'ask.requested').length;
  f.log.length = 0;
  f.settler.openTurnEndHumanWait(f.run.id, f.state, 'step', 'no-wait', 'cause', true);
  order(f.log, ['event:note', 'alias', 'move', 'release', 'reconcile', 'wake']);
  expect(f.log).not.toContain('route'); expect(f.log).not.toContain('prepare');
  expect(f.store.readEvents(f.run.id).filter(event => event.type === 'ask.requested')).toHaveLength(before);
  expect(f.store.getRun(f.parent.id)?.agentInputs ?? []).toEqual([]);
});

it('worker budget fallback writes note and parks without alias or parent request', () => {
  clock();
  const f = workerFixture();
  f.settler.openTurnEndHumanWait(f.run.id, f.state, 'step', 'budget', 'budget cause', true);
  order(f.log, ['event:note', 'move', 'flush', 'line-park', 'release', 'reconcile', 'wake']);
  expect(f.log).not.toContain('alias'); expect(f.log).not.toContain('route');
  expect(f.store.readEvents(f.run.id).filter(event => event.type === 'ask.requested')).toEqual([]);
  expect(f.store.getRun(f.run.id)?.waits ?? []).toEqual([]);
});

it('worker reply-bound fallback parks without alias or parent request', () => {
  const time = clock();
  const f = workerFixture();
  type Args = ConstructorParameters<typeof TurnNudges>;
  const nudges = new TurnNudges(f.context, f.humanWaits, f.line, unused<Args[3]>('gate'), unused<Args[4]>('nudgeHost', {
    active: f.active,
    openTurnEndHumanWait: (...args) => f.settler.openTurnEndHumanWait(...args),
    settledTurnOutcome: (_id, _entry, outcome) => { f.log.push('outcome'); return outcome; },
  }), 40, 'wait for workers', 60_000);
  nudges.armNoWaitNudgeReplyTimer(f.run.id, f.state);
  expect(time.captured).toBe(1);
  f.log.length = 0;
  time.fire(0);
  order(f.log, ['boundary:reply-expired/fired', 'boundary:reply-expired/park', 'event:note', 'move', 'release', 'reconcile', 'wake', 'outcome']);
  expect(f.log).not.toContain('alias'); expect(f.log).not.toContain('route');
  expect(f.state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  expect(f.state.boundary.noWaitNudgeParked).toBe(f.wire);
  expect(f.store.readEvents(f.run.id).filter(event => event.type === 'ask.requested')).toEqual([]);
});
