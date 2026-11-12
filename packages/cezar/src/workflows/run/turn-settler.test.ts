import type { Wait } from '@open-mercato/cezar-contract/waits';
import { WaitEngine } from './wait-engine.ts';
import { traceBoundary } from './boundary-order.testkit.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import { InputDelivery } from './input-delivery.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActiveRun } from '../active-run.ts';
import type { AgentSession } from '../../core/agent-runner.ts';
import { makeRunRecord, makeSubagentWait, RUN_STATUS, WAIT_KIND, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import * as rule from '../turn-end.ts';
import type { CompletionRefusal } from '../completion-policy.ts';
import type { RunModuleContext, SettledTurn } from './types.ts';
import { TurnSettler } from './turn-settler.ts';

type Host = ConstructorParameters<typeof TurnSettler>[1];
const refusal: CompletionRefusal = { code: 'workers_outstanding', workers: [], message: 'workers remain', liveWorkerIds: ['worker'] };
const turn: SettledTurn = { stepId: 'step', monitoring: false, humanGate: false, ask: null, done: false, nudgedLastTurn: false };
const ask = { questions: [{ header: 'Choice', question: 'Which path?' }] };

function fixture() {
  const log: string[] = [];
  const call = <T>(name: string, result: T) => vi.fn(() => { log.push(name); return result; });
  const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
  traceBoundary(log);
  const session = { open: true, holdsHumanInput: call('holds', false), discardQueuedMessages: call('discard', undefined), end: call('end', undefined) } as unknown as AgentSession;
  state.liveSession.attachSession(session);
  state.liveSession.selectStep('step');
  const run = makeRunRecord({ id: 'run', status: RUN_STATUS.running, waits: [], autoResumeAttempts: 2 });
  const store = {
    getRun: () => run,
    transcriptFacts: () => ({}),
    appendEvent: vi.fn((_id: string, event: { type: string; message?: string }) => { log.push(`event:${event.type}`); }),
    updateRun: vi.fn((_id: string, patch: object) => { log.push(`update:${Object.keys(patch).join(',')}`); }),
    updateStep: call('step', undefined), flush: call('flush', undefined), commitWait: call('commitWait', undefined),
  };
  const humanWaits = {
    turnEndHumanWait: call<object | undefined>('humanWait', undefined),
    prepareHumanAsk: call('prepareAsk', undefined), raiseHumanGate: call('raiseGate', undefined),
    recordTurnEndQuestion: call('recordQuestion', undefined), holdsAgentWaits: call('agentWaits', false),
    humanWaitShown: call('shown', false), withdrawSquawkHumanWaits: vi.fn((_id: string) => { log.push('withdraw'); }),
    openHumanAlias: call('humanAlias', { source: WAIT_SOURCE.cezar }), showSquawkHumanWait: call('show', undefined),
    surfaceHumanWait: call('surface', undefined),
  };
  const host = {
    humanWaits, line: { isParked: call('isParked', false), inPool: call('inPool', false), park: call('parkLine', undefined) },
    waitRegistry: { registerCompletionWait: call('completionWait', undefined) },
    workerQuestions: { askParentForWorker: call('askParent', undefined) }, completionGateHost: { parentCompletionBlockers: () => [] },
    move: call('move', undefined), releaseSlot: call('release', undefined), completionGate: call('gate', 'accept' as 'accept' | 'held' | CompletionRefusal),
    countAutomaticWakes: call('wakes', 0), workerExecutionStopped: () => false,
    executionBlockedByRootFinish: () => false, submitAgentInput: call('submit', true), flushAgentInputs: call('input', false),
    hasQueuedAgentInputs: call('queued', false), armUnreadInputTimer: call('unread', undefined), armHeldHumanInputTimer: call('held', undefined),
    parkOnWaits: call('parkWaits', true), queueWaitWake: call('wake', undefined), leaveMonitoringPool: call('leavePool', undefined),
    chargeAutomaticWake: call('charge', 1), canAutoContinue: call('canContinue', true),
    sendTurnEndNudge: call('sendNudge', true), awaitCompletionNudgeReply: call('replyBound', undefined), noticeParkedWorker: call('notice', undefined),
    routeWorkerQuestion: call('route', undefined), settledTurnOutcome: call('outcome', undefined),
    subagentWaits: { atTurnEnd: call('subagentsAtTurnEnd', undefined), holdsLiveSubagents: vi.fn(() => false) },
  };
  const semaphore = { monitoringWakeIntervalMinutes: call<number | null>('interval', 1) };
  const context = { store, semaphore } as unknown as RunModuleContext;
  const waitEngine = new WaitEngine(context, unused<ConstructorParameters<typeof WaitEngine>[1]>('engine', {
    withdrawSquawkHumanWaits: id => host.humanWaits.withdrawSquawkHumanWaits(id),
  }), 10);
  const engine = { armWait: vi.spyOn(waitEngine as unknown as { armWait(id: string, wait: Wait): void }, 'armWait').mockImplementation((_id: string, _wait: Wait) => { log.push('armWait'); }) };
  vi.spyOn(waitEngine, 'cancelAll').mockImplementation(() => { log.push('cancelWaits'); });
  const settler = new TurnSettler(context, { ...host, waitEngine } as unknown as Host, 60_000, 10, 'wait for workers', 3600);
  log.length = 0;
  return { log, state, session, run, host, engine, store, semaphore, settler };
}

type Fixture = ReturnType<typeof fixture>;
function order(f: Fixture, expected: string[]) {
  const selected = new Set(expected);
  expect(f.log.filter(item => selected.has(item))).toEqual(expected);
}
function decide(...decisions: rule.TurnEndDecision[]) {
  const spy = vi.spyOn(rule, 'decideTurnEnd');
  for (const decision of decisions) spy.mockReturnValueOnce(decision);
  return spy;
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('turn settler entry orders', () => {
  it('turn-end consumes done before resetting nudges, saves boundary before settlement, then clears resume attempts', () => {
    const f = fixture();
    transitionTurnBoundary(f.state, { kind: 'done-request', session: f.state.liveSession.session });
    transitionTurnBoundary(f.state, { kind: 'input-submitted', phase: 'nudge-delivered', session: f.session });
    transitionTurnBoundary(f.state, { kind: 'completion-refusal', phase: 'nudge-delivered', session: f.session });
    decide({ kind: 'park' });
    f.host.subagentWaits.atTurnEnd.mockImplementation(() => {
      expect(f.state.boundary.noWaitNudged).toBeUndefined();
      expect(f.state.boundary.completionNudgeAnswered).toBe(f.session);
      expect(f.state.boundary.completionNudged).toBeUndefined();
      f.log.push('subagentsAtTurnEnd');
    });
    f.host.parkOnWaits.mockImplementation(() => {
      f.log.push('parkWaits'); expect(f.state.boundary.parkAfterAck?.session).toBe(f.session); return true;
    });
    f.log.length = 0;
    f.settler.endTurn('run', f.state, { handle: () => undefined } as unknown as UiEventSink, { stepId: 'step', scheduleWakeup: undefined });
    order(f, ['boundary:turn-end/consume-done', 'boundary:turn-end/reset-nudges', 'subagentsAtTurnEnd', 'boundary:turn-end/save-ack', 'parkWaits', 'outcome', 'update:autoResumeAttempts']);
  });

  it('turn-end discards queued input for a human wait card before preparing it and storing its boundary', () => {
    const f = fixture();
    decide({ kind: 'park' });
    f.host.humanWaits.turnEndHumanWait.mockImplementation(() => { f.log.push('humanWait'); return { kind: WAIT_KIND.human, ...ask }; });
    f.settler.endTurn('run', f.state, { handle: () => undefined } as unknown as UiEventSink, { stepId: 'step', scheduleWakeup: undefined });
    order(f, ['humanWait', 'discard', 'boundary:turn-end/reset-nudges', 'prepareAsk', 'boundary:turn-end/save-ack']);
  });

  // hearsay-tools/cezarion#2431: native subagents still running replace the monitoring timer.
  for (const subagents of [true, false]) {
    it(`turn-end ${subagents ? 'hands live subagents to the subagent wait before the rule decides, and opens no timer beside it' : 'without a subagent wait opens the timer ScheduleWakeup asks for'}`, () => {
      const f = fixture();
      f.host.subagentWaits.atTurnEnd.mockImplementation(() => { f.log.push('subagentsAtTurnEnd'); if (subagents) f.run.waits = [makeSubagentWait()]; });
      decide({ kind: 'take-input' }, { kind: 'park' });
      f.settler.endTurn('run', f.state, { handle: () => undefined } as unknown as UiEventSink, { stepId: 'step', scheduleWakeup: 300 });
      expect(f.host.subagentWaits.atTurnEnd).toHaveBeenCalledWith('run', f.state, { sessionOpen: true, done: false, asks: false });
      order(f, ['subagentsAtTurnEnd', 'boundary:turn-end/save-ack', ...(subagents ? [] : ['commitWait', 'armWait']), 'parkWaits']);
    });
  }

  it('ready calls the gate before clearing the pending nudge and dispatching the carrier', () => {
    const f = fixture();
    transitionTurnBoundary(f.state, { kind: 'input-ready', phase: 'retain-nudge', session: f.session });
    f.log.length = 0;
    transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'save-ack', session: f.state.liveSession.session, boundary: { session: f.session, monitoring: false, humanGate: true, nudgedLastTurn: true } });
    f.log.length = 0;
    const decision = decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ready', f.settler.boundaryTurn('run', f.state, f.session, true));
    expect(decision).toHaveBeenCalledWith(expect.objectContaining({ done: true, question: true, noWaitNudgedLastTurn: true }));
    order(f, ['gate', 'boundary:input-ready/clear-nudge', 'parkWaits', 'outcome']);
  });

  it('gate uses the supplied refusal without calling the gate again, and records only through the outcome seam', () => {
    const f = fixture();
    transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'save-ack', session: f.state.liveSession.session, boundary: { session: f.session, monitoring: false, humanGate: true, nudgedLastTurn: true } });
    const decision = decide({ kind: 'park', refused: true });
    f.settler.settleTurn('run', f.state, 'gate', f.settler.boundaryTurn('run', f.state, f.session, true), refusal);
    expect(decision).toHaveBeenCalledWith(expect.objectContaining({ done: true, question: true, noWaitNudgedLastTurn: true }));
    expect(f.host.completionGate).not.toHaveBeenCalled();
    expect(f.host.settledTurnOutcome).toHaveBeenCalledWith('run', 'gate', { kind: 'park', keepsSlot: false });
    order(f, ['event:note', 'parkWaits', 'notice', 'outcome']);
  });

  it.each(['ack', 'ready', 'gate'] as const)('held %s preserves boundary and input timer before reporting park', entry => {
    const f = fixture();
    transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'retain-done', session: f.session });
    vi.spyOn(Date, 'now').mockReturnValue(42);
    f.state.inputState.beginHeldClock();
    f.host.completionGate.mockImplementation(() => { f.log.push('gate'); return 'held'; });
    f.host.line.inPool.mockImplementation(() => {
      expect(f.state.boundary.doneAtBoundary).toBe(f.session); expect(f.state.inputState.heldHumanInputSince).toBe(42);
      f.log.push('inPool'); return false;
    });
    f.log.length = 0;
    f.settler.settleTurn('run', f.state, entry, { ...turn, done: true });
    expect(f.log).toEqual(['gate', 'inPool', 'outcome']);
  });

  it('held turn-end records the done and close metadata before the pool read', () => {
    const f = fixture();
    f.host.completionGate.mockImplementation(() => { f.log.push('gate'); return 'held'; });
    f.host.line.inPool.mockImplementation(() => {
      expect(f.state.boundary.doneAtBoundary).toBe(f.session);
      expect(f.state.boundary.doneClose).toEqual({ summary: 'finished', via: 'cezar_done' });
      f.log.push('inPool'); return false;
    });
    f.settler.settleTurn('run', f.state, 'turn-end', { ...turn, done: true, doneRequest: { session: f.session, summary: 'finished' } });
    order(f, ['gate', 'boundary:turn-end/record-done', 'inPool', 'outcome']);
  });

  it('take-input notes refusal before flushing, opens monitoring after a refused flush, then reads new facts', () => {
    const f = fixture();
    const spy = decide({ kind: 'take-input', refused: true }, { kind: 'park', refused: true });
    f.engine.armWait.mockImplementation(() => { f.log.push('armWait'); expect(spy).toHaveBeenCalledTimes(1); });
    f.settler.settleTurn('run', f.state, 'turn-end', { ...turn, done: true, monitoring: true }, refusal);
    order(f, ['queued', 'event:note', 'input', 'withdraw', 'commitWait', 'armWait', 'queued', 'unread', 'parkWaits', 'outcome']);
  });

  it('turn-end checkpoint arms unread then held timer before emitting, recording, and routing ask', () => {
    const f = fixture();
    decide({ kind: 'take-input' }, { kind: 'park' });
    f.host.flushAgentInputs.mockImplementation(() => { f.log.push('input'); return true; });
    vi.spyOn(f.session, 'holdsHumanInput').mockReturnValue(true);
    const sink = { handle: () => { f.log.push('emitAsk'); return 'event'; } } as unknown as UiEventSink;
    f.settler.settleTurn('run', f.state, 'turn-end', { ...turn, ask, sink });
    order(f, ['input', 'unread', 'held', 'emitAsk', 'recordQuestion', 'route', 'parkWaits', 'outcome']);
  });

  it('input checkpoint failure stops before ask emission or a carrier', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    decide({ kind: 'take-input' }, { kind: 'park' });
    vi.mocked(f.session.holdsHumanInput!).mockReturnValue(true);
    type InputArgs = ConstructorParameters<typeof InputDelivery>;
    const input = new InputDelivery(unused<InputArgs[0]>('input context'),
      unused<InputArgs[1]>('input host'), 10, 'workers');
    input.armHeldHumanInputTimer('run', f.state);
    const held = f.state.inputState.heldHumanInputTimer;
    expect(held).toBeDefined();
    vi.mocked(f.session.holdsHumanInput!).mockReturnValue(false);
    const clear = clearTimeout;
    let cleared = false;
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
      if (handle === held) {
        cleared = true;
        expect(f.log.slice(-2)).toEqual(['input', 'unread']);
        expect(f.log).not.toContain('emitAsk');
        expect(f.log).not.toContain('route');
        expect(f.log).not.toContain('parkWaits');
        expect(f.log).not.toContain('outcome');
      }
      clear(handle);
    });
    f.host.countAutomaticWakes.mockReturnValue(0);
    f.host.hasQueuedAgentInputs.mockReturnValue(false);
    f.host.humanWaits.holdsAgentWaits.mockReturnValue(false);
    f.log.length = 0;
    f.state.inputState.recordInputError('checkpoint failed');
    const result = f.settler.settleTurn('run', f.state, 'turn-end', { ...turn, ask });
    expect(result).toBe(false);
    expect(cleared).toBe(true);
    expect(f.state.inputState.heldHumanInputSince).toBeUndefined();
    expect(f.state.inputState.heldHumanInputExpired).toBeUndefined();
    expect(f.host.parkOnWaits).not.toHaveBeenCalled();
    expect(f.host.routeWorkerQuestion).not.toHaveBeenCalled();
    expect(f.host.settledTurnOutcome).not.toHaveBeenCalled();
  });
});


