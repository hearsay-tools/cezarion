import { expect, it } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import { createActiveRun } from '../active-run.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import { transitionTurnBoundary, type BoundaryCarrierEffects, type BoundaryCarry } from './turn-boundary.ts';

function fixture() {
  const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: true });
  const session = unused<AgentSession>('runner');
  return { state, session };
}

it('keeps a done request, retained boundary, question and held-child fact independent', () => {
  const { state, session } = fixture();
  transitionTurnBoundary(state, { kind: 'done-request', session, summary: 'done' });
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'ui-completed', session });
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'save-ack', session, boundary: { session, monitoring: true, humanGate: true } });
  transitionTurnBoundary(state, { kind: 'human-wait-opened', phase: 'prepare', session });
  transitionTurnBoundary(state, { kind: 'wait-wake-admitted', phase: 'hold-children', session, held: true });
  const ack = state.boundary.parkAfterAck;
  transitionTurnBoundary(state, { kind: 'subagents-changed', phase: 'release', session });
  expect(state.boundary.heldForSubagents).toBeUndefined();
  expect(state.boundary.doneRequested?.session).toBe(session);
  expect(state.boundary.doneRequested?.summary).toBe('done');
  expect(state.boundary.atTurnBoundary).toBe(session);
  expect(state.boundary.pendingHumanAsk).toBe(true);
  expect(state.boundary.parkAfterAck).toBe(ack);
});

it('keeps close metadata for a refused done and clears only the accepted boundary', () => {
  const { state, session } = fixture();
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'record-done', session, done: false, request: { session, summary: 'summary' }, keepClose: true });
  const close = state.boundary.doneClose;
  expect(state.boundary.doneAtBoundary).toBeUndefined();
  expect(close).toEqual({ via: 'cezar_done', summary: 'summary' });
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'retain-done', session });
  expect(state.boundary.doneAtBoundary).toBe(session);
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'drop-done', session });
  expect(state.boundary.doneAtBoundary).toBeUndefined();
  expect(state.boundary.doneClose).toBe(close);
});

it('requires a second sent-request refusal in the same completion cycle to retain done', () => {
  const { state, session } = fixture();
  const refusal = { kind: 'completion-refusal' as const, phase: 'record' as const, session, code: 'requests_outstanding' as const, tool: true };
  transitionTurnBoundary(state, refusal);
  expect(state.boundary.doneRequested).toBeUndefined();
  transitionTurnBoundary(state, refusal);
  expect(state.boundary.doneRequested?.session).toBe(session);
  transitionTurnBoundary(state, { kind: 'turn-end', phase: 'consume-done', session });
  transitionTurnBoundary(state, { kind: 'input-submitted', phase: 'completion-cycle', session });
  transitionTurnBoundary(state, refusal);
  expect(state.boundary.doneRequested).toBeUndefined();
});

it('clears fired reply handles before caller generation checks, including a replaced session', () => {
  const { state, session } = fixture();
  const timer = unused<NodeJS.Timeout>('timer');
  transitionTurnBoundary(state, { kind: 'reply-expired', phase: 'armed', session, timer });
  const replacement = unused<AgentSession>('replacement');
  state.liveSession.attachSession(replacement);
  transitionTurnBoundary(state, { kind: 'reply-expired', phase: 'fired', session });
  expect(state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  expect(state.liveSession.session).toBe(replacement);
});

it('preserves synchronous named-effect return and throw boundaries', () => {
  const { state, session } = fixture();
  const failure = new Error('interrupt failed');
  const log: string[] = [];
  expect(() => transitionTurnBoundary('run', state, { kind: 'input-error', phase: 'interrupt', session }, {
    interruptSession(wire) { expect(wire).toBe(session); log.push('interrupt'); throw failure; },
  })).toThrow(failure);
  expect(log).toEqual(['interrupt']);
  expect(transitionTurnBoundary('run', state, { kind: 'held-input-expired', phase: 'expire', session }, {
    expireHeldInput() { log.push('expire'); },
  })).toBeUndefined();
  expect(log).toEqual(['interrupt', 'expire']);
});

it('dispatches one named carrier synchronously with the original payload and outcome', () => {
  const { state, session } = fixture();
  const log: string[] = [];
  const outcome = { kind: 'park' as const, keepsSlot: true };
  const carry: BoundaryCarry = { runId: 'run', state, session, stepId: 'step', refused: undefined, noteRefusal() { throw new Error('unexpected refusal'); }, settlesRefusal: false };
  const effects = unused<BoundaryCarrierEffects>('carriers', { park(received) { expect(received).toBe(carry); log.push('park'); return outcome; } });
  const result = transitionTurnBoundary('run', state, { kind: 'turn-end', phase: 'carry', session, carry, decision: { kind: 'park' } }, effects);
  expect(result).toBe(outcome); expect(log).toEqual(['park']);
});
