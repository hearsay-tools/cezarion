import { randomUUID } from 'node:crypto';
import type { RunModuleContext } from './types.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { ConversationState } from '@open-mercato/cezar-contract';
import type { ConversationMessage } from '@open-mercato/cezar-contract/conversations';
import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import type { HumanWaitEntry, WaitVia } from '@open-mercato/cezar-contract/waits';
import type { AskRequest } from '../../core/ask.ts';
import type { PastedContent } from '../pasted-content.ts';
import { askRequestOf } from '@open-mercato/cezar-contract/pending-ask';
import { hasLiveInboxClaim } from '../../delegation/input.ts';
import { commitNewMessage, inboxSlotsUsed, projectConversationEvents } from '../../delegation/conversations.ts';
import { answersQuestion, questionMessage, reservedReplies } from '../../delegation/questions.ts';
import { messagedParentSince, parkNoticeIdInUse, parkNoticeMessage, parkNoticeWait, parkingTurn } from '../../delegation/park-notice.ts';
import { workerQuestionFallback } from '../question-routing.ts';
import { WORKER_FALLBACK_NOTE, WORKER_FALLBACK_REPLY_NOTE } from '../turn-end.ts';
import { historyDeletionPending, rootFinishRequested } from './run-guards.ts';
import { pendingHumanAskSeq, hasPendingHumanAsk } from './pending-ask-facts.ts';

interface WorkerQuestionsHost {
  active(id: string): ActiveRun | undefined;
  deliverConversationInput(id: string): void;
  chargeAutomaticWake(id: string): number;
  hasQueuedAgentInputs(id: string): boolean;
  providerOwnsInboxInput(id: string, input: string): boolean;
  reconcileWorkerWaits(id?: string): void;
  openHumanAlias(id: string, state: ActiveRun | undefined, via: WaitVia, card?: AskRequest): HumanWaitEntry | undefined;
  prepareHumanAsk(state: ActiveRun): void;
  markHumanWaitSurfaced(id: string, wait: HumanWaitEntry, card?: AskRequest): void;
  withdrawCezarHumanWaits(id: string): void;
  routeWorkerQuestion(id: string): void;
  noticeParkedWorker(id: string): void;
  retireUnreadParentQuestion(id: string, request: string): void;
  deleteUnreadInput(id: string, input: string): void;
  updatePendingHumanAsk(id: string, value: boolean): void;
}
type HumanAnswerBudget = { spent: number };
/** Who answers a worker's pending question. */
export type QuestionAnswerSource = 'parent';
/** The undelivered input that answers a worker's pending question, and who sent it. */
export interface QuestionAnswer { askSeq: number; input: AgentInput; source: QuestionAnswerSource }

/** A worker's second turn end with no wait or done asks its parent, as a routed open question
 *  (hearsay-tools/cezarion#1301). */
export const WORKER_FALLBACK_QUESTION = (workerId: string) => `Worker ${workerId} ended its turn without waiting on anything or finishing. Reply with what it should do next.`;
export const WORKER_FALLBACK_HEADER = 'Worker idle';

export class WorkerQuestions {
  constructor(private readonly context: RunModuleContext, private readonly host: WorkerQuestionsHost, private readonly maxAutoContinues: number) {}