describe('turn settler carrier orders', () => {
  it.each(['closed', 'input', 'take-input'] as const)('%s has no carrier effects before the running outcome', kind => {
    const f = fixture();
    decide({ kind }, { kind });
    f.settler.settleTurn('run', f.state, 'ack', turn);
    expect(f.host.settledTurnOutcome).toHaveBeenCalledWith('run', 'ack', { kind: 'running' });
    expect(f.log.slice(f.log.lastIndexOf('wakes') + 1)).toEqual(['boundary:turn-end/carry', 'outcome']);
  });

  it.each(['closed', 'input', 'defer', 'park', 'human-wait', 'nudge', 'completion-wait'] as const)('withdraws settled refusal before the %s carrier, then records its outcome', kind => {
    vi.useFakeTimers();
    const f = fixture();
    const decisions: Record<typeof kind, rule.TurnEndDecision> = {
      closed: { kind: 'closed' }, input: { kind: 'input' }, defer: { kind: 'defer' }, park: { kind: 'park' },
      'human-wait': { kind: 'human-wait', via: WAIT_VIA.completion },
      nudge: { kind: 'nudge', cause: 'completion', ifRefused: 'park-for-user' }, 'completion-wait': { kind: 'completion-wait' },
    };
    decide(decisions[kind]);
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    const withdrawal = f.log.indexOf('withdraw');
    const outcome = f.log.indexOf('outcome');
    expect(withdrawal).toBeGreaterThan(-1);
    expect(outcome).toBeGreaterThan(withdrawal);
    const effects: Partial<Record<typeof kind, string>> = { park: 'parkWaits', 'human-wait': 'humanAlias', nudge: 'submit', 'completion-wait': 'completionWait' };
    const effect = effects[kind];
    if (effect) expect(f.log.indexOf(effect)).toBeGreaterThan(withdrawal);
    expect(f.log.at(-1)).toBe('outcome');
    expect(f.host.settledTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it('selected refusal is noted before the park carrier and its outcome', () => {
    const f = fixture();
    decide({ kind: 'park', refused: true });
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    order(f, ['event:note', 'parkWaits', 'notice', 'inPool', 'outcome']);
    expect(f.host.humanWaits.withdrawSquawkHumanWaits).not.toHaveBeenCalled();
  });

  it('done marks the step before summary, lifecycle, wait cancellation, and session close, without an outcome', () => {
    const f = fixture();
    transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'record-done', session: f.state.liveSession.session, done: false, keepClose: true, request: { session: f.state.liveSession.session!, summary: 'finished' } });
    decide({ kind: 'done' });
    f.settler.settleTurn('run', f.state, 'ack', { ...turn, done: true });
    order(f, ['boundary:done-step-consumed/completed', 'event:note', 'event:lifecycle', 'cancelWaits', 'end']);
    expect(f.state.boundary.completedStepId).toBe('step');
    expect(f.host.settledTurnOutcome).not.toHaveBeenCalled();
  });

  it.each([true, false])('park tries waits before user fallback, worker notice and slot report (waits=%s)', waits => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.parkOnWaits.mockImplementation(() => { f.log.push('parkWaits'); return waits; });
    decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ack', turn);
    order(f, ['parkWaits', ...(waits ? [] : ['move', 'release', 'wake']), 'notice', 'inPool', 'outcome']);
  });

  it('completion human wait notes refusal, opens and shows alias, then parks and notifies worker', () => {
    vi.useFakeTimers();
    const f = fixture();
    decide({ kind: 'human-wait', via: WAIT_VIA.completion });
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    order(f, ['withdraw', 'event:note', 'humanAlias', 'show', 'move', 'release', 'wake', 'notice', 'inPool', 'outcome']);
  });

  it.each([true, false])('completion nudge resets content before submission and completes the %s path in order', sent => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.submitAgentInput.mockImplementation(() => {
      expect(f.state.boundary.noWaitNudgeSawContent).toBe(false); f.log.push('submit'); return sent;
    });
    decide({ kind: 'nudge', cause: 'completion', ifRefused: 'park-for-user' });
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    const tail = sent ? ['replyBound', 'charge', 'event:note', 'outcome']
      : ['boundary:turn-end/retain-done', 'event:note', 'move', 'release', 'wake', 'notice', 'outcome'];
    order(f, ['withdraw', 'boundary:turn-end/reset-content', 'submit', ...tail]);
  });

  it('settled refusal withdraws human waits before the done carrier closes the session', () => {
    const f = fixture();
    decide({ kind: 'done' });
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    order(f, ['withdraw', 'boundary:done-step-consumed/completed', 'event:lifecycle', 'cancelWaits', 'end']);
    expect(f.host.settledTurnOutcome).not.toHaveBeenCalled();
  });

  it('completion wait notes the refusal before registering, parking and reporting the outcome', () => {
    const f = fixture();
    decide({ kind: 'completion-wait' });
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    order(f, ['withdraw', 'event:note', 'completionWait', 'parkWaits', 'notice', 'inPool', 'outcome']);
  });

  it.each(['no-wait', 'budget'] as const)('%s human wait opens and shows its alias before parking and recording the outcome', via => {
    vi.useFakeTimers();
    const f = fixture();
    decide({ kind: 'human-wait', via });
    f.settler.settleTurn('run', f.state, 'ack', turn);
    order(f, ['humanAlias', 'show', 'move', 'release', 'wake', 'notice', 'inPool', 'outcome']);
  });

  it('no-wait nudge sends before recording its outcome', () => {
    const f = fixture();
    decide({ kind: 'nudge', cause: 'no-wait', text: 'continue', ifRefused: 'human-wait' });
    f.settler.settleTurn('run', f.state, 'ack', turn);
    order(f, ['sendNudge', 'outcome']);
    expect(f.host.settledTurnOutcome).toHaveBeenCalledWith('run', 'ack', { kind: 'nudge', cause: 'no-wait', autonomous: false });
  });

  it('already parked non-turn-end does not park, release, or report another outcome', () => {
    const f = fixture();
    f.host.line.isParked.mockReturnValue(true);
    decide({ kind: 'park' });
    expect(f.settler.settleTurn('run', f.state, 'ack', turn)).toBe(true);
    expect(f.host.parkOnWaits).not.toHaveBeenCalled();
    expect(f.host.releaseSlot).not.toHaveBeenCalled();
    expect(f.host.settledTurnOutcome).not.toHaveBeenCalled();
  });

  // B8 (S7, .ai/specs/2026-11-03-run-store-owns-exits.md): the park exit settles its step in the
  // same write, so no step update follows the move.
  it('user park updates and flushes waiting before line, pool, idle bound, release and wake', () => {
    vi.useFakeTimers();
    const f = fixture();
    const arm = f.settler.armIdleTimer.bind(f.settler);
    vi.spyOn(f.settler, 'armIdleTimer').mockImplementation((id, state) => { f.log.push('idle'); arm(id, state); });
    f.settler.parkForUser('run', f.state, 'step');
    order(f, ['move', 'flush', 'parkLine', 'leavePool', 'idle', 'release', 'wake']);
    expect(f.host.move).toHaveBeenCalledWith('run', 'park', {}, { stepId: 'step' });
    expect(f.state.boundary.idleTimer).toBeDefined();
  });
});

