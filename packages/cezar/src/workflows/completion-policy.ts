import type { CezarDoneAnswer, ConversationMessage } from '@open-mercato/cezar-contract';
import { WAIT_MESSAGE_MAX } from '@open-mercato/cezar-contract/waits';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { rootsAwaitingPeer } from '../delegation/conversations.ts';
import type { ActiveRun } from './active-run.ts';

type DoneRefusal = Extract<CezarDoneAnswer, { ok: false }>;
export type CompletionRefusal = {
  code: Extract<DoneRefusal['code'], 'worker_questions' | 'workers_outstanding' | 'workers_uncollected' | 'requests_outstanding' | 'requests_unanswered'>;
  message: string; workers: NonNullable<DoneRefusal['workers']>; liveWorkerIds: string[]; requestIds?: string[];
};

/** Read-only completion policy. The manager carries out nudges, waits and settlement. */
export function rootCompletionRefusal({ questions, blockers, requests, incomingRefused }: {
  questions: { workerId: string; messageId: string }[];
  blockers: { workerId: string; reason: string }[];
  requests: ReturnType<typeof openCompletionRequests>;
  incomingRefused: boolean;
}): CompletionRefusal | undefined {
  // Every command spelled out while it fits the contract's bound, else the general form:
  // `workers` still lists each worker.
  const fit = (full: string, general: string) => full.length <= WAIT_MESSAGE_MAX ? full : general;
  if (questions.length) {
    return { code: 'worker_questions', message: fit(`Your workers asked questions you have not answered. Answer each (${questions.map(q => `\`message reply ${q.workerId} '<answer>' --id <new-UUID> --request-id ${q.messageId}\``).join(', ')}), then call cezar_done again.`,
      `Your workers asked ${questions.length} questions you have not answered; \`workers\` lists the workers and \`message inbox\` shows each question. Answer each (\`message reply <worker-id> '<answer>' --id <new-UUID> --request-id <question-id>\`), then call cezar_done again.`),
    workers: questions.map(q => ({ worker_id: q.workerId, reason: 'question' })), liveWorkerIds: [] };
  }
  const live = blockers.filter(b => b.reason === 'outstanding').map(b => b.workerId);
  if (live.length) {
    return { code: 'workers_outstanding', message: fit(`Workers are still live: ${live.join(', ')}. Wait for them (\`worker wait ${live.join(' ')}\`, then end your turn) or stop them (${live.map(id => `\`worker stop ${id}\``).join(', ')}), collect their results, then call cezar_done again.`,
      `${live.length} workers are still live; \`workers\` lists them. Wait for them (\`worker wait <worker-id>...\`, then end your turn) or stop them (\`worker stop <worker-id>\`), collect their results, then call cezar_done again.`),
    workers: live.map(worker_id => ({ worker_id, reason: 'outstanding' })), liveWorkerIds: live };
  }
  const uncollected = blockers.filter(b => b.reason === 'uncollected').map(b => b.workerId);
  if (uncollected.length) {
    return { code: 'workers_uncollected', message: fit(`Settled worker results are not collected yet. Collect each (${uncollected.map(id => `\`worker collect ${id}\``).join(', ')}), then call cezar_done again.`,
      `${uncollected.length} settled worker results are not collected yet; \`workers\` lists them. Collect each (\`worker collect <worker-id>\`), then call cezar_done again.`),
    workers: uncollected.map(worker_id => ({ worker_id, reason: 'uncollected' })), liveWorkerIds: [] };
  }
  if (requests.sent.length) return {
    code: 'requests_outstanding', message: sentRequestInstructions(requests.sent), workers: [], liveWorkerIds: [], requestIds: requests.sent.map(request => request.id),
  };
  if (requests.incoming.length && !incomingRefused) return {
    code: 'requests_unanswered', message: incomingRequestInstructions(requests.incoming), workers: [], liveWorkerIds: [],
  };
  return undefined;
}

/** Tool answers and delivered nudges count once in the same completion cycle. */
export function recordRequestRefusal(state: ActiveRun, refusal: CompletionRefusal, tool = false): void {
  if (refusal.code === 'requests_unanswered') state.incomingRequestRefused = true;
  if (refusal.code !== 'requests_outstanding') return;
  if (tool && state.sentRequestRefused && state.session) state.doneRequested = { session: state.session };
  state.sentRequestRefused = true;
}

/** Only named ledgers are read; incoming peer requests live in their sender's ledger. */
export function openCompletionRequests(store: RunStore, runId: string) {
  if (store.getRun(runId)?.delegation?.role !== 'root') return { sent: [], incoming: [] };
  const requests = [runId, ...rootsAwaitingPeer(store, runId)].flatMap(id => {
    const root = store.getRun(id);
    const conversation = root?.delegation?.role === 'root' ? root.delegation.conversation : undefined;
    return conversation?.messages.filter(message => message.kind === 'request' && message.state === 'accepted' &&
      !conversation.outcomes.some(outcome => outcome.requestId === message.id)) ?? [];
  });
  return { sent: requests.filter(request => request.senderRunId === runId), incoming: requests.filter(request => request.recipientRunId === runId) };
}

export function sentRequestInstructions(requests: ConversationMessage[]): string {
  return `Requests are still open: ${requests.map(request => `${request.id} to ${request.recipientRunId} (deadline ${request.deadline})`).join(', ')}. Wait with \`cez message wait --request <UUID>\`, then end your turn, or cancel a request you no longer need with \`cez message cancel-request <UUID>\`.`;
}

/** As with worker refusals, bound the text while the gate retains every obligation. */
export function incomingRequestInstructions(requests: ConversationMessage[]): string {
  const shown = requests.slice(0, 40);
  const omitted = requests.length - shown.length;
  return `Requests are unanswered: ${shown.map(request => `${request.id} from ${request.senderRunId}`).join(', ')}. ${omitted ? `${omitted} more incoming requests omitted. ` : ''}Reply to each (a short refusal counts), or call cezar_done again to finish without replying. Read history with \`cez message conversation <sender>\`.`;
}

/** Terminal publication retires the accepted Finish intent in the same run write. */
export function settledRootFinishPatch(store: RunStore, runId: string): Partial<Pick<RunRecord, 'delegation'>> {
  const root = store.getRun(runId)?.delegation;
  if (root?.role !== 'root' || !root.finishRequestedAt) return {};
  const { finishRequestedAt: _intent, ...delegation } = root;
  return { delegation };
}

