import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, makeRunRecord, makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession } from '../../core/agent-runner.ts';
import { createActiveRun } from '../active-run.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import { shouldReparkWithoutWaits } from './wake-admission.ts';

function stateAtBoundary(boundary: boolean) {
  const state = createActiveRun({ cwd: '.', autonomous: false, pendingHumanAsk: false });
  const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages() {},
    holdsHumanInput: () => false, end() {}, interrupt() {} };
  state.liveSession.attachSession(session);
  if (boundary) transitionTurnBoundary(state, { kind: 'turn-end', phase: 'ui-completed', session });
  return state;
}

afterEach(() => vi.restoreAllMocks());

describe('shouldReparkWithoutWaits', () => {
  it('rejects missing and nonwaiting records before reading park or boundary', () => {
    const state = new Proxy(stateAtBoundary(true), { get() { throw Error('state read before record guard'); } });
    const parked = vi.fn(() => { throw Error('park read before record guard'); });
    expect(shouldReparkWithoutWaits(undefined, parked, state)).toBe(false);
    expect(shouldReparkWithoutWaits(makeRunRecord({ status: RUN_STATUS.running }), parked, state)).toBe(false);
    expect(parked).not.toHaveBeenCalled();
  });

  it('checks park before boundary, and boundary before waits', () => {
    const trace: string[] = [];
    const state = new Proxy(stateAtBoundary(false), { get(target, key, receiver) {
      trace.push(String(key)); return Reflect.get(target, key, receiver);
    } });
    const run = makeRunRecord({ status: RUN_STATUS.waiting });
    Object.defineProperty(run, 'waits', { get: () => { throw Error('waits read past rejection'); } });
    expect(shouldReparkWithoutWaits(run, () => { trace.push('park'); return false; }, state)).toBe(false);
    expect(trace).toEqual(['park']);
    trace.length = 0;
    expect(shouldReparkWithoutWaits(run, () => { trace.push('park'); return true; }, state)).toBe(false);
    expect(trace).toEqual(['park', 'boundary', 'liveSession']);
  });

  it.each([{ waits: undefined }, { waits: [] }, { waits: [makeTimerWait()] }])('reparks at the boundary only with no waits: %j', ({ waits }) => {
    const state = stateAtBoundary(true);
    const trace: string[] = [];
    const run = makeRunRecord({ status: RUN_STATUS.waiting });
    Object.defineProperty(run, 'waits', { get: () => { trace.push('waits'); return waits; } });
    expect(shouldReparkWithoutWaits(run, () => { trace.push('park'); return true; }, state)).toBe(!waits?.length);
    expect(trace).toEqual(['park', 'waits']);
  });

  it('preserves equality when both session references are absent', () => {
    const state = createActiveRun({ cwd: '.', autonomous: false, pendingHumanAsk: false });
    expect(shouldReparkWithoutWaits(makeRunRecord({ status: RUN_STATUS.waiting }), () => true, state)).toBe(true);
  });
});
