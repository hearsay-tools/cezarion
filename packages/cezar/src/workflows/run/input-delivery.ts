import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import type { ConversationMessage } from '@open-mercato/cezar-contract/conversations';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { AgentSession } from '../../core/claude-cli-runner.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { ContinueRunOptions } from '../continuation-admission.ts';
import type { ActiveRun } from '../active-run.ts';
import type { PastedContent } from '../pasted-content.ts';
import { contentBlocksOf, pastedAttachmentsNote } from '../pasted-content.ts';
import { startCompletionCycle } from '../completion-policy.ts';
import { chargesBudget, hasPrWait, isMonitoringTimer, openWaitsFooter, resolvedWaits, waitInputId } from '../waits.ts';
import { transition, type RunExitId } from '../run-states.ts';
import { DelegationPolicyError } from '../../delegation/policy.ts';
import { enqueueAgentInput, agentInputBatch } from '../../delegation/input.ts';
import { answersQuestion } from '../../delegation/questions.ts';
import { acknowledgedBatch } from '../outcome-batches.ts';
import { analyseAcknowledgedInput, type AcknowledgedInput } from '../input-acknowledgement.ts';
import { pendingConversationBatch, reservesAutomaticWake, formatAgentInput } from './input-batch.ts';
import { clearUnreadInputTimer, clearHeldHumanInputTimer, harnessOwesInput, harnessHoldsHumanInput, clearIdleTimer } from './input-timers.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { canProceedWithRun, historyDeletionPending } from './run-guards.ts';
import { withFailuresCleared } from './wake-ledger.ts';
import { expandRegistrySlashSkill } from './prompts.ts';
import { resolvedWaitInputBatch } from './resolved-wait-input-batch.ts';
import * as inputReceipts from './input-receipts.ts';
import type { RunModuleContext, SettledTurn } from './types.ts';
import type { RunLine } from './run-line.ts';
import type { WorkerExecutions } from './worker-executions.ts';
import type { RunSkills } from './run-skills.ts';
import type { AttachmentWriter } from './attachment-writer.ts';
import type { HumanWaits } from './human-waits.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import type { WaitRegistry } from './wait-registry.ts';

type HumanAnswerBudget = { spent: number };
type RoutedAnswer = { routed: { askSeq: number; message: ConversationMessage }; reply: AgentInput; text: string; state: ActiveRun | undefined; fallback: boolean };
export const HELD_HUMAN_INPUT_RECHECK_MS = 250;
interface InputDeliveryHost {
  active: ReadonlyMap<string, ActiveRun>;
  line: RunLine; workerExecutions: WorkerExecutions; runSkills: RunSkills; attachments: AttachmentWriter;
  humanWaits: HumanWaits; workerQuestions: WorkerQuestions; waitRegistry: WaitRegistry;
  inputReceiptHost: inputReceipts.InputReceiptsHost;
  isActive(id: string): boolean; move(id: string, exit: RunExitId): unknown;
  workerExecutionStopped(id: string): boolean; executionBlockedByRootFinish(run: RunRecord): boolean;
  hasUnansweredHumanAsk(id: string): boolean; countAutomaticWakes(id: string, budget?: HumanAnswerBudget): number;
  recoveringRun(id: string): boolean; continueRun(id: string, opts: ContinueRunOptions, defer: boolean): { ok: boolean; error?: string };
  canProceedWithRun(id: string, run: RunRecord | undefined): boolean;
  parkForUser(id: string, state: ActiveRun, step: string | undefined): void;
  settleTurn(id: string, state: ActiveRun, entry: 'ack' | 'ready', turn: SettledTurn): boolean;
  boundaryTurn(id: string, state: ActiveRun, session: AgentSession, done: boolean): SettledTurn;
  canAutoContinue(id: string, state: ActiveRun): boolean; armNoWaitNudgeReplyTimer(id: string, state: ActiveRun): void;
  awaitCompletionNudgeReply(id: string, state: ActiveRun, session: AgentSession): void;
  queueWaitWake(id: string): void; owesWake(run: RunRecord, budget?: HumanAnswerBudget): boolean;
  pendingConversationWakes(run: RunRecord, budget?: HumanAnswerBudget): AgentInput[]; routedAnswer(id: string): AgentInput | undefined;
  spendWakeAdmission(id: string, state: ActiveRun, owed: boolean): void; cancelAutomaticAtCap(id: string, waits: readonly Wait[]): void;
  reparkWithoutWaits(id: string, state: ActiveRun): void; holdPeerWakesAtCap(id: string): void;
  reconcileWorkerWaits(): void; unreadInputGraceMs(): number;
  submitAgentInput(id: string, state: ActiveRun, content: ContentBlock[], inputs?: readonly string[], budget?: HumanAnswerBudget): boolean;
}

function unreadInputUnconfirmedNote(count: number): string {
  return `delivered ${count} message${count === 1 ? '' : 's'}; the agent did not confirm reading ${count === 1 ? 'it' : 'them'}`;
}

export class InputDelivery {
  constructor(private readonly context: RunModuleContext, private readonly host: InputDeliveryHost, private readonly maxAutoContinues: number, private readonly routedQuestionRefusal: string) {}

