import { WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { observationClock } from '../../core/observation-clock.testkit.ts';
import { boundaryInputFixture } from './boundary-input-order.testkit.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

function selectedOrder(log: string[], expected: string[]): void {
  expect(log.filter(item => new Set(expected).has(item))).toEqual(expected);
}
function clockFor(method: string) {
  return observationClock(() => {
    return (new Error().stack ?? '').includes(`InputDelivery.${method}`);
  });
}
afterEach(() => vi.restoreAllMocks());

it('input error latches before interrupt and writes its error after a synchronous interrupt throw', () => {
  const f = boundaryInputFixture();
  vi.mocked(f.wire.interrupt).mockImplementation(() => {
    f.log.push('interrupt'); expect(f.state.inputState.agentInputError).toBe('initiating fault'); throw new Error('interrupt fault');
  });
  expect(() => f.delivery.latchAgentInputError(f.run.id, f.state, f.wire, 'initiating fault')).toThrow('interrupt fault');
  expect(f.log).toEqual(['boundary:input-error/interrupt', 'interrupt', 'event:error']);
  expect(f.store.readEvents(f.run.id).at(-1)?.message).toBe('initiating fault');
});

it('unread expiry retries before restoring the boundary and ACK and settling', () => {
  const f = boundaryInputFixture(); const clock = clockFor('armUnreadInputTimer');
  f.state.inputState.resetUnreadInputs(); f.state.inputState.recordUnreadInput('unread');
  f.delivery.armUnreadInputTimer(f.run.id, f.state);
  clock.fire(0);
  selectedOrder(f.log, ['event:note', 'retry-flush', 'boundary:unread-expired/restore-boundary', 'boundary:unread-expired/restore-ack', 'settle']);
  expect(f.state.boundary.atTurnBoundary).toBe(f.wire);
  expect(f.state.boundary.parkAfterAck?.session).toBe(f.wire);
  expect(f.state.inputState.unreadRetried?.has('unread')).toBe(true);
});

it('held expiry notes unconfirmed input before expiring it and settling', () => {
  const f = boundaryInputFixture(); const clock = clockFor('armHeldHumanInputTimer');
  vi.mocked(f.wire.holdsHumanInput).mockReturnValue(true);
  transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'ui-completed', session: f.wire });
  transitionTurnBoundary(f.state, { kind: 'unread-expired', phase: 'restore-ack', session: f.wire });
  f.delivery.armHeldHumanInputTimer(f.run.id, f.state); f.log.length = 0;
  clock.fire(0);
  selectedOrder(f.log, ['event:note', 'boundary:held-input-expired/expire', 'settle']);
  expect(f.state.inputState.heldHumanInputExpired).toBe(true);
});

it('stale unread and held callbacks cannot restore a replaced session boundary', () => {
  const f = boundaryInputFixture(); const unread = clockFor('armUnreadInputTimer');
  f.state.inputState.resetUnreadInputs(); f.state.inputState.recordUnreadInput('unread');
  f.delivery.armUnreadInputTimer(f.run.id, f.state);
  vi.mocked(f.wire.holdsHumanInput).mockReturnValue(true);
  const held = clockFor('armHeldHumanInputTimer'); f.delivery.armHeldHumanInputTimer(f.run.id, f.state);
  f.state.liveSession.retireSession(); f.log.length = 0;
  unread.fire(0); held.fire(0);
  expect(f.log).toEqual([]); expect(f.state.boundary.atTurnBoundary).toBeUndefined();
});

it('ready flushes durable input before retrying the retained autonomous boundary', () => {
  const f = boundaryInputFixture();
  transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'ui-completed', session: f.wire });
  transitionTurnBoundary(f.state, { kind: 'input-ready', phase: 'retain-nudge', session: f.wire });
  f.log.length = 0; f.delivery.handleAgentInputReady(f.run.id, f.state, f.wire);
  selectedOrder(f.log, ['input-flush', 'settle']);
  expect(f.state.boundary.autonomousNudgePending).toBe(f.wire);
});

