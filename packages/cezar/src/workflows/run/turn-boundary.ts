import type { AgentSession } from '../../core/agent-runner.ts';
import type { ActiveRun } from '../active-run.ts';
import type { CompletionRefusal } from '../completion-policy.ts';
import type { TurnEndDecision, TurnEndOutcome } from '../turn-end.ts';

export type DoneRequest = Readonly<{ session: AgentSession; summary?: string }>;
export type NextStep = Readonly<{ session: AgentSession; label: string }>;
export type DoneClose = Readonly<{ via: 'cezar_done'; summary?: string }>;
export type AckBoundary = Readonly<{ session: AgentSession; monitoring: boolean; humanGate?: boolean; nudgedLastTurn?: boolean; scheduleWakeup?: number | null | undefined }>;

type Generation = { session: AgentSession | undefined };
type TurnEndEvent =
  | { kind: 'turn-end'; phase: 'consume-done' | 'reset-nudges' | 'drop-done' | 'reset-content' | 'ui-completed' }
  | { kind: 'turn-end'; phase: 'record-done'; done: boolean; request: DoneRequest | undefined; keepClose: boolean }
  | { kind: 'turn-end'; phase: 'save-ack'; boundary: AckBoundary | undefined }
  | { kind: 'turn-end'; phase: 'retain-done' }
  | { kind: 'turn-end'; phase: 'monitoring-cap' };
type SessionOpenEvent =
  | { kind: 'session-open'; phase: 'reset-step' }
  | { kind: 'session-open'; phase: 'scope-step'; next: NextStep | undefined }
  | { kind: 'session-open'; phase: 'restore-question'; pending: boolean };
type InputSubmittedEvent =
  | { kind: 'input-submitted'; phase: 'resume' | 'human-delivered' | 'completion-cycle' | 'monitoring-reset' | 'nudge-delivered' }
  | { kind: 'input-submitted'; phase: 'refresh-question'; pending: boolean };
type ReplyExpiredEvent =
  | { kind: 'reply-expired'; phase: 'fired' | 'park' | 'cancel' }
  | { kind: 'reply-expired'; phase: 'armed'; timer: NodeJS.Timeout };
type IdleExpiredEvent =
  | { kind: 'idle-expired'; phase: 'reset' | 'close' | 'cancel' }
  | { kind: 'idle-expired'; phase: 'armed'; timer: NodeJS.Timeout };

/** Each phase stays at the write's old position. The captured generation is data, not a new gate. */
type BoundaryMutationEvent = Generation & (
  | SessionOpenEvent | TurnEndEvent | InputSubmittedEvent | ReplyExpiredEvent | IdleExpiredEvent
  | { kind: 'turn-started'; phase: 'clear-nudge' | 'clear-boundary' }
  | { kind: 'done-request'; summary?: string }
  | { kind: 'done-step-consumed'; phase: 'completed' | 'consumed'; stepId?: string | undefined }
  | { kind: 'input-ack'; phase: 'wake-turn' }
  | { kind: 'input-ready'; phase: 'clear-nudge' | 'retain-nudge' }
  | { kind: 'input-error'; phase: 'interrupt' }
  | { kind: 'held-input-expired'; phase: 'expire' }
  | { kind: 'unread-expired'; phase: 'restore-boundary' | 'restore-ack' }
  | { kind: 'reply-content'; phase: 'received' | 'resumed' }
  | { kind: 'completion-refusal'; phase: 'nudge-delivered' | 'reset-content' }
  | { kind: 'completion-refusal'; phase: 'record'; code: CompletionRefusal['code']; tool: boolean }
  | { kind: 'human-wait-opened'; phase: 'prepare' }
  | { kind: 'human-wait-opened'; phase: 'refresh-question'; pending: boolean }
  | { kind: 'wait-wake-admitted'; phase: 'hold-children'; held: boolean | undefined }
  | { kind: 'subagents-changed'; phase: 'release' }
  | { kind: 'mode-disabled'; phase: 'disable' }
  | { kind: 'session-retired'; phase: 'reset' }
);