  /** A worker's pending question goes to its owning parent as a conversation request
   * (#505). The worker still parks on its ask; only the parent's reply, or a human after
   * fallback, answers it. Routing is idempotent: the message ID derives from the ask seq. */
  routeWorkerQuestion(workerId: string): void {
    const worker = this.context.store.getRun(workerId);
    if (worker?.delegation?.role !== 'worker') return;
    const ask = this.context.store.transcriptFacts(workerId).pendingAsk;
    if (!ask || ask.routedMessageId !== undefined || ask.fallback) return;
    const fallback = (reason: string) => { this.context.store.appendEvent(workerId, { type: 'worker-question-fallback', askSeq: ask.seq, reason }); };
    const request = askRequestOf(ask);
    if (!request) { fallback('the question cannot be carried to the parent'); return; }
    const parentId = worker.delegation.parentRunId;
    const root = this.context.store.getRun(parentId);
    const now = new Date().toISOString();
    const message = questionMessage({ workerRunId: workerId, parentRunId: parentId, askSeq: ask.seq, request, now });
    // Already committed (a crash before the routing event): the question did reach the parent,
    // whatever its capacity or state is now. Record the routing; fallback sweeps follow.
    const committed = root?.delegation?.role === 'root' && !!root.delegation.conversation?.messages.some(m => m.id === message.id);
    if (committed) {
      this.context.store.appendEvent(workerId, { type: 'worker-question-routed', askSeq: ask.seq, messageId: message.id, parentRunId: parentId });
      return;
    }
    const routing = workerQuestionFallback(worker, root, parent => this.parentCanReceive(parent));
    if ('reason' in routing) { fallback(routing.reason); return; }
    const { state } = routing;
    const input = { id: message.id, source: 'agent' as const, parentRunId: parentId, text: message.text, createdAt: now,
      conversation: { senderRunId: workerId, recipientRunId: parentId, kind: 'request' as const } };
    if (!commitNewMessage(this.context.store, parentId, { ...state, messages: [...state.messages, message] }, { recipientRunId: parentId, input }, () => fallback('its message ID is already in use in the parent conversation'))) return;
    projectConversationEvents(this.context.store, this.context.store.getRun(parentId)!);
    this.context.store.appendEvent(workerId, { type: 'worker-question-routed', askSeq: ask.seq, messageId: message.id, parentRunId: parentId });
    this.host.deliverConversationInput(parentId);
  }

  /**
   * A worker parked before finishing while its parent waits on it tells the parent why
   * (hearsay-tools/cezarion#1327): Cezar posts a progress message from the worker, which wakes the
   * parent and closes no wait. A parked question needs none, since the question itself goes to the
   * parent. At most one notice per parent wait (`parkNoticeId`), and none when the turn that
   * parked already messaged the parent, Cezar's own notice included. The message and the parent's
   * input commit together; a crash before that commit leaves the recovery sweep to post it.
   */
  noticeParkedWorker(workerId: string): void {
    const worker = this.context.store.getRun(workerId);
    if (worker?.delegation?.role !== 'worker' || worker.delegation.destroy || !this.parkedBeforeFinishing(worker)) return;
    const parentId = worker.delegation.parentRunId;
    const root = this.context.store.getRun(parentId);
    if (root?.delegation?.role !== 'root' || !this.parentTakesMessages(root) ||
      !root.delegation.receipts.some(receipt => receipt.workerId === workerId && !receipt.deletion)) return;
    const state = root.delegation.conversation ?? { messages: [], outcomes: [] };
    const wait = parkNoticeWait(workerId, root.waits ?? [], state.messages);
    if (!wait) return;
    const turn = parkingTurn(this.context.store.readEvents(workerId));
    if (messagedParentSince(state.messages, workerId, parentId, turn.startedAt) || this.parkNoticeAtCapacity(workerId, wait.id, root, state)) return;
    const now = new Date().toISOString();
    const message = parkNoticeMessage({ workerRunId: workerId, parentRunId: parentId, waitId: wait.id, waits: worker.waits ?? [],
      ...(turn.text === undefined ? {} : { lastText: turn.text }), now, redact: text => this.context.store.redactText(text) });
    const input = { id: message.id, source: 'agent' as const, parentRunId: parentId, text: message.text, createdAt: now,
      conversation: { senderRunId: workerId, recipientRunId: parentId, kind: 'progress' as const } };
    if (!commitNewMessage(this.context.store, parentId, { ...state, messages: [...state.messages, message] }, { recipientRunId: parentId, input }, () => parkNoticeIdInUse(this.context.store, workerId, wait.id))) return;
    projectConversationEvents(this.context.store, this.context.store.getRun(parentId)!);
    this.host.deliverConversationInput(parentId);
  }

  /** A worker parked before finishing: waiting, not stopping or complete, with no pending question
   *  and no queued input. */
  parkedBeforeFinishing(worker: RunRecord): boolean {
    // A question goes to the parent through `routeWorkerQuestion`; a prose gate does not, so it gets a notice.
    // Queued input wakes the worker, so the turn that takes it decides at its own park.
    return worker.status === 'waiting' && !worker.stopping && !this.context.store.transcriptFacts(worker.id).pendingAsk &&
      !this.host.active(worker.id)?.pendingHumanAsk && this.context.store.readWorkerExecution(worker.id)?.phase !== 'complete' &&
      !this.host.hasQueuedAgentInputs(worker.id);
  }