it('human delivery commits its answer before question refresh and resume and resets monitoring last', () => {
  const f = boundaryInputFixture();
  f.store.appendEvent(f.run.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'Choice', question: 'Next?' }] });
  const commit = f.store.commitOutcome.bind(f.store);
  vi.spyOn(f.store, 'commitOutcome').mockImplementation((...args) => { f.log.push('answer-commit'); return commit(...args); });
  f.log.length = 0;
  expect(f.delivery.sendMessage(f.run.id, [{ type: 'text', text: 'Answer' }])).toBe(true);
  selectedOrder(f.log, ['event:user-message', 'human-input', 'boundary:input-submitted/human-delivered',
    'boundary:input-submitted/completion-cycle', 'event:human-input-delivered', 'answer-commit',
    'boundary:input-submitted/refresh-question', 'input-flush', 'boundary:input-submitted/resume', 'owed', 'unpark', 'resume',
    'boundary:input-submitted/monitoring-reset']);
  expect(f.state.boundary.pendingHumanAsk).toBe(false);
});

it('ack analysis retires markers before commit and effects follow commit before boundary settlement', async () => {
  const f = boundaryInputFixture();
  const id = randomUUID();
  f.store.commitAgentInputs(f.run.id, [{ id, parentRunId: randomUUID(), source: WAIT_SOURCE.agent, text: 'message', createdAt: new Date().toISOString() }]);
  f.state.inputState.retireInFlight(id);
  const commit = f.store.commitOutcome.bind(f.store);
  vi.spyOn(f.store, 'commitOutcome').mockImplementation((...args) => {
    f.log.push('ack-commit'); expect(f.state.inputState.retiredInFlight?.has(id)).toBe(false); return commit(...args);
  });
  f.log.length = 0;
  expect(f.delivery.submitAgentInput(f.run.id, f.state, [{ type: 'text', text: 'message' }], [id])).toBe(true);
  const settled = f.state.inputState.agentInputFlight?.settled; expect(settled).toBeDefined();
  await settled;
  selectedOrder(f.log, ['agent-input', 'track', 'boundary:input-submitted/resume', 'resume', 'boundary:input-submitted/completion-cycle',
    'ack-commit', 'reconcile', 'input-flush']);
  expect(f.state.inputState.agentInputFlight).toBeUndefined();
});

it('routed answer commits before retiring admission then refreshes question before flush and resume', () => {
  const f = boundaryInputFixture();
  const parentId = randomUUID();
  f.store.updateRun(f.run.id, { delegation: { role: 'worker', parentRunId: parentId, permissions: [],
    workspace: { ownerRunId: f.run.id, resourceId: randomUUID(), kind: 'owned-isolated', path: f.root, branch: 'worker', baselineSha: 'a'.repeat(40) } } });
  const ask = f.store.appendEvent(f.run.id, { type: 'ask.requested', requestId: 'question', questions: [{ header: 'Choice', question: 'Next?' }] });
  const reply = { id: randomUUID(), parentRunId: parentId, source: WAIT_SOURCE.agent, text: 'Answer', createdAt: new Date().toISOString() };
  f.store.commitAgentInputs(f.run.id, [reply]);
  vi.spyOn(f.inputHost.workerQuestions, 'pendingAnswer').mockReturnValue({ askSeq: ask.seq, source: 'parent', input: reply });
  const commit = f.store.commitOutcome.bind(f.store);
  vi.spyOn(f.store, 'commitOutcome').mockImplementation((...args) => { f.log.push('routed-commit'); return commit(...args); });
  f.log.length = 0; f.delivery.answerRoutedQuestion(f.run.id);
  selectedOrder(f.log, ['human-input', 'event:human-input-delivered', 'routed-commit', 'retire-admission',
    'boundary:input-ack/wake-turn', 'boundary:input-submitted/refresh-question', 'input-flush', 'boundary:input-submitted/resume', 'resume']);
  expect(f.state.boundary.pendingHumanAsk).toBe(false);
  expect(f.state.boundary.waitWakeTurn).toBe(f.wire);
});
