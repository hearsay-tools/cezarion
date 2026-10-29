import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActiveRun, type ActiveRun } from '../active-run.ts';
import type { AgentSession } from '../../core/agent-runner.ts';
import type { RunRecord } from '../../runs/store.ts';
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
  const run = { id: 'run', status: 'running', waits: [], autoResumeAttempts: 2 } as unknown as RunRecord;
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
    openHumanAlias: call('humanAlias', { source: 'cezar' }), showCezarHumanWait: call('show', undefined),
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
  };
  const context = { store, semaphore: { monitoringWakeIntervalMinutes: call('interval', 1) } } as unknown as RunModuleContext;
  const settler = new TurnSettler(context, host as unknown as Host, 60_000, 10, 'wait for workers', 3600);
  log.length = 0;
  return { log, state, session, run, host, store, settler };
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

  it('ready calls the gate before clearing the pending nudge and dispatching the carrier', () => {
    const f = fixture();
    f.state.autonomousNudgePending = f.session;
    f.log.length = 0;
    decide({ kind: 'park' });
    f.settler.settleTurn('run', f.state, 'ready', { ...turn, done: true });
    order(f, ['gate', 'state:autonomousNudgePending', 'parkWaits', 'outcome']);
  });

  it('gate uses the supplied refusal without calling the gate again, and records only through the outcome seam', () => {
    const f = fixture();
    decide({ kind: 'park', refused: true });
    f.settler.settleTurn('run', f.state, 'gate', { ...turn, done: true }, refusal);
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
    f.state.agentInputError = failed ? 'checkpoint failed' : undefined;
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