  /** The ledger and the parent's inbox keep room as `service.send` counts it, beside open
   *  questions' replies. When either is full, the worker's log says so once per wait. */
  parkNoticeAtCapacity(workerId: string, waitId: string, root: RunRecord, state: ConversationState): boolean {
    if (state.messages.length + reservedReplies(state) < 1024 && inboxSlotsUsed(root) < 32) return false;
    const projectionId = `park-notice-skipped:${waitId}`;
    if (!this.context.store.hasProjection(workerId, projectionId)) {
      this.context.store.appendEvent(workerId, { type: 'note', tone: 'warning', projectionId, message: 'Parked, but the parent conversation is at capacity: no park notice was sent.' });
    }
    return true;
  }

  /** Recovery's pass over family members: a question (#505) or a park notice
   *  (hearsay-tools/cezarion#1327) that a crash caught before or after its commit to the parent
   *  still reaches it. The worker waits settle between the two, so a notice selects only a wait
   *  that is still open. */
  recoverWorkerMessages(families: readonly RunRecord[], familyRootId: string | undefined): void {
    for (const run of families) if (run.delegation?.role === 'worker') this.host.routeWorkerQuestion(run.id);
    this.host.reconcileWorkerWaits(familyRootId);
    for (const run of families) this.host.noticeParkedWorker(run.id);
  }

  /** `noticeParkedWorker` for every worker a family's root owns. */
  noticeParkedWorkers(rootId: string): void {
    for (const child of this.context.store.listWorkersOf(rootId)) this.host.noticeParkedWorker(child.id);
  }

  /** A human answering a worker question its parent handed back (#505): the reviewing parent
   * can no longer answer it, so it must not also block the human. */
  answersFallenBackAsk(runId: string, opts: { text?: string | undefined; images?: PastedContent[] | undefined }, deferred: boolean): boolean {
    if (deferred || !(opts.text?.trim() || opts.images?.length)) return false;
    return !!this.context.store.transcriptFacts(runId).pendingAsk?.fallback;
  }

  /** The worker's pending ask when it went to the parent and has not fallen back to a human. */
  routedAsk(runId: string): { askSeq: number; message: ConversationMessage } | undefined {
    const run = this.context.store.getRun(runId);
    if (run?.delegation?.role !== 'worker') return undefined;
    // Indexed at append time (#880): the reconcile and every message to a worker ask this.
    const ask = this.context.store.transcriptFacts(runId).pendingAsk;
    if (!ask || ask.fallback || ask.routedMessageId === undefined) return undefined;
    const root = this.context.store.getRun(run.delegation.parentRunId);
    const message = root?.delegation?.role === 'root'
      ? root.delegation.conversation?.messages.find(entry => entry.id === ask.routedMessageId) : undefined;
    return message ? { askSeq: ask.seq, message } : undefined;
  }

  /** The one reader of what answers a worker's pending question (hearsay-tools/cezarion#2410):
   *  waking, delivering, reopening and recording an answer all read it here. */
  pendingAnswer(runId: string): QuestionAnswer | undefined {
    const routed = this.routedAsk(runId);
    const input = routed && this.context.store.getRun(runId)?.agentInputs?.find(entry => !entry.deliveredAt && answersQuestion(routed.message, entry));
    return routed && input ? { askSeq: routed.askSeq, input, source: 'parent' } : undefined;
  }

  /** Who sent `input` as the answer to the worker's pending question; undefined when it is no answer. */
  answerSource(runId: string, input: AgentInput): QuestionAnswerSource | undefined {
    const routed = this.routedAsk(runId);
    return routed && answersQuestion(routed.message, input) ? 'parent' : undefined;
  }

  /** A routed question settled without a reply (its worker stopped, a deadline, fallback) can
   * never be answered by the parent any more: hand it to the human on the worker (#505). */
  retireSettledQuestions(parentId: string): void {
    const root = this.context.store.getRun(parentId);
    const conversation = root?.delegation?.role === 'root' ? root.delegation.conversation : undefined;
    if (!conversation) return;
    for (const message of conversation.messages) {
      const outcome = message.question && conversation.outcomes.find(entry => entry.requestId === message.id);
      // A reply still waiting for a live worker answers it; one a stopped worker never took does not.
      const worker = this.context.store.getRun(message.senderRunId);
      const live = !!worker && ['queued', 'running', 'waiting'].includes(worker.status) && !worker.stopping;
      if (!outcome || (outcome.status === 'replied' && live)) continue;
      const routed = this.routedAsk(message.senderRunId);
      if (routed?.message.id === message.id) {
        this.context.store.appendEvent(message.senderRunId, { type: 'worker-question-fallback', askSeq: routed.askSeq, reason: outcome.status === 'human-fallback' ? `parent-${root!.status}` : outcome.status === 'replied' ? 'worker-stopped' : `question-${outcome.status}` });
      }
    }
  }

