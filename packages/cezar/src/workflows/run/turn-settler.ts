import { logPrefix } from '../../home/display.ts';
import type { WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { transitionTurnBoundary, type BoundaryCarry, type BoundaryCarrierEffects } from './turn-boundary.ts';
import { TIMER_MIN_SECONDS, type HumanWaitEntry, type WaitVia } from '@open-mercato/cezar-contract/waits';
import type { AgentSession } from '../../core/claude-cli-runner.ts';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { AskRequest } from '../../core/ask.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { RunExitId, ExitCall, RunPatch } from '../../runs/run-exits.ts';
import type { ActiveRun } from '../active-run.ts';
import { openCompletionRequests, sentRequestInstructions, type CompletionRefusal } from '../completion-policy.ts';
import { NO_WAIT_NOTE, COMPLETION_NUDGE_NOTE, decideTurnEnd, type TurnEndDecision, type TurnEndFacts, type TurnEndOutcome } from '../turn-end.ts';
import { isSquawkHumanWait, openWaits } from '../waits.ts';
import { classifyTurnEnd, discardQueuedMessagesOnAsk, emitAskRequested } from './turn-markers.ts';
import { clearHeldHumanInputTimer, clearIdleTimer, harnessOwesInput, harnessHoldsHumanInput } from './input-timers.ts';
import { canProceedWithRun } from './run-guards.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { monitorsLiveWorkers, type CompletionGateHost } from './completion-gate.ts';
import type { RunModuleContext, SettledTurn } from './types.ts';
import type { HumanWaits } from './human-waits.ts';
import type { RunLine } from './run-line.ts';
import type { WaitRegistry } from './wait-registry.ts';
import { openSubagentWaitOf, type SubagentWaits } from './subagent-waits.ts';
import type { WorkerQuestions } from './worker-questions.ts';



interface TurnSettlerHost {
  waitEngine: WaitEngine;
  humanWaits: HumanWaits; line: RunLine; waitRegistry: WaitRegistry; workerQuestions: WorkerQuestions; completionGateHost: CompletionGateHost;
  subagentWaits: SubagentWaits;
  move(id: string, exit: RunExitId, patch?: RunPatch, call?: ExitCall): unknown; releaseSlot(): void; completionGate(id: string): 'accept' | 'held' | CompletionRefusal;
  countAutomaticWakes(id: string): number; workerExecutionStopped(id: string): boolean; executionBlockedByRootFinish(run: RunRecord): boolean;
  submitAgentInput(id: string, state: ActiveRun, content: ContentBlock[]): boolean; flushAgentInputs(id: string): boolean; hasQueuedAgentInputs(id: string, except?: readonly string[]): boolean;
  armUnreadInputTimer(id: string, state: ActiveRun): void; armHeldHumanInputTimer(id: string, state: ActiveRun): void;
  parkOnWaits(id: string, state: ActiveRun): boolean; queueWaitWake(id: string): void; leaveMonitoringPool(id: string): void; chargeAutomaticWake(id: string): number;
  canAutoContinue(id: string, state: ActiveRun): boolean;
  sendTurnEndNudge(id: string, state: ActiveRun, step: string | undefined, text: string): boolean; awaitCompletionNudgeReply(id: string, state: ActiveRun, session: AgentSession): void;
  noticeParkedWorker(id: string): void; routeWorkerQuestion(id: string): void; settledTurnOutcome(id: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer', outcome: TurnEndOutcome): TurnEndOutcome | undefined;
}

export class TurnSettler {
  constructor(private readonly context: RunModuleContext, private readonly host: TurnSettlerHost,
    private readonly idleTimeoutMs: number, private readonly maxAutoContinues: number,
    private readonly completionWillWait: string, private readonly scheduleWakeupMaxSeconds: number) {}

  /** The `cezar_done` this session accepted since its last turn end, taken by this turn end: a
   *  later turn must call it again. */
  private takeDoneRequest(state: ActiveRun) {
    const request = state.boundary.doneRequested?.session === state.liveSession.session ? state.boundary.doneRequested : undefined;
    transitionTurnBoundary(state, { kind: 'turn-end', phase: 'consume-done', session: state.liveSession.session });
    return request;
  }

  /** The DONE boundary and close metadata; a refused DONE may retain metadata for readiness. */
  private recordDoneAtBoundary(state: ActiveRun, done: boolean, request: ActiveRun['boundary']['doneRequested'], keepClose = done): void {
    transitionTurnBoundary(state, { kind: 'turn-end', phase: 'record-done', session: state.liveSession.session, done, request, keepClose });
  }

  /** Goal achieved (agent contract, #347): the summary `cezar_done` gave as a note, the closing
   *  event naming what declared it, every open wait cancelled (DONE ranks above every wait), and
   *  the session closes instead of parking, so the run completes and frees its slot. */
  private closeAsDone(runId: string, state: ActiveRun, session: AgentSession | undefined): void {
    const close = state.boundary.doneClose;
    // A workflow step that is not the last completes, and the next step starts (hearsay-tools/cezarion#1620).
    const step = !!session && state.boundary.nextStep?.session === session;
    transitionTurnBoundary(state, { kind: 'done-step-consumed', phase: 'completed', session: state.liveSession.session, stepId: state.liveSession.currentStepId });
    if (close?.summary) this.context.store.appendEvent(runId, { type: 'note', message: close.summary });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message: step ? 'step complete — session closed' : 'goal achieved — session closed', via: close?.via ?? 'cezar_done' });
    this.host.waitEngine.cancelAll(runId);
    session?.end();
  }

  /**
   * A turn end on the runner's own signal, shared by the fresh step's and the Continue's turn-end
   * handlers (hearsay-tools/cezarion#1525): read what the turn said, keep it for an acknowledgement
   * that lands after the turn end (`parkAfterAck`), then settle it (`settleTurn`). Nothing reads the
   * turn's text: only the lifecycle tools and native runner signals decide (hearsay-tools/cezarion#2397).
   */
  endTurn(runId: string, state: ActiveRun, sink: UiEventSink, turn: {
    stepId: string; scheduleWakeup: number | null | undefined;
  }): void {
    const sessionOpen = !state.liveSession.cancelled && !!state.liveSession.session?.open;
    const humanWait = this.host.humanWaits.turnEndHumanWait(runId);
    const doneRequest = this.takeDoneRequest(state);
    const read = classifyTurnEnd({
      sessionOpen, pendingHumanAsk: !!state.boundary.pendingHumanAsk,
      scheduledWake: turn.scheduleWakeup !== undefined,
      liveWorkers: monitorsLiveWorkers(this.context, this.host.completionGateHost, runId),
      humanWait, doneRequested: !!doneRequest,
    });
    const { monitoring, humanGate, ask } = read;
    discardQueuedMessagesOnAsk(state.liveSession.session, read);
    // The turn that just ended answered a nudge: one flag per cause (hearsay-tools/cezarion#1234,
    // hearsay-tools/cezarion#1301).
    const nudgedLastTurn = state.boundary.noWaitNudged === state.liveSession.session;
    transitionTurnBoundary(state, { kind: 'turn-end', phase: 'reset-nudges', session: state.liveSession.session });
    this.prepareTurnAsk(runId, state, humanWait, read);
    // Native subagents still running: Squawk waits on them, instead of a timer (hearsay-tools/cezarion#2431).
    this.host.subagentWaits.atTurnEnd(runId, state, { sessionOpen, done: read.done, asks: !!ask || humanGate });
    transitionTurnBoundary(state, { kind: 'turn-end', phase: 'save-ack', session: state.liveSession.session, boundary: sessionOpen && state.liveSession.session
      ? { session: state.liveSession.session, monitoring, humanGate, nudgedLastTurn, scheduleWakeup: turn.scheduleWakeup } : undefined });
    const settled = this.settleTurn(runId, state, 'turn-end', {
      stepId: turn.stepId, monitoring, humanGate, ask, humanWait, sink,
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

  /** Prepare the turn's question before the turn end settles (`endTurn`): the card or human gate
   *  the run parks on. */
  private prepareTurnAsk(runId: string, state: ActiveRun, humanWait: HumanWaitEntry | undefined, read: { ask: AskRequest | null; humanGate: boolean }): void {
    const { humanGate, ask } = read;
    if (ask) this.host.humanWaits.prepareHumanAsk(state);
    if (humanGate && !ask && !state.boundary.pendingHumanAsk) this.host.humanWaits.raiseHumanGate(runId, state);
    if (humanGate && !ask) this.host.humanWaits.recordTurnEndQuestion(runId, humanWait, null);
  }

  /** The turn end an entry settles after it (`settleIdleBoundary`, `handleAgentInputReady`), and
   *  the completion gate's live refusal: what `parkAfterAck` kept of it. */
  boundaryTurn(runId: string, state: ActiveRun, session: AgentSession, done: boolean): SettledTurn {
    const ack = state.boundary.parkAfterAck?.session === session ? state.boundary.parkAfterAck : undefined;
    return {
      stepId: state.liveSession.currentStepId, humanGate: !!ack?.humanGate, ask: null, done,
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
    const session = state.liveSession.session;
    const stepId = turn.stepId;
    // A done goes to the completion gate first (hearsay-tools/cezarion#1301). A refused done is not a done.
    const gate = refusal ?? (turn.done && session?.open ? this.host.completionGate(runId) : 'accept');
    if (gate === 'held') return this.settleHeldTurn(runId, state, entry, turn);
    const refused = typeof gate === 'object' ? gate : undefined;
    if (entry === 'ready') transitionTurnBoundary(state, { kind: 'input-ready', phase: 'clear-nudge', session });
    let noted = false;
    const noteRefusal = () => {
      if (!refused || noted) return;
      noted = true;
      this.context.store.appendEvent(runId, { type: 'note', tone: 'warning', ...(stepId ? { stepId } : {}), message: `Completion blocked: ${refused.message}` });
    };
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
      if (state.inputState.agentInputError) return false;
    }
    this.host.settledTurnOutcome(runId, entry, { kind: 'park', keepsSlot: this.host.line.inPool(runId) });
    return true;
  }

  /** What the turn-end rule decides for a settled turn (`settleTurn`): the timer alias the rule
   *  reads, the first decision and the done it keeps, then the owed input a `take-input` decision
   *  tries and the decision after it. `tried` is true when that input was tried. */
  private decideSettledTurn(runId: string, state: ActiveRun, session: AgentSession | undefined, entry: 'turn-end' | 'ack' | 'ready' | 'gate',
    turn: SettledTurn, refused: CompletionRefusal | undefined, noteRefusal: () => void): { decision: TurnEndDecision; tried: boolean } {
    // A turn end opens it once owed input was tried; this turn's ask keeps that input back, so its
    // timer alias opens now. A refused done decides before any alias, as before.
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
      sessionOpen: !state.liveSession.cancelled && !!session?.open,
      done: turn.done,
      ...(refused ? { doneRefused: { liveWorkers: refused.liveWorkerIds.length > 0 || !!refused.requestIds?.length } } : {}),
      inputInFlight: !!state.inputState.agentInputFlight,
      inputQueued: this.host.hasQueuedAgentInputs(runId, state.inputState.agentInputFlight?.inputIds),
      inputTaken,
      nudgePending: !!session && state.boundary.autonomousNudgePending === session,
      turnAsk: !!turn.ask,
      nativeAsk: !!state.boundary.pendingHumanAsk,
      question: !!turn.ask || turn.humanGate || !!state.boundary.pendingHumanAsk || hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id)),
      agentWaits: this.host.humanWaits.holdsAgentWaits(runId),
      squawkHumanWait: (run?.waits ?? []).some(isSquawkHumanWait),
      stepScope: !!session && state.boundary.nextStep?.session === session,
      noWaitNudgedLastTurn: turn.nudgedLastTurn,
      completionNudgedLastTurn: (!!session && state.boundary.completionNudgeAnswered === session) || (!!refused?.requestIds?.length && !!state.boundary.sentRequestRefused),
      autonomous: !!state.boundary.autonomous,
      budgetSpent: this.host.countAutomaticWakes(runId) >= this.maxAutoContinues,
    };
  }

  /** `ScheduleWakeup` and live workers open their timer before the rule reads the waits, as the
   *  `cezar_wait` timer they alias. An autonomous nudge waiting for readiness keeps precedence, and
   *  Squawk's subagent wait replaces the alias: its children wake the run (hearsay-tools/cezarion#2431). */
  private openTurnTimerAlias(runId: string, state: ActiveRun, session: AgentSession | undefined, turn: SettledTurn): void {
    if (openSubagentWaitOf(this.context.store.getRun(runId))) return;
    if (turn.monitoring && session?.open && state.boundary.autonomousNudgePending !== session) this.openTimerAlias(runId, state, turn.scheduleWakeup);
  }

  /** The done the first decision keeps at the boundary (`decideSettledTurn`): a turn end records
   *  it, and an acknowledgement drops a refused done the rule does not keep. */
  private keepSettledDone(state: ActiveRun, entry: 'turn-end' | 'ack' | 'ready' | 'gate', turn: SettledTurn,
    refused: CompletionRefusal | undefined, decision: TurnEndDecision): void {
    const keepDone = turn.done && (!refused || (decision.kind === 'defer' && !!decision.keepDone));
    if (entry === 'turn-end') this.recordDoneAtBoundary(state, keepDone, turn.doneRequest, turn.done);
    else if (entry === 'ack' && turn.done && !keepDone) transitionTurnBoundary(state, { kind: 'turn-end', phase: 'drop-done', session: state.liveSession.session });
  }

  /** The owed input a `take-input` decision tries (`decideSettledTurn`). True when input was taken.
   *  #505: input the harness accepted but has not read yet runs as its next turn. An in-flight
   *  submission is settled by its acknowledgement (parkAfterAck), not here. */
  private takeOwedInput(runId: string, state: ActiveRun, turn: SettledTurn): boolean {
    return this.host.flushAgentInputs(runId) || (!turn.humanGate && harnessOwesInput(state)) ||
      !!state.inputState.agentInputFlight || harnessHoldsHumanInput(state);
  }

  /** A turn end's own steps after the rule decided (`settleTurn`): the unread and held input timers,
   *  then the human wait's card. False when the input checkpoint failed. */
  private settleTurnEndInput(runId: string, state: ActiveRun, turn: SettledTurn, tried: boolean, decision: TurnEndDecision): boolean {
    if (tried) this.host.armUnreadInputTimer(runId, state);
    if (tried && harnessHoldsHumanInput(state)) this.host.armHeldHumanInputTimer(runId, state);
    else clearHeldHumanInputTimer(state);
    if (state.inputState.agentInputError) return false;
    // The human wait's card surfaces as an ask card (#473) before the rule parks on it.
    if (turn.ask && turn.sink && decision.kind !== 'closed' && decision.kind !== 'input' && !this.host.humanWaits.humanWaitShown(runId, turn.humanWait)) {
      emitAskRequested(turn.sink, turn.ask);
      this.host.humanWaits.recordTurnEndQuestion(runId, turn.humanWait, turn.ask);
      this.host.routeWorkerQuestion(runId);
    }
    return true;
  }

  /** Carry out what the turn-end rule decided, and report how it left the run. A refusal the
   *  decision follows is noted first; then the decision kind's own method runs (`boundaryEffects`). */
  private carryOutTurnEnd(runId: string, state: ActiveRun, stepId: string | undefined, decision: TurnEndDecision,
    refused: CompletionRefusal | undefined, noteRefusal: () => void): TurnEndOutcome {
    const session = state.liveSession.session;
    const decisionRefused = 'refused' in decision && !!decision.refused;
    if (decisionRefused) noteRefusal();
    // A refusal that settles the turn end replaces Squawk's own human wait, as the agent's own wait would.
    const settlesRefusal = !!refused && !decisionRefused && !(decision.kind === 'defer' && decision.keepDone);
    if (settlesRefusal) this.host.humanWaits.withdrawSquawkHumanWaits(runId);
    return transitionTurnBoundary(runId, state, { kind: 'turn-end', phase: 'carry', session,
      carry: { runId, state, session, stepId, refused, noteRefusal, settlesRefusal }, decision }, this.boundaryEffects);
  }

  private readonly boundaryEffects: BoundaryCarrierEffects = {
    defer: (carry, decision) => this.carryOutDefer(carry, decision),
    done: carry => this.carryOutDone(carry),
    park: carry => this.carryOutPark(carry),
    parkForCompletionWait: carry => this.carryOutCompletionWait(carry),
    completionHumanWait: carry => this.carryOutCompletionHumanWait(carry),
    humanWait: (carry, via) => this.carryOutHumanWait(carry, via),
    completionNudge: carry => this.carryOutCompletionNudge(carry),
    noWaitNudge: (carry, text) => this.carryOutNoWaitNudge(carry, text),
  };

  /** Every park returns this once it is carried out, so a worker's park notice goes here whichever
   *  decision parked it (hearsay-tools/cezarion#1327). */
  private parkedOutcome(runId: string): TurnEndOutcome {
    this.host.noticeParkedWorker(runId);
    return { kind: 'park', keepsSlot: this.host.line.inPool(runId) };
  }

  /** A refused autonomous nudge waits for readiness at this boundary, bounded by the idle timer. */
  private carryOutDefer({ state, session }: BoundaryCarry, decision: Extract<TurnEndDecision, { kind: 'defer' }>): TurnEndOutcome {
    return !decision.keepDone && session && state.boundary.autonomousNudgePending === session ? { kind: 'readiness' } : { kind: 'running' };
  }

  private carryOutDone({ runId, state, session }: BoundaryCarry): TurnEndOutcome {
    this.closeAsDone(runId, state, session);
    return { kind: 'done' };
  }

  /** A human wait is shown and parks for the user; CI and timer waits keep their slot. A question
   *  with no wait parks for the user, and the freed slot can start a queued run. */
  private carryOutPark({ runId, state, stepId }: BoundaryCarry): TurnEndOutcome {
    if (!this.host.parkOnWaits(runId, state)) this.parkForUser(runId, state, stepId);
    return this.parkedOutcome(runId);
  }

  /** One nudge per cycle: Squawk waits on the live workers for the agent, then parks as `park` does. */
  private carryOutCompletionWait(carry: BoundaryCarry): TurnEndOutcome {
    carry.noteRefusal();
    this.host.waitRegistry.registerCompletionWait(carry.runId, carry.refused!.liveWorkerIds, carry.refused!.requestIds);
    return this.carryOutPark(carry);
  }

  /** The completion cause's human wait: the refusal is its note, and Squawk's own wait shows it. */
  private carryOutCompletionHumanWait({ runId, state, stepId, refused, noteRefusal }: BoundaryCarry): TurnEndOutcome {
    noteRefusal();
    const wait = this.host.humanWaits.openHumanAlias(runId, state, 'completion');
    if (wait?.source === 'cezar' && wait.askSeq === undefined) this.host.humanWaits.showSquawkHumanWait(runId, state, wait, refused!.message);
    this.parkForUser(runId, state, stepId);
    return this.parkedOutcome(runId);
  }

  /** The no-wait and budget human waits. A refusal that settles the turn end opens the budget wait. */
  private carryOutHumanWait({ runId, state, stepId, noteRefusal, settlesRefusal }: BoundaryCarry, via: 'no-wait' | 'budget'): TurnEndOutcome {
    const capNote = state.boundary.autonomous ? `autonomous — safety cap reached (${this.maxAutoContinues}); automatic continuation paused`
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
  private carryOutCompletionNudge({ runId, state, session, stepId, refused, noteRefusal }: BoundaryCarry): TurnEndOutcome {
    const text = refused!.liveWorkerIds.length ? `${refused!.message} ${this.completionWillWait}` : refused!.message;
    transitionTurnBoundary(state, { kind: 'turn-end', phase: 'reset-content', session });
    if (!session || !this.host.canAutoContinue(runId, state) || !this.host.submitAgentInput(runId, state, [{ type: 'text', text }])) {
      if (session && this.host.canAutoContinue(runId, state)) transitionTurnBoundary(state, { kind: 'turn-end', phase: 'retain-done', session });
      noteRefusal();
      this.parkForUser(runId, state, stepId);
      return this.parkedOutcome(runId);
    }
    this.host.awaitCompletionNudgeReply(runId, state, session);
    const spent = this.host.chargeAutomaticWake(runId);
    this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: `${COMPLETION_NUDGE_NOTE} (${spent}/${this.maxAutoContinues}): ${refused!.code}` });
    return { kind: 'nudge', cause: 'completion', autonomous: !!state.boundary.autonomous };
  }

  /** The no-wait cause's nudge. One the wire refuses waits for input readiness when it is
   *  autonomous, else opens Squawk's no-wait human wait. */
  private carryOutNoWaitNudge({ runId, state, session, stepId }: BoundaryCarry, text: string): TurnEndOutcome {
    const sent = openCompletionRequests(this.context.store, runId).sent;
    if (sent.length) text += ` ${sentRequestInstructions(sent)}`;
    if (this.host.sendTurnEndNudge(runId, state, stepId, text)) return { kind: 'nudge', cause: 'no-wait', autonomous: !!state.boundary.autonomous };
    if (session && state.boundary.autonomousNudgePending === session) return { kind: 'readiness' };
    if (!this.host.canAutoContinue(runId, state)) this.parkForUser(runId, state, stepId);
    else this.openTurnEndHumanWait(runId, state, stepId, 'no-wait', NO_WAIT_NOTE, true);
    return this.parkedOutcome(runId);
  }

  /** Squawk's own human wait at a turn end (hearsay-tools/cezarion#1234): the cause as a note, the
   *  wait shown as Needs you, and the run parked for the user. A worker's `no-wait` fallback at its
   *  turn end (`turnEnd`) asks its parent instead (`askParentForWorker`, hearsay-tools/cezarion#1301);
   *  any other worker fallback stays a plain park. */
  openTurnEndHumanWait(runId: string, state: ActiveRun, stepId: string | undefined, via: 'no-wait' | 'budget', note: string, turnEnd = false): void {
    const worker = this.context.store.getRun(runId)?.delegation?.role === 'worker';
    if (worker && via === 'no-wait' && turnEnd) { this.host.workerQuestions.askParentForWorker(runId, state, stepId); this.parkForUser(runId, state, stepId); return; }
    const wait = worker ? undefined : this.host.humanWaits.openHumanAlias(runId, state, via);
    if (wait?.source === 'cezar' && wait.askSeq === undefined) this.host.humanWaits.showSquawkHumanWait(runId, state, wait, note);
    else {
      this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: note });
      if (wait) this.host.humanWaits.surfaceHumanWait(runId, state, wait);
    }
    this.parkForUser(runId, state, stepId);
  }

  armIdleTimer(runId: string, state: ActiveRun): void {
    clearIdleTimer(state);
    transitionTurnBoundary(state, { kind: 'idle-expired', phase: 'reset', session: state.liveSession.session });
    const timer = setTimeout(() => {
      if (state.liveSession.session?.open && !state.liveSession.cancelled) {
        transitionTurnBoundary(state, { kind: 'idle-expired', phase: 'close', session: state.liveSession.session });
        this.context.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `session closed after ${Math.round(this.idleTimeoutMs / 60_000)}m of inactivity`,
        });
        state.liveSession.session.end();
      }
    }, this.idleTimeoutMs);
    transitionTurnBoundary(state, { kind: 'idle-expired', phase: 'armed', session: state.liveSession.session, timer });
    state.boundary.idleTimer!.unref?.();
  }

  /** The turn-end tail's park for the user: `waiting` with the idle timer, no slot. A result
   *  already in (a pending question beside a resolved wait) still queues its wake. */
  parkForUser(runId: string, state: ActiveRun, stepId: string | undefined): void {
    this.host.move(runId, 'park', {}, { stepId });
    this.context.store.flush();
    this.host.line.park(runId);
    // Native subagents still running in this session keep it and its slot beside the question.
    transitionTurnBoundary(state, { kind: 'wait-wake-admitted', phase: 'hold-children', session: state.liveSession.session, held: this.host.subagentWaits.holdsLiveSubagents(runId) || undefined });
    if (state.boundary.heldForSubagents) this.host.line.joinPool(runId);
    else { this.host.leaveMonitoringPool(runId); this.armIdleTimer(runId, state); }
    this.host.releaseSlot();
    this.host.queueWaitWake(runId);
  }

  /**
   * Claude's `ScheduleWakeup` and a turn that ends with live workers and no worker wait open a timer
   * in the wait list (hearsay-tools/cezarion#1233): `ScheduleWakeup` for its `delaySeconds` clamped
   * to 60–3,600 (the interval without one), live workers for the configured interval. The
   * live-workers timer keeps the stored `monitoring-line` via, which saved runs carry. Idempotent per
   * `via`: while one is open the alias registers nothing and the timer keeps its deadline. The
   * live-workers timer is only a fallback: any open non-human wait suppresses its registration
   * (hearsay-tools/cezarion#1268), including the off/budget human fallback. With timers off and no
   * such wait it opens a `monitoring-line` human wait instead, and with the automatic-wake budget
   * spent a `budget` one (hearsay-tools/cezarion#1234); the park shows it. An autonomous run's nudge
   * keeps precedence over the timer.
   */
  private openTimerAlias(runId: string, state: ActiveRun, scheduleWakeup: number | null | undefined): void {
    const run = this.context.store.getRun(runId);
    if (!canProceedWithRun(run, () => this.host.workerExecutionStopped(runId), value => this.host.executionBlockedByRootFinish(value))) return;
    if (state.boundary.autonomous && this.host.countAutomaticWakes(runId) < this.maxAutoContinues && this.host.canAutoContinue(runId, state)) return;
    const via: WaitVia = scheduleWakeup === undefined ? 'monitoring-line' : 'schedule-wakeup';
    const open = openWaits(run);
    // The live-workers timer is a fallback, not another poll beside a wait that already supplies
    // its wake (hearsay-tools/cezarion#1268). Keep explicit ScheduleWakeup requests and existing timers.
    if (open.some(wait => via === 'monitoring-line' && !WAIT_KINDS[wait.kind].userAnswers)) return;
    if (WAIT_KINDS.timer.duplicateMonitoring(open, via)) return;
    const minutes = this.context.semaphore.monitoringWakeIntervalMinutes();
    if (minutes === null) {
      if (WAIT_KINDS.timer.timersDisabled) {
        this.context.store.appendEvent(runId, { type: 'note', message: 'automatic re-checks are off; waiting for you' });
        this.host.humanWaits.openHumanAlias(runId, state, 'monitoring-line');
      }
      return;
    }
    if (this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      if (!state.boundary.monitoringCapNoted) {
        transitionTurnBoundary(state, { kind: 'turn-end', phase: 'monitoring-cap', session: state.liveSession.session });
        this.context.store.appendEvent(runId, {
          type: 'note',
          message: `automatic monitoring wake-up cap reached (${this.maxAutoContinues}); session remains parked`,
        });
      }
      this.host.humanWaits.openHumanAlias(runId, state, 'budget');
      return;
    }
    if (!this.host.waitEngine.hasRoom(run)) return;
    const delay = typeof scheduleWakeup === 'number' ? Math.min(this.scheduleWakeupMaxSeconds, Math.max(TIMER_MIN_SECONDS, Math.round(scheduleWakeup))) : undefined;
    const now = Date.now();
    const wait = WAIT_KINDS.timer.monitoringEntry(via, now, delay, minutes, state.waitIdentity.ciTurnId ?? 'monitoring');
    this.host.waitEngine.open(runId, state, wait, { withdraw: true, onCommitFailure: { log: `${logPrefix()} monitoring timer checkpoint failed` }, park: false });
  }
}