describe('turn settler monitoring alias orders', () => {
  it('withdraws human waits, commits timer, then arms it before reading decision facts', () => {
    const f = fixture();
    decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ack', { ...turn, monitoring: true });
    order(f, ['interval', 'withdraw', 'commitWait', 'armWait', 'queued', 'parkWaits', 'outcome']);
    expect(f.store.commitWait).toHaveBeenCalledTimes(1);
  });

  it.each(['off', 'budget'] as const)('%s fallback notes the cause before opening its human alias', reason => {
    const f = fixture();
    if (reason === 'off') f.semaphore.monitoringWakeIntervalMinutes.mockReturnValue(null);
    else {
      f.host.countAutomaticWakes.mockReturnValue(10);
      f.host.humanWaits.openHumanAlias.mockImplementation(() => {
        expect(f.state.boundary.monitoringCapNoted).toBe(true);
        f.log.push('humanAlias'); return { source: WAIT_SOURCE.cezar };
      });
    }
    decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ack', { ...turn, monitoring: true });
    order(f, [...(reason === 'budget' ? ['boundary:turn-end/monitoring-cap'] : []), 'event:note', 'humanAlias', 'parkWaits', 'outcome']);
    expect(f.store.commitWait).not.toHaveBeenCalled();
    expect(f.engine.armWait).not.toHaveBeenCalled();
  });

  it('failed timer checkpoint leaves it unarmed before carrying out the park', () => {
    const f = fixture();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    f.store.commitWait.mockImplementation(() => { f.log.push('commitWait'); throw new Error('disk'); });
    decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ack', { ...turn, monitoring: true });
    order(f, ['withdraw', 'commitWait', 'queued', 'parkWaits', 'outcome']);
    expect(f.engine.armWait).not.toHaveBeenCalled();
  });

});


it('ACK refusal drops retained done after the gate and classification before carrying the decision', () => {
  const f = fixture();
  transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'retain-done', session: f.session });
  f.log.length = 0;
  f.host.completionGate.mockImplementation(() => { f.log.push('gate'); return refusal; });
  decide({ kind: 'park', refused: true });
  f.settler.settleTurn('run', f.state, 'ack', { ...turn, done: true });
  order(f, ['gate', 'boundary:turn-end/drop-done', 'event:note', 'boundary:turn-end/carry', 'parkWaits', 'outcome']);
  expect(f.state.boundary.doneAtBoundary).toBeUndefined();
});