  /** Routed questions this parent has not answered yet, by asking worker. */
  unansweredQuestions(parentId: string): { workerId: string; messageId: string }[] {
    return this.context.store.listWorkersOf(parentId).flatMap(run => {
      const routed = this.routedAsk(run.id);
      const root = this.context.store.getRun(parentId);
      const answered = root?.delegation?.role === 'root' && root.delegation.conversation?.outcomes.some(outcome => outcome.requestId === routed?.message.id);
      return routed && !answered ? [{ workerId: run.id, messageId: routed.message.id }] : [];
    });
  }

  /** The parent can no longer answer: its workers' routed questions go back to the human
   * (#505). The outcome lands first, so a crash before the worker's event repeats this. */
  fallbackRoutedQuestions(parentId: string, reason: string): void {
    const parent = this.context.store.getRun(parentId);
    if (parent?.delegation?.role !== 'root') return;
    const state = parent.delegation.conversation ?? { messages: [], outcomes: [] };
    const routed = this.context.store.listWorkersOf(parentId).flatMap(run => {
      const ask = this.routedAsk(run.id);
      // An accepted reply still on its way to a live worker answers it; no human card beside it.
      const replied = ask && state.outcomes.some(outcome => outcome.requestId === ask.message.id && outcome.status === 'replied');
      return ask && !(replied && ['queued', 'running', 'waiting'].includes(run.status) && !run.stopping) ? [{ workerId: run.id, ...ask }] : [];
    });
    if (!routed.length) return;
    const observedAt = new Date().toISOString();
    const missing = routed.filter(entry => !state.outcomes.some(outcome => outcome.requestId === entry.message.id));
    if (missing.length) {
      this.context.store.commitConversation(parentId, { ...state, outcomes: [...state.outcomes,
        ...missing.map(entry => ({ requestId: entry.message.id, status: 'human-fallback' as const, observedAt }))] });
      projectConversationEvents(this.context.store, this.context.store.getRun(parentId)!);
    }
    for (const entry of routed) this.context.store.appendEvent(entry.workerId, { type: 'worker-question-fallback', askSeq: entry.askSeq, reason });
  }

  /** The parent can still read and answer a routed question; answering needs its steer grant. */
  parentCanReceive(parent: RunRecord): boolean {
    return parent.delegation?.role === 'root' && parent.delegation.permissions.includes('steer') && this.parentTakesMessages(parent);
  }

  /** The parent can still read a message from its worker. */
  parentTakesMessages(parent: RunRecord): boolean {
    return parent.delegation?.role === 'root' && ['queued', 'running', 'waiting'].includes(parent.status) && !parent.stopping &&
      !rootFinishRequested(this.context.store, parent.id) && !historyDeletionPending(this.context.store, parent.id);
  }