  steerWorker(runId: string, input: AgentInput): 'queued' | 'delivered' {
    const run = this.context.store.getRun(runId);
    if (!run || run.delegation?.role !== 'worker' || run.delegation.parentRunId !== input.parentRunId) {
      throw new DelegationPolicyError('denied_scope', 'not an owned worker');
    }
    if (this.host.executionBlockedByRootFinish(run)) throw new DelegationPolicyError('incompatible_state', 'parent finish is pending');
    const queue = enqueueAgentInput(run, input);
    this.context.store.commitAgentInputs(runId, queue);
    this.context.store.appendEvent(runId, { type: 'agent-input', input: queue[queue.length - 1] });
    this.flushAgentInputs(runId);
    const error = this.host.active.get(runId)?.agentInputError;
    if (error) throw new DelegationPolicyError('incompatible_state', error);
    return this.context.store.getRun(runId)?.agentInputs?.find(entry => entry.id === input.id)?.deliveredAt ? 'delivered' : 'queued';
  }

  sendMessage(runId: string, content: PastedContent[], messageId?: string): boolean {
    const delivered = this.deliverMessage(runId, content, true, messageId);
    if (delivered) {
      const state = this.host.active.get(runId);
      if (state) state.monitoringCapNoted = undefined;
    }
    return delivered;
  }

  respondPermission(runId: string, requestId: string, optionId: string): boolean {
    const state = this.host.active.get(runId);
    const run = this.context.store.getRun(runId);
    if (this.context.disposed() || !state?.session?.open || state.cancelled || state.finishRequested || !this.host.canProceedWithRun(runId, run) ||
        !state.pendingPermissions?.has(requestId)) return false;
    return state.session.respondPermission?.(requestId, optionId) ?? false;
  }

  /** Latch an agent input error, then interrupt: a transport failure the interrupt causes is secondary. */
  latchAgentInputError(runId: string, state: ActiveRun, session: AgentSession, message: string): void {
    state.agentInputError = message;
    try { session.interrupt(); } finally {
      try { this.context.store.appendEvent(runId, { type: 'error', message }); }
      catch { console.error(`[cez] ${message}`); }
    }
  }

  deliverConversationInput(runId: string): void {
    if (this.context.disposed()) return;
    const run = this.context.store.getRun(runId);
    if (!run?.delegation || run.delegation.role === 'invalid' || historyDeletionPending(this.context.store, runId) ||
      this.host.executionBlockedByRootFinish(run) || !['queued', 'running', 'waiting'].includes(run.status) ||
      this.host.workerExecutionStopped(runId)) return;
    // Only the parent's reply to a routed question answers it (#505), through the answer seam.
    // An answer already executing keeps its checkpoint until turn-end but holds no input (#935).
    if (this.host.hasUnansweredHumanAsk(runId)) this.answerRoutedQuestion(runId);
    this.host.waitRegistry.resolvePeerWaits([runId]); // The one exception: a named peer's message ends a peer wait (hearsay-tools/cezarion#1995).
    // Messages are not waits (hearsay-tools/cezarion#1235): one the run has not received wakes it
    // through the wait list's admission, beside every open wait and a pending question, and ends
    // none of them. A turn in progress takes it at once, as steering.
    const current = this.context.store.getRun(runId);
    if (!current || !this.host.pendingConversationWakes(current).length) { this.host.holdPeerWakesAtCap(runId); return; }
    const state = this.host.active.get(runId);
    if (current.status === 'waiting' && (!state || state.atTurnBoundary === state.session)) this.host.queueWaitWake(runId);
    else if (!this.host.recoveringRun(runId)) this.flushAgentInputs(runId);
  }

  /** The parent's reply answers the routed question like a human answer would: through the
   * live session's native answer seam, or by reopening a session that is gone (#505). */
  answerRoutedQuestion(runId: string, admitted = false): void {
    const answer = this.pendingRoutedAnswer(runId);
    if (!answer) return;
    const { state } = answer;
    if (!state) this.reopenRoutedAnswer(runId, answer);
    else this.deliverRoutedAnswer(runId, state, answer, admitted);
  }

  private pendingRoutedAnswer(runId: string) {
    const routed = this.host.workerQuestions.routedAsk(runId);
    const run = this.context.store.getRun(runId);
    const reply = routed && run?.agentInputs?.find(input => !input.deliveredAt && answersQuestion(routed.message, input));
    // A stopped worker is the human's to continue; a parent answer never revives it.
    if (!routed || !reply || run?.delegation?.role !== 'worker' || !['queued', 'running', 'waiting'].includes(run.status)) return undefined;
    // Verbatim: a native answer seam parses `Header: label` lines, exactly as a human's.
    const text = reply.text;
    const state = this.host.active.get(runId);
    const fallback = this.host.workerQuestions.isWorkerFallbackAsk(runId, routed.askSeq);
    return { routed, reply, text, state, fallback };
  }

  private reopenRoutedAnswer(runId: string, answer: RoutedAnswer): void {
    const { text, reply, fallback } = answer;
    // An automated answer is not a human override: the reopened session waits for capacity.
    // It withdraws no wait (hearsay-tools/cezarion#1235).
    if (this.host.isActive(runId)) return;
    const result = this.host.continueRun(runId, { text, answerInputId: reply.id }, true);
    if (!result.ok) this.context.store.appendEvent(runId, { type: 'note', tone: 'warning', message: `parent answer not delivered: ${result.error}` });
    else if (fallback) this.host.workerQuestions.chargeWorkerFallbackReply(runId);
  }