export type BoundaryCarry = {
  runId: string; state: ActiveRun; session: AgentSession | undefined; stepId: string | undefined;
  refused: CompletionRefusal | undefined; noteRefusal: () => void; settlesRefusal: boolean;
};
type CarryEvent = Generation & { kind: 'turn-end'; phase: 'carry'; carry: BoundaryCarry; decision: TurnEndDecision };
export type FactOnlyBoundaryEvent = Exclude<BoundaryMutationEvent, { kind: 'input-error' | 'held-input-expired' }>;
export type EffectBoundaryEvent = Exclude<BoundaryMutationEvent, FactOnlyBoundaryEvent> | CarryEvent;
export type TurnBoundaryEvent = BoundaryMutationEvent | CarryEvent;
export interface BoundaryCarrierEffects {
  defer(carry: BoundaryCarry, decision: Extract<TurnEndDecision, { kind: 'defer' }>): TurnEndOutcome;
  done(carry: BoundaryCarry): TurnEndOutcome;
  park(carry: BoundaryCarry): TurnEndOutcome;
  parkForCompletionWait(carry: BoundaryCarry): TurnEndOutcome;
  completionHumanWait(carry: BoundaryCarry): TurnEndOutcome;
  humanWait(carry: BoundaryCarry, via: 'no-wait' | 'budget'): TurnEndOutcome;
  completionNudge(carry: BoundaryCarry): TurnEndOutcome;
  noWaitNudge(carry: BoundaryCarry, text: string): TurnEndOutcome;
}
export type TurnBoundaryEffects = Partial<BoundaryCarrierEffects> & {
  interruptSession?(session: AgentSession): void;
  expireHeldInput?(): void;
};

type SetupEvent = Extract<BoundaryMutationEvent, { kind: 'session-open' | 'input-submitted' | 'reply-expired' | 'idle-expired' | 'completion-refusal' | 'session-retired' }>;

let applyBoundaryEvent: (group: BoundaryGroup, event: TurnBoundaryEvent, effects: TurnBoundaryEffects) => TurnEndOutcome | undefined;

