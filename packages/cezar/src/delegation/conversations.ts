import type { ConversationMessage, ConversationState, RequestOutcome } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

/**
 * First durable request settlement wins, with the defined late-reply timeout amendment handled
 * by send. Review is not completion for a worker, which its parent can resume; a peer recipient at
 * review settles `completed-without-reply` at once, because no peer can resume it, and a deleted
 * one settles `deleted` (spec 2026-10-27-task-communication-protocol § 5, § 7). Lookup only the
 * named sender/recipient runs.
 */
export function reconcileConversationState(root: RunRecord, lookup: (id: string) => RunRecord | undefined, now: string, isSettled: (run: RunRecord) => boolean): ConversationState | undefined {
  if (root.delegation?.role !== 'root' || !root.delegation.conversation) return undefined;
  const state = root.delegation.conversation;
  const outcomes = [...state.outcomes];
  for (const request of state.messages) {
    if (request.kind !== 'request' || request.state !== 'accepted' || outcomes.some(outcome => outcome.requestId === request.id)) continue;
    const recipient = lookup(request.recipientRunId);
    const status = request.relationship === 'peer' ? peerRecipientSettlement(recipient, isSettled) : familyRecipientSettlement(root, request, recipient, isSettled);
    const closed = (run: RunRecord | undefined) => run && ['done', 'failed', 'cancelled'].includes(run.status) && isSettled(run);
    const settled = status ?? (closed(root) || closed(lookup(request.senderRunId)) ? 'sender-closed'
      : request.deadline && request.deadline <= now ? 'timed-out' : undefined);
    if (settled) outcomes.push({ requestId: request.id, status: settled, observedAt: now });
  }
  return outcomes.length === state.outcomes.length ? state : { ...state, outcomes };
}

/** A peer recipient settles the request when it is deleted, rests at `review` (no peer can resume
 *  it), or ends `done`, `failed` or `cancelled`. */
function peerRecipientSettlement(recipient: RunRecord | undefined, isSettled: (run: RunRecord) => boolean): RequestOutcome['status'] | undefined {
  if (!recipient) return 'deleted';
  if (!['review', 'done', 'failed', 'cancelled'].includes(recipient.status) || !isSettled(recipient)) return undefined;
  return recipient.status === 'review' || recipient.status === 'done' ? 'completed-without-reply' : recipient.status as 'failed' | 'cancelled';
}

/** A family recipient: a destroyed worker, or a closed one. Review is not completion: its parent can resume it. */
function familyRecipientSettlement(root: RunRecord, request: ConversationMessage, recipient: RunRecord | undefined, isSettled: (run: RunRecord) => boolean): RequestOutcome['status'] | undefined {
  const receipts = root.delegation?.role === 'root' ? root.delegation.receipts : [];
  const deletedRecipient = !recipient && receipts.some(receipt => receipt.workerId === request.recipientRunId && receipt.deletion?.phase === 'complete');
  if (deletedRecipient || (recipient?.delegation?.role === 'worker' && recipient.delegation.destroy?.phase === 'complete')) return 'destroyed';
  if (!recipient || !['done', 'failed', 'cancelled'].includes(recipient.status) || !isSettled(recipient)) return undefined;
  // A worker's question outlives its parent: the human answers it instead (#505).
  if (request.question) return 'human-fallback';
  return recipient.status === 'done' ? 'completed-without-reply' : recipient.status as 'failed' | 'cancelled';
}

/** Repair observation only; replay never inserts agent inputs or starts execution. */
export function projectConversationEvents(store: import('../runs/store.ts').RunStore, root: RunRecord): void {
  if (root.delegation?.role !== 'root' || !root.delegation.conversation) return;
  const state = root.delegation.conversation;
  const outcomes = new Map(state.outcomes.map(outcome => [outcome.requestId, outcome]));
  for (const message of state.messages) {
    for (const runId of [message.senderRunId, message.recipientRunId]) {
      if (!store.getRun(runId)) continue;
      // The run's indexed projection ids (#880): appendEvent keeps them, so no transcript read.
      const ids = { has: (id: string) => store.hasProjection(runId, id) };
      const input = store.getRun(message.recipientRunId)?.agentInputs?.find(input => input.id === message.id);
      const delivery = input?.consumedAt ? 'consumed' : input?.deliveredAt ? 'delivered' : input ? 'queued' : 'not-delivered';
      // A read message was delivered first, even when both landed between two projections;
      // readers that predate `consumed` still see it delivered (#505).
      for (const step of delivery === 'consumed' ? ['delivered', 'consumed'] as const : [delivery]) {
        const projectionId = `conversation-message:${message.id}:${step}`;
        if (ids.has(projectionId)) continue;
        store.appendEvent(runId, { type: 'conversation-message', projectionId, message, delivery: step,
          ...(input?.deliveredAt ? { deliveredAt: input.deliveredAt } : {}),
          ...(step === 'consumed' && input?.consumedAt ? { consumedAt: input.consumedAt } : {}) });
      }
      const outcome = outcomes.get(message.id);
      const outcomeProjectionId = outcome && `request-outcome:${outcome.requestId}${outcome.status === 'replied-late' ? ':replied-late' : ''}`;
      if (outcome && outcomeProjectionId && !ids.has(outcomeProjectionId)) {
        store.appendEvent(runId, { type: 'request-outcome', projectionId: outcomeProjectionId, outcome });
      }
    }
  }
}
