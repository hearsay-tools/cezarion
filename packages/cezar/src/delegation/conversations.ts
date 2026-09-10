import type { ConversationState, RequestOutcome } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

/** First durable settlement wins. Review is readiness, never request completion. */
export function reconcileConversationState(root: RunRecord, runs: readonly RunRecord[], now: string, isSettled: (run: RunRecord) => boolean): ConversationState | undefined {
  if (root.delegation?.role !== 'root' || !root.delegation.conversation) return undefined;
  const state = root.delegation.conversation;
  const outcomes = [...state.outcomes];
  for (const request of state.messages) {
    if (request.kind !== 'request' || request.state !== 'accepted' || outcomes.some(outcome => outcome.requestId === request.id)) continue;
    const sender = runs.find(run => run.id === request.senderRunId);
    const recipient = runs.find(run => run.id === request.recipientRunId);
    const closed = (run: RunRecord | undefined) => run && ['done', 'failed', 'cancelled'].includes(run.status) && isSettled(run);
    let status: RequestOutcome['status'] | undefined;
    const deletedRecipient = !recipient && root.delegation.receipts.some(receipt => receipt.workerId === request.recipientRunId && receipt.deletion?.phase === 'complete');
    if (deletedRecipient || (recipient?.delegation?.role === 'worker' && recipient.delegation.destroy?.phase === 'complete')) status = 'destroyed';
    else if (closed(recipient)) status = recipient!.status === 'done' ? 'completed-without-reply' : recipient!.status as 'failed' | 'cancelled';
    else if (closed(root) || closed(sender)) status = 'sender-closed';
    else if (request.deadline && request.deadline <= now) status = 'timed-out';
    if (status) outcomes.push({ requestId: request.id, status, observedAt: now });
  }
  return outcomes.length === state.outcomes.length ? state : { ...state, outcomes };
}

/** Repair observation only; replay never inserts agent inputs or starts execution. */
export function projectConversationEvents(store: import('../runs/store.ts').RunStore, root: RunRecord): void {
  if (root.delegation?.role !== 'root' || !root.delegation.conversation) return;
  const state = root.delegation.conversation;
  const projections = new Map<string, Set<unknown>>();
  const outcomes = new Map(state.outcomes.map(outcome => [outcome.requestId, outcome]));
  for (const message of state.messages) {
    for (const runId of [message.senderRunId, message.recipientRunId]) {
      if (!store.getRun(runId)) continue;
      let ids = projections.get(runId);
      if (!ids) { ids = new Set(store.readEvents(runId).map(event => event.projectionId)); projections.set(runId, ids); }
      const input = store.getRun(message.recipientRunId)?.agentInputs?.find(input => input.id === message.id);
      const delivery = input?.deliveredAt ? 'delivered' : input ? 'queued' : 'not-delivered';
      const projectionId = `conversation-message:${message.id}:${delivery}`;
      if (!ids.has(projectionId)) { store.appendEvent(runId, { type: 'conversation-message', projectionId, message, delivery }); ids.add(projectionId); }
      const outcome = outcomes.get(message.id);
      if (outcome && !ids.has(`request-outcome:${outcome.requestId}`)) {
        store.appendEvent(runId, { type: 'request-outcome', projectionId: `request-outcome:${outcome.requestId}`, outcome });
        ids.add(`request-outcome:${outcome.requestId}`);
      }
    }
  }
}