  /**
   * A worker that ended a second turn with no wait or done after its no-wait nudge
   * (hearsay-tools/cezarion#1301): Cezar's `no-wait` human wait carries one open question, raised
   * as `ask.requested` so `routeWorkerQuestion` takes it to the parent as a request. The parent's
   * reply resumes the worker through the answer seam, charged to the worker's budget; a parent that
   * cannot receive leaves it with the human (`worker-question-fallback`). A full wait list opens
   * none and the worker parks as before.
   */
  askParentForWorker(runId: string, state: ActiveRun, stepId: string | undefined): void {
    const questions = [{ header: WORKER_FALLBACK_HEADER, question: WORKER_FALLBACK_QUESTION(runId) }];
    this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: WORKER_FALLBACK_NOTE });
    const wait = this.host.openHumanAlias(runId, state, 'no-wait', { questions });
    if (wait && wait.askSeq === undefined && pendingHumanAskSeq(this.context.store, runId) === undefined) {
      this.context.store.appendEvent(runId, { type: 'ask.requested', requestId: randomUUID(), questions, ...(stepId ? { stepId } : {}) });
      this.host.prepareHumanAsk(state);
      this.host.markHumanWaitSurfaced(runId, wait, { questions });
      this.host.routeWorkerQuestion(runId);
    }
  }

  /** The worker's pending question is the one `askParentForWorker` raised. */
  isWorkerFallbackAsk(runId: string, askSeq: number): boolean {
    const ask = this.context.store.transcriptFacts(runId).pendingAsk;
    const questions = ask?.seq === askSeq ? askRequestOf({ questions: ask.questions })?.questions : undefined;
    return questions?.length === 1 && questions[0]!.header === WORKER_FALLBACK_HEADER && questions[0]!.question === WORKER_FALLBACK_QUESTION(runId);
  }

  /** The worker's pending question is Cezar's fallback question. */
  pendingWorkerFallback(runId: string): boolean {
    const ask = this.context.store.transcriptFacts(runId).pendingAsk;
    return this.context.store.getRun(runId)?.delegation?.role === 'worker' && !!ask && this.isWorkerFallbackAsk(runId, ask.seq);
  }

  /** The parent's reply to a worker's fallback question resumed it: one automatic wake, so a
   *  parent and worker cannot go back and forth past the budget (hearsay-tools/cezarion#1301). */
  chargeWorkerFallbackReply(runId: string, beforeHumanReset?: HumanAnswerBudget): void {
    const spent = beforeHumanReset === undefined ? this.host.chargeAutomaticWake(runId) : beforeHumanReset.spent + 1;
    if (beforeHumanReset) beforeHumanReset.spent = spent;
    this.context.store.appendEvent(runId, { type: 'note', message: `${WORKER_FALLBACK_REPLY_NOTE} (${spent}/${this.maxAutoContinues})` });
  }

  /**
   * Cezar's fallback question is Cezar's, not the worker's (hearsay-tools/cezarion#1301): what the
   * plain park it replaced let through still goes through. A parent's input, a Continue or a closed
   * session supersedes it: its routed request gets an outcome, so it no longer holds the parent's
   * done, the parent's unread copy is retired, and only then does the question close unanswered
   * (`human-ask-closed`, `superseded`) and Cezar's wait go. Each step is idempotent and the close
   * comes last, so a failed write leaves the question pending and the next supersession, or
   * recovery, finishes it. A question the worker asked itself is never superseded. True when it
   * closed.
   */
  supersedeWorkerFallback(runId: string): boolean {
    const run = this.context.store.getRun(runId);
    const ask = this.context.store.transcriptFacts(runId).pendingAsk;
    if (run?.delegation?.role !== 'worker' || !ask || !this.isWorkerFallbackAsk(runId, ask.seq)) return false;
    const root = this.context.store.getRun(run.delegation.parentRunId);
    const requestId = ask.routedMessageId;
    if (root?.delegation?.role === 'root' && requestId !== undefined) {
      try {
        const conversation = root.delegation.conversation;
        if (conversation?.messages.some(message => message.id === requestId) && !conversation.outcomes.some(outcome => outcome.requestId === requestId)) {
          this.context.store.commitConversation(root.id, { ...conversation, outcomes: [...conversation.outcomes,
            { requestId, status: 'completed-without-reply', observedAt: new Date().toISOString() }] });
          projectConversationEvents(this.context.store, this.context.store.getRun(root.id)!);
        }
        this.host.retireUnreadParentQuestion(root.id, requestId);
      } catch (error) {
        console.warn(`[cez] fallback question not superseded: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    this.context.store.appendEvent(runId, { type: 'human-ask-closed', askSeq: ask.seq, reason: 'superseded' });
    this.host.withdrawCezarHumanWaits(runId);
    this.host.updatePendingHumanAsk(runId, hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id)));
    return true;
  }

  /** The parent no longer owes an answer to a superseded fallback question: one it has not read is
   *  retired, so neither a wake nor a restart's replay of unread input delivers it. One a provider
   *  or an inbox read already holds is left to them. */
  retireUnreadParentQuestion(parentId: string, requestId: string): void {
    const input = this.context.store.getRun(parentId)?.agentInputs?.find(entry => entry.id === requestId);
    if (!input || input.consumedAt || hasLiveInboxClaim(input) || this.host.providerOwnsInboxInput(parentId, requestId)) return;
    this.host.deleteUnreadInput(parentId, requestId);
    if (input.deliveredAt) this.context.store.commitAgentInputsUnconfirmed(parentId, [requestId]);
    else this.context.store.commitAgentInputs(parentId, (this.context.store.getRun(parentId)?.agentInputs ?? []).filter(entry => entry.id !== requestId));
  }
}
