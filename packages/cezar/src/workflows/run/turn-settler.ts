import { randomUUID } from 'node:crypto';
import { TIMER_MAX_SECONDS, TIMER_MIN_SECONDS, WAIT_LIMIT, type HumanWaitEntry, type TimerWaitEntry, type WaitVia } from '@open-mercato/cezar-contract/waits';
import type { AgentSession } from '../../core/claude-cli-runner.ts';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { AskRequest } from '../../core/ask.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { RunExitId } from '../run-states.ts';
import type { ActiveRun } from '../active-run.ts';
import { openCompletionRequests, sentRequestInstructions, type CompletionRefusal } from '../completion-policy.ts';
import { NO_WAIT_NOTE, COMPLETION_NUDGE_NOTE, decideTurnEnd, type TurnEndDecision, type TurnEndFacts, type TurnEndOutcome } from '../turn-end.ts';
import { isCezarHumanWait, openWaits } from '../waits.ts';
import { classifyTurnEnd, discardQueuedMessagesOnAsk, emitAskRequested, type TurnEndRead } from './turn-markers.ts';
import { clearHeldHumanInputTimer, clearIdleTimer, harnessOwesInput, harnessHoldsHumanInput } from './input-timers.ts';
import { canProceedWithRun } from './run-guards.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { monitorsLiveWorkers, type CompletionGateHost } from './completion-gate.ts';
import type { RunModuleContext, SettledTurn } from './types.ts';
import type { HumanWaits } from './human-waits.ts';
import type { RunLine } from './run-line.ts';
import type { WaitWatches } from './wait-watches.ts';
import type { WaitRegistry } from './wait-registry.ts';
import type { WorkerQuestions } from './worker-questions.ts';

/** What `carryOutTurnEnd` hands the method for a decision kind. `session` is the session as the
 *  decision found it. */
type TurnEndCarry = {
  runId: string; state: ActiveRun; session: AgentSession | undefined; stepId: string | undefined;
  refused: CompletionRefusal | undefined; noteRefusal: () => void;
  /** The refusal settles this turn end, so Cezar's own human waits are already withdrawn. */
  settlesRefusal: boolean;
};
/** One method per decision kind of `decideTurnEnd` (`RunManager.turnEndCarriers`). */
type TurnEndCarriers = { [K in TurnEndDecision['kind']]: (carry: TurnEndCarry, decision: Extract<TurnEndDecision, { kind: K }>) => TurnEndOutcome };


interface TurnSettlerHost {
  humanWaits: HumanWaits; line: RunLine; waitWatches: WaitWatches; waitRegistry: WaitRegistry; workerQuestions: WorkerQuestions; completionGateHost: CompletionGateHost;
  move(id: string, exit: RunExitId): unknown; releaseSlot(): void; completionGate(id: string): 'accept' | 'held' | CompletionRefusal;
  cancelOpenWaits(id: string): void; countAutomaticWakes(id: string): number; workerExecutionStopped(id: string): boolean; executionBlockedByRootFinish(run: RunRecord): boolean;
  submitAgentInput(id: string, state: ActiveRun, content: ContentBlock[]): boolean; flushAgentInputs(id: string): boolean; hasQueuedAgentInputs(id: string, except?: readonly string[]): boolean;
  armUnreadInputTimer(id: string, state: ActiveRun): void; armHeldHumanInputTimer(id: string, state: ActiveRun): void;
  parkOnWaits(id: string, state: ActiveRun): boolean; queueWaitWake(id: string): void; leaveMonitoringPool(id: string): void; chargeAutomaticWake(id: string): number;
  canAutoContinue(id: string, state: ActiveRun): boolean; tryAutonomousNudge(id: string, state: ActiveRun, step: string, ask: AskRequest | null): boolean;
  sendTurnEndNudge(id: string, state: ActiveRun, step: string | undefined, text: string): boolean; awaitCompletionNudgeReply(id: string, state: ActiveRun, session: AgentSession): void;
  noticeParkedWorker(id: string): void; routeWorkerQuestion(id: string): void; settledTurnOutcome(id: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer', outcome: TurnEndOutcome): TurnEndOutcome | undefined;
}

export class TurnSettler {
  constructor(private readonly context: RunModuleContext, private readonly host: TurnSettlerHost,
    private readonly idleTimeoutMs: number, private readonly maxAutoContinues: number,
    private readonly completionWillWait: string, private readonly scheduleWakeupMaxSeconds: number) {}