/** Only this module can change boundary facts. Overlapping facts retain independent lifetimes. */
export class BoundaryGroup {
  #waitWakeTurn: AgentSession | undefined;
  #pendingHumanAsk: boolean;
  #noWaitNudgeReplyTimer: NodeJS.Timeout | undefined;
  #noWaitNudgeSawContent: boolean | undefined;
  #noWaitNudgeParked: AgentSession | undefined;
  #doneAtBoundary: AgentSession | undefined;
  #doneRequested: DoneRequest | undefined;
  #nextStep: NextStep | undefined;
  #completedStepId: string | undefined;
  #doneClose: DoneClose | undefined;
  #parkAfterAck: AckBoundary | undefined;
  #atTurnBoundary: AgentSession | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #idleClosed: boolean | undefined;
  #monitoringCapNoted: boolean | undefined;
  #autonomous: boolean | undefined;
  #autonomousNudgePending: AgentSession | undefined;
  #noWaitNudged: AgentSession | undefined;
  #incomingRequestRefused: boolean | undefined;
  #sentRequestRefused: boolean | undefined;
  #completionNudged: AgentSession | undefined;
  #completionNudgeAnswered: AgentSession | undefined;
  #heldForSubagents: boolean | undefined;
  constructor(pendingHumanAsk: boolean, autonomous: boolean) {
    this.#pendingHumanAsk = pendingHumanAsk;
    this.#autonomous = autonomous;
    Object.freeze(this);
  }
  get waitWakeTurn(): AgentSession | undefined { return this.#waitWakeTurn; }
  get pendingHumanAsk(): boolean { return this.#pendingHumanAsk; }
  get noWaitNudgeReplyTimer(): NodeJS.Timeout | undefined { return this.#noWaitNudgeReplyTimer; }
  get noWaitNudgeSawContent(): boolean | undefined { return this.#noWaitNudgeSawContent; }
  get noWaitNudgeParked(): AgentSession | undefined { return this.#noWaitNudgeParked; }
  get doneAtBoundary(): AgentSession | undefined { return this.#doneAtBoundary; }
  get doneRequested(): DoneRequest | undefined { return this.#doneRequested; }
  get nextStep(): NextStep | undefined { return this.#nextStep; }
  get completedStepId(): string | undefined { return this.#completedStepId; }
  get doneClose(): DoneClose | undefined { return this.#doneClose; }
  get parkAfterAck(): AckBoundary | undefined { return this.#parkAfterAck; }
  get atTurnBoundary(): AgentSession | undefined { return this.#atTurnBoundary; }
  get idleTimer(): NodeJS.Timeout | undefined { return this.#idleTimer; }
  get idleClosed(): boolean | undefined { return this.#idleClosed; }
  get monitoringCapNoted(): boolean | undefined { return this.#monitoringCapNoted; }
  get autonomous(): boolean | undefined { return this.#autonomous; }
  get autonomousNudgePending(): AgentSession | undefined { return this.#autonomousNudgePending; }
  get noWaitNudged(): AgentSession | undefined { return this.#noWaitNudged; }
  get incomingRequestRefused(): boolean | undefined { return this.#incomingRequestRefused; }
  get sentRequestRefused(): boolean | undefined { return this.#sentRequestRefused; }
  get completionNudged(): AgentSession | undefined { return this.#completionNudged; }
  get completionNudgeAnswered(): AgentSession | undefined { return this.#completionNudgeAnswered; }
  get heldForSubagents(): boolean | undefined { return this.#heldForSubagents; }

  #turnEnd(event: Generation & TurnEndEvent): void {
    switch (event.phase) {
      case 'ui-completed': this.#waitWakeTurn = undefined; this.#atTurnBoundary = event.session; return;
      case 'consume-done': this.#doneRequested = undefined; return;
      case 'reset-nudges':
        this.#noWaitNudged = undefined;
        this.#completionNudgeAnswered = this.#completionNudged === event.session ? event.session : undefined;
        this.#completionNudged = undefined;
        return;
      case 'record-done':
        this.#doneAtBoundary = event.done ? event.session : undefined;
        this.#doneClose = event.keepClose ? Object.freeze({ via: 'cezar_done', ...(event.request?.summary === undefined ? {} : { summary: event.request.summary }) }) : undefined;
        return;
      case 'save-ack': this.#parkAfterAck = event.boundary && Object.freeze({ ...event.boundary }); return;
      case 'drop-done': this.#doneAtBoundary = undefined; return;
      case 'retain-done': this.#doneAtBoundary = event.session; return;
      case 'reset-content': this.#noWaitNudgeSawContent = false; return;
      case 'monitoring-cap': this.#monitoringCapNoted = true; return;
    }
  }
  #sessionOpen(event: Generation & SessionOpenEvent): void {
    switch (event.phase) {
      case 'reset-step': this.#completedStepId = undefined; return;
      case 'scope-step': this.#nextStep = event.next && Object.freeze({ ...event.next }); return;
      case 'restore-question': this.#pendingHumanAsk = event.pending; return;
    }
  }
  #clearBoundary(): void {
    this.#atTurnBoundary = undefined;
    this.#doneAtBoundary = undefined;
    this.#parkAfterAck = undefined;
  }
  #completionCycle(): void {
    this.#incomingRequestRefused = undefined;
    this.#sentRequestRefused = undefined;
    this.#completionNudged = undefined;
    this.#completionNudgeAnswered = undefined;
  }
  #inputSubmitted(event: Generation & InputSubmittedEvent): void {
    switch (event.phase) {
      case 'nudge-delivered': this.#noWaitNudged = event.session; return;
      case 'resume': this.#autonomousNudgePending = undefined; this.#clearBoundary(); return;
      case 'human-delivered':
        this.#doneRequested = undefined;
        this.#noWaitNudged = undefined;
        this.#noWaitNudgeParked = undefined;
        this.#noWaitNudgeSawContent = undefined;
        return;
      case 'completion-cycle': this.#completionCycle(); return;
      case 'monitoring-reset': this.#monitoringCapNoted = undefined; return;
      case 'refresh-question': this.#pendingHumanAsk = event.pending; return;
    }
  }
  #replyExpired(event: Generation & ReplyExpiredEvent): void {
    switch (event.phase) {
      case 'fired': this.#noWaitNudgeReplyTimer = undefined; return;
      case 'park': this.#noWaitNudgeParked = event.session; return;
      case 'armed': this.#noWaitNudgeReplyTimer = event.timer; return;
      case 'cancel': this.#noWaitNudgeReplyTimer = undefined; return;
    }
  }
  #idleExpired(event: Generation & IdleExpiredEvent): void {
    switch (event.phase) {
      case 'reset': this.#idleClosed = false; return;
      case 'close': this.#idleClosed = true; return;
      case 'armed': this.#idleTimer = event.timer; return;
      case 'cancel': this.#idleTimer = undefined; return;
    }
  }
  #completionRefusal(event: Extract<BoundaryMutationEvent, { kind: 'completion-refusal' }>): void {
    switch (event.phase) {
      case 'nudge-delivered': this.#completionNudged = event.session; return;
      case 'reset-content': this.#noWaitNudgeSawContent = false; return;
      case 'record':
        if (event.code === 'requests_unanswered') this.#incomingRequestRefused = true;
        if (event.code !== 'requests_outstanding') return;
        if (event.tool && this.#sentRequestRefused && event.session) this.#doneRequested = Object.freeze({ session: event.session });
        this.#sentRequestRefused = true;
        return;
    }
  }
  #applySetup(event: SetupEvent): void {
    switch (event.kind) {
      case 'session-open': this.#sessionOpen(event); return;
      case 'input-submitted': this.#inputSubmitted(event); return;
      case 'reply-expired': this.#replyExpired(event); return;
      case 'idle-expired': this.#idleExpired(event); return;
      case 'completion-refusal': this.#completionRefusal(event); return;
      case 'session-retired': this.#nextStep = undefined; this.#waitWakeTurn = undefined; this.#clearBoundary(); return;
    }
  }
  #apply(event: BoundaryMutationEvent, effects: TurnBoundaryEffects): void {
    switch (event.kind) {
      case 'session-open': case 'input-submitted': case 'reply-expired':
      case 'idle-expired': case 'completion-refusal': case 'session-retired':
        this.#applySetup(event); return;
      default: this.#applyTurn(event, effects);
    }
  }
  #transition(event: TurnBoundaryEvent, effects: TurnBoundaryEffects): TurnEndOutcome | undefined {
    if (event.kind === 'turn-end' && event.phase === 'carry') return carryBoundary(event, effects);
    this.#apply(event, effects);
    return undefined;
  }
  #requestDone(event: Extract<BoundaryMutationEvent, { kind: 'done-request' }>): void {
    this.#doneRequested = Object.freeze({ session: event.session!, ...(event.summary === undefined ? {} : { summary: event.summary }) });
  }
  #humanWaitOpened(event: Extract<BoundaryMutationEvent, { kind: 'human-wait-opened' }>): void {
    if (event.phase === 'prepare') { this.#autonomousNudgePending = undefined; this.#pendingHumanAsk = true; }
    else this.#pendingHumanAsk = event.pending;
  }
  #applyTurn(event: Exclude<BoundaryMutationEvent, SetupEvent>, effects: TurnBoundaryEffects): void {
    switch (event.kind) {
      case 'turn-started':
        if (event.phase === 'clear-nudge') this.#autonomousNudgePending = undefined;
        else this.#clearBoundary();
        return;
      case 'turn-end': this.#turnEnd(event); return;
      case 'done-request': this.#requestDone(event); return;
      case 'done-step-consumed': this.#completedStepId = event.phase === 'completed' ? event.stepId : undefined; return;
      case 'input-ack': this.#waitWakeTurn = event.session; return;
      case 'input-ready': this.#autonomousNudgePending = event.phase === 'retain-nudge' ? event.session : undefined; return;
      case 'input-error': effects.interruptSession!(event.session!); return;
      case 'held-input-expired': effects.expireHeldInput!(); return;
      case 'unread-expired':
        if (event.phase === 'restore-boundary') this.#atTurnBoundary = event.session;
        else this.#parkAfterAck = Object.freeze({ session: event.session!, monitoring: false });
        return;
      case 'reply-content':
        if (event.phase === 'received') this.#noWaitNudgeSawContent = true;
        else this.#noWaitNudgeParked = undefined;
        return;
      case 'human-wait-opened': this.#humanWaitOpened(event); return;
      case 'wait-wake-admitted': this.#heldForSubagents = event.held; return;
      case 'subagents-changed': this.#heldForSubagents = undefined; return;
      case 'mode-disabled': this.#autonomous = false; return;
    }
  }
  static { applyBoundaryEvent = (group, event, effects) => group.#transition(event, effects); }
}

Object.freeze(BoundaryGroup.prototype);
Object.freeze(BoundaryGroup);
export function createBoundaryGroup(pendingHumanAsk: boolean, autonomous: boolean): BoundaryGroup {
  return new BoundaryGroup(pendingHumanAsk, autonomous);
}

function carryBoundary(event: CarryEvent, effects: TurnBoundaryEffects): TurnEndOutcome {
  const { decision, carry } = event;
  switch (decision.kind) {
    case 'closed': case 'input': case 'take-input': return { kind: 'running' };
    case 'defer': return effects.defer!(carry, decision);
    case 'done': return effects.done!(carry);
    case 'park': return effects.park!(carry);
    case 'completion-wait': return effects.parkForCompletionWait!(carry);
    case 'human-wait': return decision.via === 'completion' ? effects.completionHumanWait!(carry) : effects.humanWait!(carry, decision.via);
    case 'nudge': return decision.cause === 'completion' ? effects.completionNudge!(carry) : effects.noWaitNudge!(carry, decision.text!);
  }
}

/** Fact-only phases need no run identifier or effects. Both overloads use the same private owner. */
export function transitionTurnBoundary(state: ActiveRun, event: FactOnlyBoundaryEvent): void;
export function transitionTurnBoundary(runId: string, state: ActiveRun, event: CarryEvent, effects: BoundaryCarrierEffects): TurnEndOutcome;
export function transitionTurnBoundary(runId: string, state: ActiveRun, event: Extract<EffectBoundaryEvent, { kind: 'input-error' }>, effects: Required<Pick<TurnBoundaryEffects, 'interruptSession'>>): undefined;
export function transitionTurnBoundary(runId: string, state: ActiveRun, event: Extract<EffectBoundaryEvent, { kind: 'held-input-expired' }>, effects: Required<Pick<TurnBoundaryEffects, 'expireHeldInput'>>): undefined;
export function transitionTurnBoundary(...args:
  | [state: ActiveRun, event: FactOnlyBoundaryEvent]
  | [runId: string, state: ActiveRun, event: EffectBoundaryEvent, effects: TurnBoundaryEffects]
): TurnEndOutcome | undefined {
  if (args.length === 2) {
    const [state, event] = args;
    return applyBoundaryEvent(state.boundary, event, {});
  }
  const [, state, event, effects] = args;
  return applyBoundaryEvent(state.boundary, event, effects);
}
