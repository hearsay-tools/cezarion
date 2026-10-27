import type { RunRecord } from '../runs/store.ts';
import { openQuestions } from '../delegation/questions.ts';

/** The first reason a not-yet-committed question cannot leave its worker. */
export function workerQuestionFallback(worker: RunRecord, root: RunRecord | undefined, parentCanReceive: (root: RunRecord) => boolean): string | undefined {
  // Recovery can find a question that never left a worker which has since stopped.
  if (!['queued', 'running', 'waiting'].includes(worker.status)) return 'worker-stopped';
  if (root?.delegation?.role !== 'root' || !parentCanReceive(root)) return 'the parent can no longer receive messages';
  const state = root.delegation.conversation ?? { messages: [], outcomes: [] };
  // Room in the ledger for the question AND its reply, beside the replies other open questions
  // reserve. The reply itself is always admitted to this worker's inbox (service.send).
  if (state.messages.length + openQuestions(state).length + 2 > 1024 || (root.agentInputs ?? []).filter(input => !input.deliveredAt).length >= 32 ||
    state.messages.filter(m => m.kind === 'request' && m.state === 'accepted' && !state.outcomes.some(o => o.requestId === m.id)).length >= 32) {
    return 'the parent conversation is at capacity';
  }
  return undefined;
}