  private deliverRoutedAnswer(runId: string, state: ActiveRun, answer: RoutedAnswer, admitted: boolean): void {
    const { routed, reply, text, fallback } = answer;
    if (!state.session?.open || state.cancelled || state.openingAgentInputId === reply.id) return;
    // Already waiting for admission: only the admission itself may deliver it.
    if (!admitted && (this.host.line.hasWake(runId) || this.host.line.isAdmitted(runId))) return;
    if (!admitted && this.host.line.isParked(runId)) {
      // The parked worker released its slot: the answer is a wake (`owesWake`), which the
      // scheduler's admission delivers here (`deliverAdmittedWake`). It withdraws no wait the
      // worker registered before asking (hearsay-tools/cezarion#1235).
      this.host.queueWaitWake(runId);
      return;
    }
    const bundle = state.atTurnBoundary === state.session ? pendingConversationBatch(this.context.store.getRun(runId), state, input => formatAgentInput(input, id => this.context.store.getRun(id)), reply.id) : undefined;
    if (!state.session.sendMessage([{ type: 'text', text }, ...(bundle ? [{ type: 'text' as const, text: bundle.text }] : [])])) return;
    this.context.store.appendEvent(runId, { type: 'human-input-delivered', askSeq: routed.askSeq, source: 'parent' });
    inputReceipts.commitRoutedAnswer(this.context, runId, state, [reply.id, ...(bundle?.inputs.map(input => input.id) ?? [])], fallback, this.maxAutoContinues);
    // Spend the answer's admission now so later messages can steer before its turn ends.
    if (this.host.line.retireAdmission(runId)) state.waitWakeTurn = state.session;
    state.pendingHumanAsk = hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id));
    if (!state.pendingHumanAsk) this.flushAgentInputs(runId);
    this.resumeParkedRun(runId, state);
  }

  /** Accepted input may be temporarily refused while a backend HTTP ack is
   * outstanding. That is not an empty queue and must not trigger automatic DONE. `except` leaves
   * out inputs already submitted, such as an acknowledgement still in flight. */
  hasQueuedAgentInputs(runId: string, except: readonly string[] = []): boolean {
    const run = this.context.store.getRun(runId);
    return !!run && ['queued', 'running', 'waiting'].includes(run.status) &&
      !(run.delegation?.role === 'worker' && run.delegation.destroy) &&
      (!!run.agentInputs?.some(input => !input.deliveredAt && !except.includes(input.id)) || harnessOwesInput(this.host.active.get(runId)));
  }

  /** An idle, open boundary with nothing left to deliver: DONE closes, otherwise the
   * run parks as waiting or monitoring. Shared by acknowledgements that land after a
   * turn ended and by the unread-input grace timer (#505). */
  settleIdleBoundary(runId: string, state: ActiveRun, session: AgentSession): void {
    // An in-flight acknowledgement still owns this boundary; its .then re-settles.
    if (harnessHoldsHumanInput(state) || state.agentInputFlight) return;
    const proseGate = state.parkAfterAck?.session === session && state.parkAfterAck.humanGate;
    if (this.reparkPendingQuestion(runId, state, session, proseGate)) return;
    if (state.atTurnBoundary !== session || (state.pendingHumanAsk && !proseGate) || (!proseGate && this.hasQueuedAgentInputs(runId))) return;
    // The turn end deferred to this acknowledgement (OpenCode HTTP/SSE): the turn that answered an
    // input finished before the input's acknowledgement. Its done, the waits still owed (a wake
    // acknowledged after its turn ended) or the turn end it kept (`parkAfterAck`) settle now, with
    // queued and accepted input still taking priority above (hearsay-tools/cezarion#1234, #1525).
    // Cezar's own human wait is not owed: the rule decides, and the agent's wait replaces it.
    const done = state.doneAtBoundary === session;
    if (!done && (this.host.line.isParked(runId) ||
      (state.parkAfterAck?.session !== session && (proseGate || !this.host.humanWaits.holdsAgentWaits(runId))))) return;
    this.host.settleTurn(runId, state, 'ack', this.host.boundaryTurn(runId, state, session, done));
  }

  private reparkPendingQuestion(runId: string, state: ActiveRun, session: AgentSession, proseGate: boolean | undefined): boolean {
    // A wake beside a pending question can be acknowledged after its turn ended, and its
    // checkpoint takes the run out of the question's park: park for the question again
    // (hearsay-tools/cezarion#1233).
    if (state.pendingHumanAsk && !proseGate && state.atTurnBoundary === session && session.open &&
      !this.host.line.isParked(runId) && state.currentStepId) {
      this.host.parkForUser(runId, state, state.currentStepId);
      return true;
    }
    return false;
  }

  /** #505 liveness bound: a harness that accepted input and then neither read it nor ran
   * another turn must not hold the run and its slot forever. After a quiet grace window the
   * input is resubmitted once; after a second it is left delivered but unconfirmed. */
  armUnreadInputTimer(runId: string, state: ActiveRun): void {
    clearUnreadInputTimer(state);
    const session = state.session;
    if (!session?.open || state.pendingHumanAsk || !harnessOwesInput(state) || state.agentInputFlight) return;
    const timer = setTimeout(() => {
      state.unreadInputTimer = undefined;
      if (this.context.disposed() || this.host.active.get(runId) !== state || state.session !== session || !session.open || state.cancelled ||
        state.pendingHumanAsk || state.agentInputFlight || !harnessOwesInput(state)) return;
      const ids = [...state.unreadInputIds!];
      const retried = ids.filter(id => state.unreadRetried?.has(id));
      const fresh = ids.filter(id => !state.unreadRetried?.has(id));
      if (retried.length) {
        for (const id of retried) state.unreadInputIds?.delete(id);
        try { this.context.store.commitAgentInputsUnconfirmed(runId, retried); } catch { /* receipt stays awaiting; a restart replays it */ }
        this.context.store.appendEvent(runId, { type: 'note', message: unreadInputUnconfirmedNote(retried.length) });
      }
      if (fresh.length) {
        state.unreadRetried ??= new Set();
        for (const id of fresh) state.unreadRetried.add(id);
        inputReceipts.retireUnreadInputs(this.context, this.host.inputReceiptHost, runId, state, fresh, true);
      }
      // No content since the last turn ended: the harness is idle, whatever turn it announced.
      if (!harnessOwesInput(state) && !state.agentInputFlight) {
        state.atTurnBoundary = session;
        if (state.parkAfterAck?.session !== session) state.parkAfterAck = { session, monitoring: false };
        this.settleIdleBoundary(runId, state, session);
      }
    }, this.host.unreadInputGraceMs());
    timer.unref?.();
    state.unreadInputTimer = timer;
  }

  /** #486: a turn-end deferred close/park only because the harness still held a human follow-up. */
  armHeldHumanInputTimer(runId: string, state: ActiveRun): void {
    clearHeldHumanInputTimer(state, false);
    const session = state.session;
    if (!session?.open || !harnessHoldsHumanInput(state)) {
      state.heldHumanInputSince = undefined;
      return;
    }
    state.heldHumanInputSince ??= Date.now();
    const timer = setTimeout(() => {
      state.heldHumanInputTimer = undefined;
      if (this.context.disposed() || this.host.active.get(runId) !== state || state.session !== session || !session.open ||
        state.cancelled || state.idleClosed || state.atTurnBoundary !== session) return;
      if (harnessHoldsHumanInput(state)) {
        // An in-flight ACK still owns this boundary; its .then re-settles.
        if (state.agentInputFlight) {
          this.armHeldHumanInputTimer(runId, state);
          return;
        }
        if (Date.now() - (state.heldHumanInputSince ?? 0) >= this.host.unreadInputGraceMs()) {
          const held = session.heldHumanInputCount?.() ?? 0;
          this.context.store.appendEvent(runId, {
            type: 'note',
            message: held > 0
              ? unreadInputUnconfirmedNote(held)
              : 'delivered held messages; the agent did not confirm reading them',
          });
          state.heldHumanInputExpired = true;
          this.settleIdleBoundary(runId, state, session);
          return;
        }
        this.armHeldHumanInputTimer(runId, state);
        return;
      }
      this.settleIdleBoundary(runId, state, session);
    }, HELD_HUMAN_INPUT_RECHECK_MS);
    timer.unref?.();
    state.heldHumanInputTimer = timer;
  }

  private inputReadyAuthorized(runId: string, state: ActiveRun, session: AgentSession | undefined): session is AgentSession {
    return !(!session || this.context.disposed() || this.host.active.get(runId) !== state || state.session !== session ||
      !session.open || state.idleClosed || state.cancelled || state.finishRequested || state.agentInputError || state.agentSessionError);
  }

  /** A callback from an old/replaced/disposed session carries no authority. */
  handleAgentInputReady(runId: string, state: ActiveRun, session: AgentSession | undefined): void {
    if (!this.inputReadyAuthorized(runId, state, session)) return;
    // Durable input always gets the first opportunity. Only the same refused,
    // completed boundary may retry; ordinary/native question parks are not wakes.
    if (this.flushAgentInputs(runId)) return;
    // #486: held human input drained at this still-current boundary with no new turn.
    // Runners fire onAgentInputReady from the transport ACK finally/callback while
    // agentInputFlight is still set; settling here parks before the ACK .then can nudge.
    const idle = state.atTurnBoundary === session && !harnessHoldsHumanInput(state) &&
      !state.agentInputFlight && !harnessOwesInput(state);
    // The refused autonomous nudge retries at the boundary it waited at: the turn-end rule decides it
    // again (hearsay-tools/cezarion#1525).
    // It keeps tryAutonomousNudge's own guards: a run that may not continue on its own keeps the
    // retry pending, bounded by the idle timer.
    if (idle && state.autonomousNudgePending === session && state.doneAtBoundary !== session && state.currentStepId &&
      state.autonomous && this.host.canAutoContinue(runId, state)) {
      this.host.settleTurn(runId, state, 'ready', { ...this.host.boundaryTurn(runId, state, session, false), monitoring: false });
      return;
    }
    if (idle) this.settleIdleBoundary(runId, state, session);
  }

  /** Reservation is synchronous; only an acknowledged transport may checkpoint delivery. */
  submitAgentInput(runId: string, state: ActiveRun, content: ContentBlock[], inputIds: readonly string[] = [], beforeHumanReset?: HumanAnswerBudget): boolean {
    const session = state.session;
    if (!session?.open || state.agentInputFlight || state.cancelled || state.finishRequested || state.agentInputError) return false;
    if (!this.admitsAgentInput(runId, state, session, inputIds, beforeHumanReset)) return false;
    // Every delivered turn ends with the waits still open.
    const footer = openWaitsFooter(this.context.store.getRun(runId)?.waits ?? [], { tools: !state.toolless });
    if (footer) content = [...content, { type: 'text', text: `\n\n${footer}` }];
    // A refusal queued for a closed session (hearsay-tools/cezarion#1301): this turn is the nudge's.
    const refusal = !!this.context.store.getRun(runId)?.agentInputs?.some(input => input.purpose === 'completion-refusal' && inputIds.includes(input.id));
    const flight: NonNullable<ActiveRun['agentInputFlight']> = { session, inputIds,
      ...(this.host.line.isAdmitted(runId) && state.atTurnBoundary === session ? { admittedWake: true } : {}) };
    // A batch with timer results is an automatic wake: it reserves one unit of the budget now, so a timer that comes due before this acknowledgement counts it, and gives it back if the batch is refused or its acknowledgement rejects (hearsay-tools/cezarion#1233).
    if (reservesAutomaticWake(this.context.store.getRun(runId), flight, inputIds, () => this.host.countAutomaticWakes(runId, beforeHumanReset), this.maxAutoContinues)) flight.wakeReserved = true;
    state.agentInputFlight = flight;
    const settled = this.sendAgentInput(runId, state, flight, content, refusal);
    if (!settled) return false;
    this.host.workerExecutions.trackDelivery(runId, settled);
    this.resumeParkedRun(runId, state, beforeHumanReset);
    this.recordAgentInputTurn(runId, state, flight, refusal);
    return true;
  }

  private recordAgentInputTurn(runId: string, state: ActiveRun, flight: NonNullable<ActiveRun['agentInputFlight']>, refusal: boolean): void {
    const { session, inputIds } = flight;
    if (flight.admittedWake || resolvedWaits(this.context.store.getRun(runId) ?? {}).some(wait => inputIds.includes(waitInputId(wait)))) state.waitWakeTurn = session;
    // A refusal queued while the session was gone makes this the nudge's turn; any other input is a wake, which starts a fresh cycle (hearsay-tools/cezarion#1301). A live nudge carries no input.
    if (refusal) this.host.awaitCompletionNudgeReply(runId, state, session);
    else if (inputIds.length) startCompletionCycle(state);
  }

  private admitsAgentInput(runId: string, state: ActiveRun, session: NonNullable<ActiveRun['session']>, inputIds: readonly string[], beforeHumanReset?: HumanAnswerBudget): boolean {
    // A pending question admits only a wake made of resolved-wait results and messages, at a turn boundary: it stays answerable, and nothing else is delivered until it is answered (hearsay-tools/cezarion#1233, #1235).
    if (state.pendingHumanAsk) {
      const run = this.context.store.getRun(runId);
      const owed = new Set(run ? [...resolvedWaits(run).map(waitInputId), ...this.host.pendingConversationWakes(run, beforeHumanReset).map(input => input.id)] : []);
      if (state.atTurnBoundary !== session || !inputIds.length || !inputIds.every(id => owed.has(id))) return false;
    }
    return true;
  }

  private sendAgentInput(runId: string, state: ActiveRun, flight: NonNullable<ActiveRun['agentInputFlight']>, content: ContentBlock[], refusal: boolean): Promise<void> | false {
    const { session, inputIds } = flight;
    const refund = (): void => { flight.wakeReserved = false; };
    const current = (): boolean => !this.context.disposed() && this.host.active.get(runId) === state && state.session === session &&
      state.agentInputFlight === flight && !state.cancelled && !state.finishRequested && !this.host.workerExecutionStopped(runId) &&
      !!this.context.store.getRun(runId) && !this.host.executionBlockedByRootFinish(this.context.store.getRun(runId)!);
    const fail = (error: unknown, checkpoint: boolean): void => {
      if (!current() || state.agentSessionError || state.agentInputError) return;
      this.latchAgentInputError(runId, state, session, `${checkpoint ? 'agent input delivery checkpoint failed' : 'agent input delivery failed'}: ${error instanceof Error ? error.message : String(error)}`);
    };
    let acknowledgement: false | Promise<void>;
    // A wake beside a pending question tells the runner so: native wires refuse agent input while a portable CEZ:ASK is pending, and this input is not its answer. The question stays Cezar's and its card stays answerable; the provider's acknowledgement is still the checkpoint, and a rejected one fails the session like any other, leaving the waits resolved for a continuation.
    const besideQuestion = !!state.pendingHumanAsk;
    try {
      acknowledgement = besideQuestion ? session.sendAgentMessage(content, inputIds, { besideQuestion })
        : session.sendAgentMessage(content, inputIds);
    }
    catch (error) { refund(); fail(error, false); state.agentInputFlight = undefined; return false; }
    if (!acknowledgement) { refund(); state.agentInputFlight = undefined; return false; }
    // Attach rejection handling before any persistence/capacity work can throw.
    flight.settled = acknowledgement.then(() => {
      // A positive command ACK can precede a provider-close frame in the same read batch. Closing the transport afterwards does not revoke that ACK; explicit stop/disposal/replacement still revoke authority via current().
      if (!current()) return;
      try {
        if (inputIds.length) {
          const batch = analyseAcknowledgedInput(runId, state, flight, inputIds, this.context.store, this.host.line.admissions(), run => this.host.owesWake(run));
          if (!batch) return;
          const { accepted, resolvedIds, early, spent, observable, at, resumes } = batch;
          // One commit (hearsay-tools/cezarion#1805): the messages, then each wait's delivery (a message a wait carries keeps its read receipt), the charge, the early reads, the cleared failure count and the resume (hearsay-tools/cezarion#1235).
          this.context.store.commitOutcome(runId, withFailuresCleared(this.context.store, runId, acknowledgedBatch({ accepted, resolvedIds, early, spent, observable, at }), accepted, resolvedIds.length > 0),
            resumes ? { patch: { status: transition('resume', () => this.context.store.getRun(runId)) }, resumeStepId: resolvedIds.length ? state.currentStepId : undefined } : {});
          this.applyAcknowledgedInput(runId, state, flight, batch, refusal);
        }
      } catch (error) { fail(error, true); }
    }, error => { refund(); fail(error, false); }).then(() => {
      if (state.agentInputFlight !== flight) return;
      const authorized = current();
      state.agentInputFlight = undefined;
      if (!authorized || !session.open || state.agentSessionError || state.agentInputError) return;
      // A liveness resubmission gets its own quiet window, and so does input acknowledged after its turn already ended: no later turn-end would arm one (#505 review).
      if (inputIds.some(id => state.unreadRetried?.has(id)) || state.atTurnBoundary === session) this.armUnreadInputTimer(runId, state);
      if (this.flushAgentInputs(runId)) return;
      this.settleIdleBoundary(runId, state, session);
    }).catch(error => {
      // Bookkeeping failures cannot become unhandled promise rejections.
      if (state.agentInputFlight === undefined) state.agentInputFlight = flight;
      try { fail(error, true); } finally { if (state.agentInputFlight === flight) state.agentInputFlight = undefined; }
    });
    return flight.settled;
  }

  /** Apply the acknowledgement's effects only after its outcome commit succeeds. */
  private applyAcknowledgedInput(runId: string, state: ActiveRun, flight: NonNullable<ActiveRun['agentInputFlight']>, batch: AcknowledgedInput, refusal: boolean): void {
    const { accepted, resolvedIds, early, spent, observable, timers, peers, resumes, owedBefore } = batch;
    const { session } = flight;
    if (spent !== undefined) {
      flight.wakeReserved = false;
      const kind = !timers.length && peers.length ? 'peer message' : timers.some(isMonitoringTimer) ? 'monitoring' : (['timer', 'process', 'peer'] as const).find(k => timers.some(wait => wait.kind === k));
      this.context.store.appendEvent(runId, { type: 'note', message: `automatic ${kind} wake-up (${spent}/${this.maxAutoContinues})` });
    }
    // A wake of results always spends its admission; a wake of messages alone, only one it holds.
    if (resumes && (this.host.line.retireAdmission(runId) || resolvedIds.length > 0)) {
      this.host.spendWakeAdmission(runId, state, resolvedIds.length ? resolvedWaits(this.context.store.getRun(runId) ?? {}).length > 0 : owedBefore);
    }
    // Rearm the refusal turn's bound after the wake checkpoint cleared the park's timers.
    if (refusal && state.completionNudged === session) this.host.armNoWaitNudgeReplyTimer(runId, state);
    // Until observed read, a failed steering session requeues the input and counts a failure.
    for (const id of observable ? accepted : []) { if (early.includes(id)) state.consumedBeforeAck?.delete(id); else state.unreadInputIds?.add(id); }
    this.host.reconcileWorkerWaits();
  }

  /** False leaves the durable entry untouched. The answer commits its reset before this flush,
   *  but this one synchronous flush keeps the budget decisions it made before that reset
   *  (hearsay-tools/cezarion#1906). Later acknowledgements read the restarted budget normally. */
  flushAgentInputs(runId: string, beforeHumanReset?: HumanAnswerBudget): boolean {
    const state = this.host.active.get(runId);
    let run = this.context.store.getRun(runId);
    if (!state?.session?.open || state.cancelled || state.agentInputError || state.agentInputFlight || !run ||
      !['queued', 'running', 'waiting'].includes(run.status) || this.host.executionBlockedByRootFinish(run) ||
      (run.delegation?.role === 'worker' && run.delegation.destroy)) return false;
    run = this.supersedeFallbackBeforeFlush(runId, state, run, beforeHumanReset);
    // A question pending at a turn boundary still takes an admitted wake of resolved-wait results
    // and messages; one pending mid-turn (a native ask) takes nothing until its turn ends.
    const askPending = state.pendingHumanAsk || this.host.hasUnansweredHumanAsk(runId);
    if (askPending && state.atTurnBoundary !== state.session) return false;
    run = this.cancelCappedTimersBeforeFlush(runId, state, run, beforeHumanReset);
    return this.flushAgentInputBatch(runId, state, run, askPending, beforeHumanReset);
  }

  private supersedeFallbackBeforeFlush(runId: string, state: ActiveRun, run: RunRecord, beforeHumanReset?: HumanAnswerBudget): RunRecord {
    // A parent's input to a worker supersedes Cezar's fallback question, charged as its reply would
    // be (hearsay-tools/cezarion#1301); the parent's reply to it goes through the answer seam.
    const answer = this.host.routedAnswer(runId)?.id;
    if (run.agentInputs?.some(input => !input.deliveredAt && input.source === 'agent' && input.id !== answer && input.id !== state.openingAgentInputId) &&
      this.host.workerQuestions.supersedeWorkerFallback(runId)) {
      // The old post-flush reset erased this charge. Keep its decision and note, without writing
      // an old charge over the reset already committed with the human answer.
      this.host.workerQuestions.chargeWorkerFallbackReply(runId, beforeHumanReset);
      run = this.context.store.getRun(runId)!;
    }
    return run;
  }

  private cancelCappedTimersBeforeFlush(runId: string, state: ActiveRun, run: RunRecord, beforeHumanReset?: HumanAnswerBudget): RunRecord {
    // A timer result still owed when the budget is spent is cancelled before its batch is sent; the
    // CI results beside it are delivered.
    if (this.host.countAutomaticWakes(runId, beforeHumanReset) >= this.maxAutoContinues && this.host.line.isAdmitted(runId) && state.atTurnBoundary === state.session) {
      const owedTimers = resolvedWaits(run).filter(chargesBudget);
      if (owedTimers.length) {
        this.host.cancelAutomaticAtCap(runId, owedTimers);
        run = this.context.store.getRun(runId)!;
        // Nothing left to wake for: the admission ends here, and a parked run becomes a plain park.
        if (!resolvedWaits(run).length) { this.host.line.retireAdmission(runId); this.host.reparkWithoutWaits(runId, state); }
      }
    }
    return run;
  }

  private flushAgentInputBatch(runId: string, state: ActiveRun, run: RunRecord, askPending: boolean, beforeHumanReset?: HumanAnswerBudget): boolean {
    // The opening prompt already carries its own input; later input steers the
    // opening turn instead of waiting for it to end (#505).
    const resolved = resolvedWaits(run);
    const owed = new Set(resolved.map(waitInputId));
    // A resolved wait's input is delivered only by its admitted wake, never as ordinary input.
    // Beside a pending question only messages go with it (hearsay-tools/cezarion#1235).
    const beside = new Set(this.host.pendingConversationWakes(run, beforeHumanReset).map(input => input.id));
    // A refusal queued for a closed session waits for the reopened session's turn boundary: the
    // turn that answers it is the nudge's (hearsay-tools/cezarion#1301), not the opening turn.
    const boundary = state.atTurnBoundary === state.session;
    const queue = (run.agentInputs ?? []).filter(input => input.id !== state.openingAgentInputId && !owed.has(input.id) &&
      (!askPending || beside.has(input.id)) && (boundary || input.purpose !== 'completion-refusal'));
    const admitted = this.host.line.isAdmitted(runId) && state.atTurnBoundary === state.session;
    if (resolved.length && admitted) {
      const batch = resolvedWaitInputBatch(run, resolved, queue, input => formatAgentInput(input, id => this.context.store.getRun(id)), { tools: !state.toolless, workerStatus: this.host.waitRegistry.workerStatus });
      if (!batch) return false;
      return this.host.submitAgentInput(runId, state, [{ type: 'text', text: batch.text }], batch.inputIds, beforeHumanReset);
    }
    // Messages beside a pending question go only with an admitted wake (hearsay-tools/cezarion#1235).
    if (askPending && !admitted) return false;
    // An open or owed CI wait holds conversation input for its own admitted wake (#476); a message
    // is a wake of its own, so an admitted one goes beside it (hearsay-tools/cezarion#1235).
    if (!admitted && (hasPrWait(run) || (resolved.length && !queue.some(input => !input.deliveredAt)))) return false;
    const batch = agentInputBatch(queue, input => formatAgentInput(input, id => this.context.store.getRun(id)));
    if (!batch) return false;
    const text = batch.inputs.map(input => formatAgentInput(input, id => this.context.store.getRun(id))).join('\n\n');
    return this.host.submitAgentInput(runId, state, [{ type: 'text', text }], batch.inputs.map(input => input.id), beforeHumanReset);
  }

  /** Restore active lifecycle/accounting when either Cezar or the backend
   * resumes work in a parked session. */
  resumeParkedRun(runId: string, state: ActiveRun, beforeHumanReset?: HumanAnswerBudget): void {
    clearHeldHumanInputTimer(state);
    state.autonomousNudgePending = undefined;
    state.atTurnBoundary = undefined;
    state.doneAtBoundary = undefined;
    state.parkAfterAck = undefined;
    clearIdleTimer(state);
    // A wake command can emit activity before its transport ACK. Keep its park
    // until the durable delivery checkpoint; admission already reserves capacity.
    const owing = this.context.store.getRun(runId);
    if (owing && this.host.owesWake(owing, beforeHumanReset) && this.host.line.isAdmitted(runId)) return;
    // Its waits stay open and a pool member keeps its slot: only a turn end or a terminal path
    // changes either (hearsay-tools/cezarion#1233).
    this.host.line.unpark(runId);
    this.host.move(runId, 'resume');
    if (state.currentStepId) {
      this.context.store.updateStep(runId, state.currentStepId, { status: 'running' });
    }
  }

  /** Shared live-session delivery. Synthetic scheduler prompts reuse lifecycle
   * bookkeeping without masquerading as user-authored transcript messages. */
  deliverMessage(runId: string, content: PastedContent[], userAuthored: boolean, messageId?: string): boolean {
    const state = this.host.active.get(runId);
    if (!state?.session?.open || state.cancelled || state.pendingPermissions?.size) return false;
    const run = this.context.store.getRun(runId);
    if (!canProceedWithRun(run, () => this.host.workerExecutionStopped(runId), run => this.host.executionBlockedByRootFinish(run))) return false;

    if (userAuthored && this.host.workerQuestions.routedAsk(runId)) {
      this.context.store.appendEvent(runId, { type: 'note', tone: 'warning', message: this.routedQuestionRefusal });
      return false;
    }
    // Cezar's fallback question on a worker never holds what the plain park it replaced let
    // through: an automatic message supersedes it, as a parent's input does (hearsay-tools/cezarion#1301).
    if (!userAuthored) this.host.workerQuestions.supersedeWorkerFallback(runId);
    const prepared = this.prepareMessageContent(runId, state, content, userAuthored);
    const { blocks, expanded, deliverable } = prepared;
    const delivered = userAuthored ? state.session.sendMessage(deliverable) : this.host.submitAgentInput(runId, state, deliverable);
    if (delivered && expanded !== blocks) this.host.runSkills.provisionLiveSlashSkill(runId, state, blocks);
    if (delivered) {
      if (userAuthored) this.applyHumanMessageDelivery(runId, state, prepared, messageId);
      else this.resumeParkedRun(runId, state);
    }
    return delivered;
  }

  private prepareMessageContent(runId: string, state: ActiveRun, content: PastedContent[], userAuthored: boolean) {
    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Persist human attachments before the user-message event so the thread can render them.
    const persisted = userAuthored ? this.host.attachments.persistPastedAttachments(runId, content) : [];
    const images = persisted.map((saved) => saved.url);
    if (userAuthored) {
      this.context.store.appendEvent(runId, {
        type: 'user-message',
        stepId: state.currentStepId,
        text,
        imageCount: content.filter((b) => b.type === 'image').length,
        images,
      });
    }

    // Send paths beside image blocks: backends that drop images still receive usable files.
    const blocks = contentBlocksOf(content);
    const expanded = userAuthored ? expandRegistrySlashSkill(blocks, this.host.runSkills.enabledSkills(state)) : blocks;
    const attached: ContentBlock[] = persisted.length
      ? [...expanded, pastedAttachmentsNote(persisted)]
      : expanded.length ? expanded : [{ type: 'text', text: 'The user attached a document, but it could not be saved. Ask them to attach it again before discussing its contents.' }];
    const answeringAskSeq = userAuthored ? pendingHumanAskSeq(this.context.store, runId) : undefined;
    // An answer opening a turn carries held conversation messages after the answer.
    const bundle = userAuthored && answeringAskSeq !== undefined && state.atTurnBoundary === state.session
      ? pendingConversationBatch(this.context.store.getRun(runId), state, input => formatAgentInput(input, id => this.context.store.getRun(id))) : undefined;
    // Human input answers all human waits. Agent input gets its footer in submitAgentInput.
    const footer = userAuthored ? openWaitsFooter((this.context.store.getRun(runId)?.waits ?? []).filter(wait => wait.kind !== 'human'), { tools: !state.toolless }) : undefined;
    const deliverable = userAuthored ? [...attached, ...(bundle ? [{ type: 'text' as const, text: bundle.text }] : []),
      ...(footer ? [{ type: 'text' as const, text: `\n\n${footer}` }] : [])] : attached;
    return { blocks, expanded, deliverable, answeringAskSeq, bundle };
  }

  private applyHumanMessageDelivery(runId: string, state: ActiveRun, prepared: ReturnType<InputDelivery['prepareMessageContent']>, messageId: string | undefined): void {
    const { answeringAskSeq, bundle } = prepared;
    const beforeHumanReset = { spent: this.context.store.getRun(runId)?.automaticWakes ?? 0 };
    // The turn that would have finished now answers the user (hearsay-tools/cezarion#1234).
    state.doneRequested = undefined;
    state.noWaitNudged = undefined;
    state.noWaitNudgeParked = undefined;
    state.noWaitNudgeSawContent = undefined;
    // A human message starts a fresh completion cycle (hearsay-tools/cezarion#1301).
    startCompletionCycle(state);
    if (answeringAskSeq !== undefined) {
      this.context.store.appendEvent(runId, { type: 'human-input-delivered', askSeq: answeringAskSeq });
    }
    inputReceipts.commitAnswer(this.context, runId, state, bundle, messageId);
    state.pendingHumanAsk = hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id));
    // A native answer or a full bundle leaves remaining messages to steer behind the answer.
    if (answeringAskSeq !== undefined && !state.pendingHumanAsk) this.flushAgentInputs(runId, beforeHumanReset);
    this.resumeParkedRun(runId, state, beforeHumanReset);
  }
}
