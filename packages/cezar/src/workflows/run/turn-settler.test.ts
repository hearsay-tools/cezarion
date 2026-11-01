import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActiveRun } from '../active-run.ts';
import type { AgentSession } from '../../core/agent-runner.ts';
import { makeRunRecord, makeSubagentWait, RUN_STATUS, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import * as rule from '../turn-end.ts';
import type { CompletionRefusal } from '../completion-policy.ts';
import type { RunModuleContext, SettledTurn } from './types.ts';
import { TurnSettler } from './turn-settler.ts';

type Host = ConstructorParameters<typeof TurnSettler>[1];
const refusal: CompletionRefusal = { code: 'workers_outstanding', workers: [], message: 'workers remain', liveWorkerIds: ['worker'] };
const turn: SettledTurn = { stepId: 'step', monitoring: false, humanGate: false, ask: null, askNudged: false, done: false, nudgedLastTurn: false };
const ask = { questions: [{ header: 'Choice', question: 'Which path?' }] };

function fixture() {
  const log: string[] = [];
  const call = <T>(name: string, result: T) => vi.fn(() => { log.push(name); return result; });
  const raw = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
  const state = new Proxy(raw, { set(target, key, value) {
    log.push(`state:${String(key)}`);
    return Reflect.set(target, key, value);
  } });
  const session = { open: true, holdsHumanInput: call('holds', false), discardQueuedMessages: call('discard', undefined), end: call('end', undefined) } as unknown as AgentSession;
  state.session = session;
  state.currentStepId = 'step';
  const run = makeRunRecord({ id: 'run', status: RUN_STATUS.running, waits: [], autoResumeAttempts: 2 });
  const store = {
    getRun: () => run,
    transcriptFacts: () => ({}),
    appendEvent: vi.fn((_id: string, event: { type: string; message?: string }) => { log.push(`event:${event.type}`); }),
    updateRun: vi.fn((_id: string, patch: object) => { log.push(`update:${Object.keys(patch).join(',')}`); }),
    updateStep: call('step', undefined), flush: call('flush', undefined), commitWait: call('commitWait', undefined),
  };
  const humanWaits = {
    turnEndHumanWait: call('humanWait', undefined), latchAskLineCard: call('latch', undefined),
    prepareHumanAsk: call('prepareAsk', undefined), raiseHumanGate: call('raiseGate', undefined),
    recordTurnEndQuestion: call('recordQuestion', undefined), holdsAgentWaits: call('agentWaits', false),
    humanWaitShown: call('shown', false), withdrawCezarHumanWaits: call('withdraw', undefined),
    openHumanAlias: call('humanAlias', { source: WAIT_SOURCE.cezar }), showCezarHumanWait: call('show', undefined),
    surfaceHumanWait: call('surface', undefined),
  };
  const host = {
    humanWaits, line: { isParked: call('isParked', false), inPool: call('inPool', false), park: call('parkLine', undefined) },
    waitWatches: { armWait: call('armWait', undefined) }, waitRegistry: { registerCompletionWait: call('completionWait', undefined) },
    workerQuestions: { askParentForWorker: call('askParent', undefined) }, completionGateHost: { parentCompletionBlockers: () => [] },
    move: call('move', undefined), releaseSlot: call('release', undefined), completionGate: call('gate', 'accept' as 'accept' | 'held' | CompletionRefusal),
    cancelOpenWaits: call('cancelWaits', undefined), countAutomaticWakes: call('wakes', 0), workerExecutionStopped: () => false,
    executionBlockedByRootFinish: () => false, submitAgentInput: call('submit', true), flushAgentInputs: call('input', false),
    hasQueuedAgentInputs: call('queued', false), armUnreadInputTimer: call('unread', undefined), armHeldHumanInputTimer: call('held', undefined),
    parkOnWaits: call('parkWaits', true), queueWaitWake: call('wake', undefined), leaveMonitoringPool: call('leavePool', undefined),
    chargeAutomaticWake: call('charge', 1), canAutoContinue: call('canContinue', true), tryAutonomousNudge: call('askNudge', false),
    sendTurnEndNudge: call('sendNudge', true), awaitCompletionNudgeReply: call('replyBound', undefined), noticeParkedWorker: call('notice', undefined),
    routeWorkerQuestion: call('route', undefined), settledTurnOutcome: call('outcome', undefined),
    subagentWaits: { atTurnEnd: call('subagentsAtTurnEnd', undefined) },
  };
  const semaphore = { monitoringWakeIntervalMinutes: call<number | null>('interval', 1) };
  const context = { store, semaphore } as unknown as RunModuleContext;
  const settler = new TurnSettler(context, host as unknown as Host, 60_000, 10, 'wait for workers', 3600);
  log.length = 0;
  return { log, state, session, run, host, store, semaphore, settler };
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
  it('turn-end consumes done before latching, resets nudges before preparing ask, saves boundary before settlement, then clears resume attempts', () => {
    const f = fixture();
    f.state.doneRequested = { session: f.session };
    f.state.noWaitNudged = f.session;
    f.state.completionNudged = f.session;
    decide({ kind: 'park' });
    f.host.humanWaits.latchAskLineCard.mockImplementation(() => {
      f.log.push('latch'); expect(f.state.doneRequested).toBeUndefined();
    });
    f.host.parkOnWaits.mockImplementation(() => {
      f.log.push('parkWaits'); expect(f.state.parkAfterAck?.session).toBe(f.session); return true;
    });
    f.log.length = 0;
    f.settler.endTurn('run', f.state, { handle: () => undefined } as unknown as UiEventSink, { stepId: 'step', text: '', completedText: '', scheduleWakeup: undefined });
    order(f, ['state:doneRequested', 'latch', 'state:noWaitNudged', 'state:completionNudgeAnswered', 'state:completionNudged', 'update:invalidAsk', 'state:parkAfterAck', 'parkWaits', 'outcome', 'update:autoResumeAttempts']);
  });

  it('turn-end latches and discards an ask before preparing it and storing its boundary', () => {
    const f = fixture();
    decide({ kind: 'park' });
    f.settler.endTurn('run', f.state, { handle: () => undefined } as unknown as UiEventSink, { stepId: 'step', text: `CEZ:ASK ${JSON.stringify(ask)}`, completedText: '', scheduleWakeup: undefined });
    order(f, ['latch', 'discard', 'state:noWaitNudged', 'update:invalidAsk', 'askNudge', 'prepareAsk', 'state:parkAfterAck']);
  });

  // hearsay-tools/cezarion#2431: native subagents still running replace the monitoring timer.
  for (const subagents of [true, false]) {
    it(`turn-end ${subagents ? 'hands live subagents to the subagent wait before the rule decides, and opens no timer beside it' : 'without a subagent wait opens the monitoring timer the line asks for'}`, () => {
      const f = fixture();
      f.host.subagentWaits.atTurnEnd.mockImplementation(() => { f.log.push('subagentsAtTurnEnd'); if (subagents) f.run.waits = [makeSubagentWait()]; });
      decide({ kind: 'take-input' }, { kind: 'park' });
      f.settler.endTurn('run', f.state, { handle: () => undefined } as unknown as UiEventSink, { stepId: 'step', text: 'Watching.\nCEZ:MONITORING', completedText: '', scheduleWakeup: undefined });
      expect(f.host.subagentWaits.atTurnEnd).toHaveBeenCalledWith('run', f.state, { sessionOpen: true, done: false, asks: false });
      order(f, ['subagentsAtTurnEnd', 'state:parkAfterAck', ...(subagents ? [] : ['commitWait', 'armWait']), 'parkWaits']);
    });
  }

  it('ready calls the gate before clearing the pending nudge and dispatching the carrier', () => {
    const f = fixture();
    f.state.autonomousNudgePending = f.session;
    f.log.length = 0;
    f.state.parkAfterAck = { session: f.session, monitoring: false, humanGate: true, nudgedLastTurn: true };
    f.log.length = 0;
    const decision = decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ready', f.settler.boundaryTurn('run', f.state, f.session, true));
    expect(decision).toHaveBeenCalledWith(expect.objectContaining({ done: true, question: true, noWaitNudgedLastTurn: true }));
    order(f, ['gate', 'state:autonomousNudgePending', 'parkWaits', 'outcome']);
  });

  it('gate uses the supplied refusal without calling the gate again, and records only through the outcome seam', () => {
    const f = fixture();
    f.state.parkAfterAck = { session: f.session, monitoring: false, humanGate: true, nudgedLastTurn: true };
    const decision = decide({ kind: 'park', refused: true });
    f.settler.settleTurn('run', f.state, 'gate', f.settler.boundaryTurn('run', f.state, f.session, true), refusal);
    expect(decision).toHaveBeenCalledWith(expect.objectContaining({ done: true, question: true, noWaitNudgedLastTurn: true }));
    expect(f.host.completionGate).not.toHaveBeenCalled();
    expect(f.host.settledTurnOutcome).toHaveBeenCalledWith('run', 'gate', { kind: 'park', keepsSlot: false });
    order(f, ['event:note', 'parkWaits', 'notice', 'outcome']);
  });

  it.each(['ack', 'ready', 'gate'] as const)('held %s preserves boundary and input timer before reporting park', entry => {
    const f = fixture();
    f.state.doneAtBoundary = f.session;
    f.state.heldHumanInputSince = 42;
    f.host.completionGate.mockImplementation(() => { f.log.push('gate'); return 'held'; });
    f.host.line.inPool.mockImplementation(() => {
      expect(f.state.doneAtBoundary).toBe(f.session); expect(f.state.heldHumanInputSince).toBe(42);
      f.log.push('inPool'); return false;
    });
    f.log.length = 0;
    f.settler.settleTurn('run', f.state, entry, { ...turn, done: true });
    expect(f.log).toEqual(['gate', 'inPool', 'outcome']);
  });

  it.each([false, true])('ask nudge clears done then held timer before the input error checkpoint (%s)', failed => {
    const f = fixture();
    if (failed) f.state.agentInputError = 'checkpoint failed';
    f.log.length = 0;
    const result = f.settler.settleTurn('run', f.state, 'turn-end', { ...turn, askNudged: true });
    expect(result).toBe(!failed);
    expect(f.log).toEqual(['state:doneAtBoundary', 'state:doneClose', 'state:heldHumanInputTimer', 'state:heldHumanInputSince', 'state:heldHumanInputExpired', ...(failed ? [] : ['outcome'])]);
  });

  it('take-input notes refusal before flushing, opens monitoring after a refused flush, then reads new facts', () => {
    const f = fixture();
    const spy = decide({ kind: 'take-input', refused: true }, { kind: 'park', refused: true });
    f.host.waitWatches.armWait.mockImplementation(() => { f.log.push('armWait'); expect(spy).toHaveBeenCalledTimes(1); });
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
    const f = fixture();
    decide({ kind: 'take-input' }, { kind: 'park' });
    f.state.agentInputError = 'checkpoint failed';
    const result = f.settler.settleTurn('run', f.state, 'turn-end', { ...turn, ask });
    expect(result).toBe(false);
    order(f, ['input', 'unread', 'state:heldHumanInputTimer', 'state:heldHumanInputSince', 'state:heldHumanInputExpired']);
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
    expect(f.log.slice(f.log.lastIndexOf('wakes') + 1)).toEqual(['outcome']);
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
    expect(f.host.humanWaits.withdrawCezarHumanWaits).not.toHaveBeenCalled();
  });

  it('done marks the step before summary, lifecycle, wait cancellation, and session close, without an outcome', () => {
    const f = fixture();
    f.state.doneClose = { via: 'cezar_done', summary: 'finished' };
    decide({ kind: 'done' });
    f.settler.settleTurn('run', f.state, 'ack', { ...turn, done: true });
    order(f, ['state:completedStepId', 'event:note', 'event:lifecycle', 'cancelWaits', 'end']);
    expect(f.state.completedStepId).toBe('step');
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
      expect(f.state.noWaitNudgeSawContent).toBe(false); f.log.push('submit'); return sent;
    });
    decide({ kind: 'nudge', cause: 'completion', ifRefused: 'park-for-user' });
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    const tail = sent ? ['replyBound', 'charge', 'event:note', 'outcome']
      : ['state:doneAtBoundary', 'event:note', 'move', 'release', 'wake', 'notice', 'outcome'];
    order(f, ['withdraw', 'state:noWaitNudgeSawContent', 'submit', ...tail]);
  });

  it('settled refusal withdraws human waits before the done carrier closes the session', () => {
    const f = fixture();
    decide({ kind: 'done' });
    f.settler.settleTurn('run', f.state, 'ack', turn, refusal);
    order(f, ['withdraw', 'state:completedStepId', 'event:lifecycle', 'cancelWaits', 'end']);
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

  it('user park updates and flushes waiting before line, pool, idle bound, release and wake', () => {
    vi.useFakeTimers();
    const f = fixture();
    const arm = f.settler.armIdleTimer.bind(f.settler);
    vi.spyOn(f.settler, 'armIdleTimer').mockImplementation((id, state) => { f.log.push('idle'); arm(id, state); });
    f.settler.parkForUser('run', f.state, 'step');
    order(f, ['move', 'step', 'flush', 'parkLine', 'leavePool', 'idle', 'release', 'wake']);
    expect(f.state.idleTimer).toBeDefined();
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
    else f.host.countAutomaticWakes.mockReturnValue(10);
    decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ack', { ...turn, monitoring: true });
    order(f, ['event:note', 'humanAlias', 'parkWaits', 'outcome']);
    expect(f.store.commitWait).not.toHaveBeenCalled();
    expect(f.host.waitWatches.armWait).not.toHaveBeenCalled();
  });

  it('failed timer checkpoint leaves it unarmed before carrying out the park', () => {
    const f = fixture();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    f.store.commitWait.mockImplementation(() => { f.log.push('commitWait'); throw new Error('disk'); });
    decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ack', { ...turn, monitoring: true });
    order(f, ['withdraw', 'commitWait', 'queued', 'parkWaits', 'outcome']);
    expect(f.host.waitWatches.armWait).not.toHaveBeenCalled();
  });

});
