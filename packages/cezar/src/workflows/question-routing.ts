import type { ConversationState } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { reservedReplies } from '../delegation/questions.ts';
import { inboxSlotsUsed } from '../delegation/conversations.ts';

/** Where a worker's question goes (hearsay-tools/cezarion#2410). It has one addressee, its parent:
 *  the conversation that admits it, a close when either end has stopped, or the reason a live parent
 *  cannot take it, which Cezar answers. No case hands it to a human. */
export type WorkerQuestionRouting =
  | { state: ConversationState }
  | { close: 'worker-stopped' | 'parent-stopped' }
  | { undeliverable: string };

const LIVE = ['queued', 'running', 'waiting'];

export function workerQuestionRouting(worker: RunRecord, root: RunRecord | undefined, reads: {
  unreadable(id: string): boolean; parentEnding(root: RunRecord): boolean;
}): WorkerQuestionRouting {
  // Recovery can find a question that never left a worker which has since stopped.
  if (!LIVE.includes(worker.status) || worker.stopping) return { close: 'worker-stopped' };
  const parentId = worker.delegation?.role === 'worker' ? worker.delegation.parentRunId : undefined;
  if (root?.delegation?.role !== 'root') {
    return parentId !== undefined && reads.unreadable(parentId) ? { undeliverable: 'the parent record cannot be read' } : { close: 'parent-stopped' };
  }
  if (!LIVE.includes(root.status) || root.stopping || reads.parentEnding(root)) return { close: 'parent-stopped' };
  // Answering needs the steer grant (`service.send` refuses a reply without it): a root that may not
  // message its workers cannot take a question either. Provisioned roots hold every grant.
  if (!root.delegation.permissions.includes('steer')) return { undeliverable: 'the parent may not message its workers' };
  const state = root.delegation.conversation ?? { messages: [], outcomes: [] };
  // Room in the ledger for the question AND its reply, beside the replies other open requests
  // reserve. The reply itself is always admitted to this worker's inbox (service.send).
  // The parent's inbox slots count those its open peer requests hold for their replies.
  if (state.messages.length + reservedReplies(state) + 2 > 1024 || inboxSlotsUsed(root) >= 32 ||
    state.messages.filter(m => m.kind === 'request' && m.state === 'accepted' && !state.outcomes.some(o => o.requestId === m.id)).length >= 32) {
    return { undeliverable: 'the parent conversation is at capacity' };
  }
  return { state };
}
