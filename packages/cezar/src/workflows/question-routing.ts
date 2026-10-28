import type { ConversationState } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { reservedReplies } from '../delegation/questions.ts';
import { inboxSlotsUsed } from '../delegation/conversations.ts';

/** The first fallback reason, or the conversation that admitted the worker question. */
export function workerQuestionFallback(worker: RunRecord, root: RunRecord | undefined, parentCanReceive: (root: RunRecord) => boolean): { reason: string } | { state: ConversationState } {
  // Recovery can find a question that never left a worker which has since stopped.
  if (!['queued', 'running', 'waiting'].includes(worker.status)) return { reason: 'worker-stopped' };
  if (root?.delegation?.role !== 'root' || !parentCanReceive(root)) return { reason: 'the parent can no longer receive messages' };
  const state = root.delegation.conversation ?? { messages: [], outcomes: [] };
  // Room in the ledger for the question AND its reply, beside the replies other open requests
  // reserve. The reply itself is always admitted to this worker's inbox (service.send).
  // The parent's inbox slots count those its open peer requests hold for their replies.
  if (state.messages.length + reservedReplies(state) + 2 > 1024 || inboxSlotsUsed(root) >= 32 ||
    state.messages.filter(m => m.kind === 'request' && m.state === 'accepted' && !state.outcomes.some(o => o.requestId === m.id)).length >= 32) {
    return { reason: 'the parent conversation is at capacity' };
  }
  return { state };
}