  /** The `cezar_done` this session accepted since its last turn end, taken by this turn end: a
   *  later turn must call it again, as it must repeat the done line. */
  private takeDoneRequest(state: ActiveRun) {
    const request = state.doneRequested?.session === state.session ? state.doneRequested : undefined;
    state.doneRequested = undefined;
    return request;
  }

  /** The DONE boundary and close metadata; a refused DONE may retain metadata for readiness. */
  private recordDoneAtBoundary(state: ActiveRun, done: boolean, request: ActiveRun['doneRequested'], keepClose = done): void {
    state.doneAtBoundary = done ? state.session : undefined;
    state.doneClose = keepClose ? { via: request ? 'cezar_done' : 'done-line', ...(request?.summary === undefined ? {} : { summary: request.summary }) } : undefined;
  }

  /** Goal achieved (agent contract, #347): the summary `cezar_done` gave as a note, the closing
   *  event naming what declared it, every open wait cancelled (DONE ranks above every wait), and
   *  the session closes instead of parking, so the run completes and frees its slot. */
  private closeAsDone(runId: string, state: ActiveRun, session: AgentSession | undefined): void {
    const close = state.doneClose;
    // A workflow step that is not the last completes, and the next step starts (hearsay-tools/cezarion#1620).
    const step = !!session && state.nextStep?.session === session;
    state.completedStepId = state.currentStepId;
    if (close?.summary) this.context.store.appendEvent(runId, { type: 'note', message: close.summary });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: step ? 'step complete — session closed' : 'goal achieved — session closed', via: close?.via ?? 'done-line' });
    this.host.cancelOpenWaits(runId);
    session?.end();
  }

  /**
   * A turn end on the runner's own signal, shared by the fresh step's and the Continue's turn-end
   * handlers (hearsay-tools/cezarion#1525): read what the turn said, keep it for an acknowledgement
   * that lands after the turn end (`parkAfterAck`), then settle it (`settleTurn`). Nothing reads the
   * turn's prose beyond its markers.
   */
  endTurn(runId: string, state: ActiveRun, sink: UiEventSink, turn: {
    stepId: string; text: string; completedText: string; scheduleWakeup: number | null | undefined;
  }): void {
    const sessionOpen = !state.cancelled && !!state.session?.open;
    const humanWait = this.host.humanWaits.turnEndHumanWait(runId);
    const doneRequest = this.takeDoneRequest(state);
    const read = classifyTurnEnd(turn.text, turn.completedText, {
      sessionOpen, pendingHumanAsk: !!state.pendingHumanAsk,
      scheduledWake: turn.scheduleWakeup !== undefined,
      liveWorkers: monitorsLiveWorkers(this.context, this.host.completionGateHost, runId),
      humanWait, doneRequested: !!doneRequest,
    });
    const { monitoring, humanGate, ask } = read;
    this.host.humanWaits.latchAskLineCard(runId, humanWait, read);
    discardQueuedMessagesOnAsk(state.session, read);
    // The turn that just ended answered a nudge: one flag per cause (hearsay-tools/cezarion#1234,
    // hearsay-tools/cezarion#1301).
    const nudgedLastTurn = state.noWaitNudged === state.session;
    state.noWaitNudged = undefined;
    state.completionNudgeAnswered = state.completionNudged === state.session ? state.session : undefined;
    state.completionNudged = undefined;
    const askNudged = this.prepareTurnAsk(runId, state, { stepId: turn.stepId, sessionOpen, humanWait }, read);
    state.parkAfterAck = sessionOpen && state.session
      ? { session: state.session, monitoring, humanGate, nudgedLastTurn, scheduleWakeup: turn.scheduleWakeup } : undefined;
    const settled = this.settleTurn(runId, state, 'turn-end', {
      stepId: turn.stepId, monitoring, humanGate, ask, askNudged, humanWait, sink,
      done: read.done, doneRequest, nudgedLastTurn, scheduleWakeup: turn.scheduleWakeup,
    });
    // A turn that completed is the ONLY evidence the provider's window actually reopened, so
    // it is what retires the consecutive-resume counter — which in turn releases the account
    // hold for every other task queued behind it (spec
    // 2026-08-03-auto-resume-after-usage-limit). `settleSuccess` does the same for a run that
    // finishes outright; this covers the far more common "parked for the user" ending.
    if (settled && this.context.store.getRun(runId)?.autoResumeAttempts !== undefined) {
      this.context.store.updateRun(runId, { autoResumeAttempts: undefined });
    }
  }

  /** Prepare the turn's ask before the turn end settles (`endTurn`): its notes, the `invalidAsk`
   *  flag, and the ask or human gate the run parks on. True when the autonomous nudge went instead
   *  of the ask line. */
  private prepareTurnAsk(runId: string, state: ActiveRun, turn: { stepId: string; sessionOpen: boolean; humanWait: HumanWaitEntry | undefined },
    read: TurnEndRead): boolean {
    const { humanGate, ask, notes: askNotes, waitCard } = read;
    for (const note of askNotes) this.context.store.appendEvent(runId, { type: 'note', stepId: turn.stepId, ...note });
    this.context.store.updateRun(runId, { invalidAsk: !ask && askNotes.length > 0 ? true : undefined });
    // An autonomous run registers no newly parsed ask line before the budget, as `cezar_ask`
    // refuses it (hearsay-tools/cezarion#1234): the autonomous nudge goes instead. Do this before
    // prepareHumanAsk latches it; an existing/native ask or a human wait's card still blocks the helper.
    const askNudged = !!ask && !waitCard && turn.sessionOpen && this.host.tryAutonomousNudge(runId, state, turn.stepId, ask);
    if (ask && !askNudged) this.host.humanWaits.prepareHumanAsk(state);
    if (humanGate && !ask && !state.pendingHumanAsk) this.host.humanWaits.raiseHumanGate(runId, state);
    if (humanGate && !ask) this.host.humanWaits.recordTurnEndQuestion(runId, state, turn.humanWait, null);
    return askNudged;
  }

  /** The turn end an entry settles after it (`settleIdleBoundary`, `handleAgentInputReady`), and
   *  the completion gate's live refusal: what `parkAfterAck` kept of it. */
  boundaryTurn(runId: string, state: ActiveRun, session: AgentSession, done: boolean): SettledTurn {
    const ack = state.parkAfterAck?.session === session ? state.parkAfterAck : undefined;
    return {
      stepId: state.currentStepId, humanGate: !!ack?.humanGate, ask: null, askNudged: false, done,
      // A done names no monitoring, as the turn end's own reading of it does (`classifyTurnEnd`).
      monitoring: !done && !!ack && (ack.monitoring || (!ack.humanGate && monitorsLiveWorkers(this.context, this.host.completionGateHost, runId))),
      nudgedLastTurn: !!ack?.nudgedLastTurn, scheduleWakeup: ack?.scheduleWakeup,
    };
  }

  /**
   * Settle a turn end (hearsay-tools/cezarion#1525). Every entry goes through it: the turn end
   * itself (`turn-end`, a fresh step or a Continue), an acknowledgement that lands after it
   * (`ack`), input readiness for a refused autonomous nudge (`ready`), and the completion gate's
   * refusal of a live session's done outside a turn end (`gate`). It takes a done to the completion
   * gate, gathers the facts, lets the pure rule (`decideTurnEnd`) decide and carries out the
   * decision. False when nothing was settled: the done closed the session, or the input checkpoint
   * failed.
   */
  settleTurn(runId: string, state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn,
    refusal?: CompletionRefusal): boolean {
    const session = state.session;
    const stepId = turn.stepId;
    // A done goes to the completion gate first (hearsay-tools/cezarion#1301). A refused done is not a done.
    const gate = refusal ?? (turn.done && session?.open ? this.host.completionGate(runId) : 'accept');
    if (gate === 'held') return this.settleHeldTurn(runId, state, entry, turn);
    const refused = typeof gate === 'object' ? gate : undefined;
    if (entry === 'ready') state.autonomousNudgePending = undefined;
    let noted = false;
    const noteRefusal = () => {
      if (!refused || noted) return;
      noted = true;
      this.context.store.appendEvent(runId, { type: 'note', tone: 'warning', ...(stepId ? { stepId } : {}), message: `Completion blocked: ${refused.message}` });
    };
    if (turn.askNudged) return this.settleAskNudgedTurn(runId, state, entry, turn);
    const { decision, tried } = this.decideSettledTurn(runId, state, session, entry, turn, refused, noteRefusal);
    if (entry === 'turn-end' && !this.settleTurnEndInput(runId, state, turn, tried, decision)) return false;
    // A run an earlier entry already parked keeps that park: a second one would free its slot twice.
    if (entry !== 'turn-end' && decision.kind === 'park' && this.host.line.isParked(runId)) return true;
    const outcome = this.carryOutTurnEnd(runId, state, stepId, decision, refused, noteRefusal);
    if (outcome.kind === 'done') return false;
    this.host.settledTurnOutcome(runId, entry, outcome);
    return true;
  }

  /** The completion gate held the done (`settleTurn`). A stopped root, or a question that parked
   *  for the user: the done stays at the boundary. False when the input checkpoint failed. */
  private settleHeldTurn(runId: string, state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn): boolean {
    if (entry === 'turn-end') {
      this.recordDoneAtBoundary(state, true, turn.doneRequest);
      clearHeldHumanInputTimer(state);
      if (state.agentInputError) return false;
    }
    this.host.settledTurnOutcome(runId, entry, { kind: 'park', keepsSlot: this.host.line.inPool(runId) });
    return true;
  }

  /** The ask line's autonomous nudge went instead of the question (`settleTurn`): its turn is the
   *  next one. False when the input checkpoint failed. */
  private settleAskNudgedTurn(runId: string, state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn): boolean {
    this.recordDoneAtBoundary(state, false, turn.doneRequest);
    clearHeldHumanInputTimer(state);
    if (state.agentInputError) return false;
    this.host.settledTurnOutcome(runId, entry, { kind: 'nudge', cause: 'no-wait', autonomous: true });
    return true;
  }

  /** What the turn-end rule decides for a settled turn (`settleTurn`): the timer alias the rule
   *  reads, the first decision and the done it keeps, then the owed input a `take-input` decision
   *  tries and the decision after it. `tried` is true when that input was tried. */
  private decideSettledTurn(runId: string, state: ActiveRun, session: AgentSession | undefined, entry: 'turn-end' | 'ack' | 'ready' | 'gate',
    turn: SettledTurn, refused: CompletionRefusal | undefined, noteRefusal: () => void): { decision: TurnEndDecision; tried: boolean } {
    // A turn end opens it once owed input was tried; this turn's ask keeps that input back, so its
    // monitoring line opens the timer now. A refused done decides before any alias, as before.
    if (entry !== 'turn-end' || (turn.ask && !refused)) this.openTurnTimerAlias(runId, state, session, turn);
    // The turn end and the gate deliver owed input; an acknowledgement or readiness finds it already tried.
    const decision = decideTurnEnd(this.turnEndFacts(runId, state, session, turn, refused, entry === 'turn-end' || entry === 'gate' ? undefined : false));
    this.keepSettledDone(state, entry, turn, refused, decision);
    if (decision.kind !== 'take-input') return { decision, tried: false };
    if (decision.refused) noteRefusal();
    const taken = this.takeOwedInput(runId, state, turn);
    if (!taken) this.openTurnTimerAlias(runId, state, session, turn);
    return { decision: decideTurnEnd(this.turnEndFacts(runId, state, session, turn, refused, taken)), tried: true };
  }

  /** The facts the turn-end rule reads for a settled turn (`decideSettledTurn`). `session` is the
   *  session `settleTurn` found. */
  private turnEndFacts(runId: string, state: ActiveRun, session: AgentSession | undefined, turn: SettledTurn,
    refused: CompletionRefusal | undefined, inputTaken: boolean | undefined): TurnEndFacts {
    const run = this.context.store.getRun(runId);
    return {
      sessionOpen: !state.cancelled && !!session?.open,
      done: turn.done,
      ...(refused ? { doneRefused: { liveWorkers: refused.liveWorkerIds.length > 0 || !!refused.requestIds?.length } } : {}),
      inputInFlight: !!state.agentInputFlight,
      inputQueued: this.host.hasQueuedAgentInputs(runId, state.agentInputFlight?.inputIds),
      inputTaken,
      nudgePending: !!session && state.autonomousNudgePending === session,
      turnAsk: !!turn.ask,
      nativeAsk: !!state.pendingHumanAsk,
      question: !!turn.ask || turn.humanGate || !!state.pendingHumanAsk || hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id)),
      agentWaits: this.host.humanWaits.holdsAgentWaits(runId),
      cezarHumanWait: (run?.waits ?? []).some(isCezarHumanWait),
      stepScope: !!session && state.nextStep?.session === session,
      noWaitNudgedLastTurn: turn.nudgedLastTurn,
      completionNudgedLastTurn: (!!session && state.completionNudgeAnswered === session) || (!!refused?.requestIds?.length && !!state.sentRequestRefused),
      autonomous: !!state.autonomous,
      budgetSpent: this.host.countAutomaticWakes(runId) >= this.maxAutoContinues,
    };
  }

  /** The monitoring line and `ScheduleWakeup` open their timer before the rule reads the waits, as
   *  the `cezar_wait` timer they alias. An autonomous nudge waiting for readiness keeps precedence. */
  private openTurnTimerAlias(runId: string, state: ActiveRun, session: AgentSession | undefined, turn: SettledTurn): void {
    if (turn.monitoring && session?.open && state.autonomousNudgePending !== session) this.openTimerAlias(runId, state, turn.scheduleWakeup);
  }

  /** The done the first decision keeps at the boundary (`decideSettledTurn`): a turn end records
   *  it, and an acknowledgement drops a refused done the rule does not keep. */
  private keepSettledDone(state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn,
    refused: CompletionRefusal | undefined, decision: TurnEndDecision): void {
    const keepDone = turn.done && (!refused || (decision.kind === 'defer' && !!decision.keepDone));
    if (entry === 'turn-end') this.recordDoneAtBoundary(state, keepDone, turn.doneRequest, turn.done);
    else if (entry === 'ack' && turn.done && !keepDone) state.doneAtBoundary = undefined;
  }

  /** The owed input a `take-input` decision tries (`decideSettledTurn`). True when input was taken.
   *  #505: input the harness accepted but has not read yet runs as its next turn. An in-flight
   *  submission is settled by its acknowledgement (parkAfterAck), not here. */
  private takeOwedInput(runId: string, state: ActiveRun, turn: SettledTurn): boolean {
    return this.host.flushAgentInputs(runId) || (!turn.humanGate && harnessOwesInput(state)) ||
      !!state.agentInputFlight || harnessHoldsHumanInput(state);
  }

  /** A turn end's own steps after the rule decided (`settleTurn`): the unread and held input timers,
   *  then the `CEZ:ASK` card. False when the input checkpoint failed. */
  private settleTurnEndInput(runId: string, state: ActiveRun, turn: SettledTurn, tried: boolean, decision: TurnEndDecision): boolean {
    if (tried) this.host.armUnreadInputTimer(runId, state);
    if (tried && harnessHoldsHumanInput(state)) this.host.armHeldHumanInputTimer(runId, state);
    else clearHeldHumanInputTimer(state);
    if (state.agentInputError) return false;
    // `CEZ:ASK` surfaces the structured question as an ask card (#473) before the rule parks on it.
    if (turn.ask && turn.sink && decision.kind !== 'closed' && decision.kind !== 'input' && !this.host.humanWaits.humanWaitShown(runId, turn.humanWait)) {
      emitAskRequested(turn.sink, turn.ask);
      this.host.humanWaits.recordTurnEndQuestion(runId, state, turn.humanWait, turn.ask);
      this.host.routeWorkerQuestion(runId);
    }
    return true;
  }

  /** Carry out what the turn-end rule decided, and report how it left the run. A refusal the
   *  decision follows is noted first; then the decision kind's own method runs (`turnEndCarriers`). */
  private carryOutTurnEnd(runId: string, state: ActiveRun, stepId: string | undefined, decision: TurnEndDecision,
    refused: CompletionRefusal | undefined, noteRefusal: () => void): TurnEndOutcome {
    const session = state.session;
    const decisionRefused = 'refused' in decision && !!decision.refused;
    if (decisionRefused) noteRefusal();
    // A refusal that settles the turn end replaces Cezar's own human wait, as the agent's own wait would.
    const settlesRefusal = !!refused && !decisionRefused && !(decision.kind === 'defer' && decision.keepDone);
    if (settlesRefusal) this.host.humanWaits.withdrawCezarHumanWaits(runId);
    const carryOut = this.turnEndCarriers[decision.kind] as (carry: TurnEndCarry, decision: TurnEndDecision) => TurnEndOutcome;
    return carryOut({ runId, state, session, stepId, refused, noteRefusal, settlesRefusal }, decision);
  }

  private readonly turnEndCarriers: TurnEndCarriers = {
    closed: () => ({ kind: 'running' }),
    input: () => ({ kind: 'running' }),
    'take-input': () => ({ kind: 'running' }),
    defer: (carry, decision) => this.carryOutDefer(carry, decision),
    done: carry => this.carryOutDone(carry),
    park: carry => this.carryOutPark(carry),
    'completion-wait': carry => this.carryOutCompletionWait(carry),
    'human-wait': (carry, { via }) => via === 'completion' ? this.carryOutCompletionHumanWait(carry) : this.carryOutHumanWait(carry, via),
    nudge: (carry, decision) => decision.cause === 'completion' ? this.carryOutCompletionNudge(carry) : this.carryOutNoWaitNudge(carry, decision.text!),
  };

  /** Every park returns this once it is carried out, so a worker's park notice goes here whichever
   *  decision parked it (hearsay-tools/cezarion#1327). */
  private parkedOutcome(runId: string): TurnEndOutcome {
    this.host.noticeParkedWorker(runId);
    return { kind: 'park', keepsSlot: this.host.line.inPool(runId) };
  }

  /** A refused autonomous nudge waits for readiness at this boundary, bounded by the idle timer. */
  private carryOutDefer({ state, session }: TurnEndCarry, decision: Extract<TurnEndDecision, { kind: 'defer' }>): TurnEndOutcome {
    return !decision.keepDone && session && state.autonomousNudgePending === session ? { kind: 'readiness' } : { kind: 'running' };
  }

  private carryOutDone({ runId, state, session }: TurnEndCarry): TurnEndOutcome {
    this.closeAsDone(runId, state, session);
    return { kind: 'done' };
  }

  /** A human wait is shown and parks for the user; CI and timer waits keep their slot. A question
   *  with no wait parks for the user, and the freed slot can start a queued run. */
  private carryOutPark({ runId, state, stepId }: TurnEndCarry): TurnEndOutcome {
    if (!this.host.parkOnWaits(runId, state)) this.parkForUser(runId, state, stepId);
    return this.parkedOutcome(runId);
  }

  /** One nudge per cycle: Cezar waits on the live workers for the agent, then parks as `park` does. */
  private carryOutCompletionWait(carry: TurnEndCarry): TurnEndOutcome {
    carry.noteRefusal();
    this.host.waitRegistry.registerCompletionWait(carry.runId, carry.refused!.liveWorkerIds, carry.refused!.requestIds);
    return this.carryOutPark(carry);
  }

  /** The completion cause's human wait: the refusal is its note, and Cezar's own wait shows it. */
  private carryOutCompletionHumanWait({ runId, state, stepId, refused, noteRefusal }: TurnEndCarry): TurnEndOutcome {
    noteRefusal();
    const wait = this.host.humanWaits.openHumanAlias(runId, state, 'completion');
    if (wait?.source === 'cezar' && wait.askSeq === undefined) this.host.humanWaits.showCezarHumanWait(runId, state, wait, refused!.message);
    this.parkForUser(runId, state, stepId);
    return this.parkedOutcome(runId);
  }

  /** The no-wait and budget human waits. A refusal that settles the turn end opens the budget wait. */
  private carryOutHumanWait({ runId, state, stepId, noteRefusal, settlesRefusal }: TurnEndCarry, via: 'no-wait' | 'budget'): TurnEndOutcome {
    const capNote = state.autonomous ? `autonomous — safety cap reached (${this.maxAutoContinues}); automatic continuation paused`
      : `automatic-wake budget spent (${this.maxAutoContinues}); waiting for you`;
    if (settlesRefusal) {
      noteRefusal();
      this.openTurnEndHumanWait(runId, state, stepId, 'budget', capNote);
      return this.parkedOutcome(runId);
    }
    // Stopping, finishing, parent completion and owed input keep today's plain park.
    if (!this.host.canAutoContinue(runId, state)) this.parkForUser(runId, state, stepId);
    else this.openTurnEndHumanWait(runId, state, stepId, via, via === 'no-wait' ? NO_WAIT_NOTE : capNote, true);
    return this.parkedOutcome(runId);
  }

  /** Send the refusal nudge, or park retaining DONE for transport readiness when permitted. */
  private carryOutCompletionNudge({ runId, state, session, stepId, refused, noteRefusal }: TurnEndCarry): TurnEndOutcome {
    const text = refused!.liveWorkerIds.length ? `${refused!.message} ${this.completionWillWait}` : refused!.message;
    state.noWaitNudgeSawContent = false;
    if (!session || !this.host.canAutoContinue(runId, state) || !this.host.submitAgentInput(runId, state, [{ type: 'text', text }])) {
      if (session && this.host.canAutoContinue(runId, state)) state.doneAtBoundary = session;
      noteRefusal();
      this.parkForUser(runId, state, stepId);
      return this.parkedOutcome(runId);
    }
    this.host.awaitCompletionNudgeReply(runId, state, session);
    const spent = this.host.chargeAutomaticWake(runId);
    this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: `${COMPLETION_NUDGE_NOTE} (${spent}/${this.maxAutoContinues}): ${refused!.code}` });
    return { kind: 'nudge', cause: 'completion', autonomous: !!state.autonomous };
  }

  /** The no-wait cause's nudge. One the wire refuses waits for input readiness when it is
   *  autonomous, else opens Cezar's no-wait human wait. */
  private carryOutNoWaitNudge({ runId, state, session, stepId }: TurnEndCarry, text: string): TurnEndOutcome {
    const sent = openCompletionRequests(this.context.store, runId).sent;
    if (sent.length) text += ` ${sentRequestInstructions(sent)}`;
    if (this.host.sendTurnEndNudge(runId, state, stepId, text)) return { kind: 'nudge', cause: 'no-wait', autonomous: !!state.autonomous };
    if (session && state.autonomousNudgePending === session) return { kind: 'readiness' };
    if (!this.host.canAutoContinue(runId, state)) this.parkForUser(runId, state, stepId);
    else this.openTurnEndHumanWait(runId, state, stepId, 'no-wait', NO_WAIT_NOTE, true);
    return this.parkedOutcome(runId);
  }

  /** Cezar's own human wait at a turn end (hearsay-tools/cezarion#1234): the cause as a note, the
   *  wait shown as Needs you, and the run parked for the user. A worker's `no-wait` fallback at its
   *  turn end (`turnEnd`) asks its parent instead (`askParentForWorker`, hearsay-tools/cezarion#1301);
   *  any other worker fallback stays a plain park. */
  openTurnEndHumanWait(runId: string, state: ActiveRun, stepId: string | undefined, via: 'no-wait' | 'budget', note: string, turnEnd = false): void {
    const worker = this.context.store.getRun(runId)?.delegation?.role === 'worker';
    if (worker && via === 'no-wait' && turnEnd) { this.host.workerQuestions.askParentForWorker(runId, state, stepId); this.parkForUser(runId, state, stepId); return; }
    const wait = worker ? undefined : this.host.humanWaits.openHumanAlias(runId, state, via);
    if (wait?.source === 'cezar' && wait.askSeq === undefined) this.host.humanWaits.showCezarHumanWait(runId, state, wait, note);
    else {
      this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: note });
      if (wait) this.host.humanWaits.surfaceHumanWait(runId, state, wait);
    }
    this.parkForUser(runId, state, stepId);
  }

  armIdleTimer(runId: string, state: ActiveRun): void {
    clearIdleTimer(state);
    state.idleClosed = false;
    state.idleTimer = setTimeout(() => {
      if (state.session?.open && !state.cancelled) {
        state.idleClosed = true;
        this.context.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `session closed after ${Math.round(this.idleTimeoutMs / 60_000)}m of inactivity`,
        });
        state.session.end();
      }
    }, this.idleTimeoutMs);
    state.idleTimer.unref?.();
  }

  /** The turn-end tail's park for the user: `waiting` with the idle timer, no slot. A result
   *  already in (a pending question beside a resolved wait) still queues its wake. */
  parkForUser(runId: string, state: ActiveRun, stepId: string | undefined): void {
    this.host.move(runId, 'park');
    if (stepId) this.context.store.updateStep(runId, stepId, { status: 'waiting' });
    this.context.store.flush();
    this.host.line.park(runId);
    this.host.leaveMonitoringPool(runId);
    this.armIdleTimer(runId, state);
    this.host.releaseSlot();
    this.host.queueWaitWake(runId);
  }

  /**
   * The monitoring line and Claude's `ScheduleWakeup` open a timer in the wait list
   * (hearsay-tools/cezarion#1233): the line for the configured interval, `ScheduleWakeup` for its
   * `delaySeconds` clamped to 60–3,600 (the interval without one). Idempotent per `via`: while one
   * is open the alias registers nothing and the timer keeps its deadline. The line is only a
   * fallback: any open non-human wait suppresses its registration (hearsay-tools/cezarion#1268),
   * including the off/budget human fallback. With timers off and no such wait it opens
   * a `monitoring-line` human wait instead, and with the automatic-wake budget spent a `budget` one
   * (hearsay-tools/cezarion#1234); the park shows it. An autonomous run's nudge keeps precedence
   * over the line.
   */
  private openTimerAlias(runId: string, state: ActiveRun, scheduleWakeup: number | null | undefined): void {
    const run = this.context.store.getRun(runId);
    if (!canProceedWithRun(run, () => this.host.workerExecutionStopped(runId), value => this.host.executionBlockedByRootFinish(value))) return;
    if (state.autonomous && this.host.countAutomaticWakes(runId) < this.maxAutoContinues && this.host.canAutoContinue(runId, state)) return;
    const via: WaitVia = scheduleWakeup === undefined ? 'monitoring-line' : 'schedule-wakeup';
    const open = openWaits(run);
    // The line is a fallback, not another poll beside a wait that already supplies its wake
    // (hearsay-tools/cezarion#1268). Keep explicit ScheduleWakeup requests and existing timers.
    if (via === 'monitoring-line' && open.some(wait => wait.kind !== 'human')) return;
    if (open.some(wait => wait.kind === 'timer' && wait.via === via)) return;
    const minutes = this.context.semaphore.monitoringWakeIntervalMinutes();
    if (minutes === null) {
      this.context.store.appendEvent(runId, { type: 'note', message: 'automatic re-checks are off; waiting for you' });
      this.host.humanWaits.openHumanAlias(runId, state, 'monitoring-line');
      return;
    }
    if (this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      if (!state.monitoringCapNoted) {
        state.monitoringCapNoted = true;
        this.context.store.appendEvent(runId, {
          type: 'note',
          message: `automatic monitoring wake-up cap reached (${this.maxAutoContinues}); session remains parked`,
        });
      }
      this.host.humanWaits.openHumanAlias(runId, state, 'budget');
      return;
    }
    if (openWaits(run).length >= WAIT_LIMIT) return;
    const delay = typeof scheduleWakeup === 'number' ? Math.min(this.scheduleWakeupMaxSeconds, Math.max(TIMER_MIN_SECONDS, Math.round(scheduleWakeup))) : undefined;
    const now = Date.now();
    // `seconds` is the record's bound; the line's deadline is the interval itself (tests run it sub-minute).
    const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + (delay === undefined ? minutes * 60_000 : delay * 1000)).toISOString(), phase: 'open', turnId: state.ciTurnId ?? 'monitoring',
      seconds: delay ?? Math.min(TIMER_MAX_SECONDS, Math.max(TIMER_MIN_SECONDS, Math.round(minutes * 60))),
      ...(via === 'monitoring-line' ? { note: 'Opened by CEZ:MONITORING.' } : {}) };
    this.host.humanWaits.withdrawCezarHumanWaits(runId);
    try { this.context.store.commitWait(runId, wait); }
    catch (error) { console.warn(`[cez] monitoring timer checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    this.host.waitWatches.armWait(runId, wait);
  }
}
