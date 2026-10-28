import type { AgentInput, ConversationMessage, ConversationSendRequest, ConversationState, RequestOutcome } from '@open-mercato/cezar-contract';
import { MAX_CONVERSATION_REQUEST_SECONDS } from '@open-mercato/cezar-contract/conversations';
import type { RunRecord } from '../runs/store.ts';
import type { DelegationProject } from './service.ts';
import { finishing, notDeliveredInstruction } from './conversations.ts';
import { DelegationPolicyError } from './policy.ts';

export type ConversationPair = { project: DelegationProject; sender: RunRecord; recipient: RunRecord } &
  ({ relationship: 'peer' } | { relationship: 'family'; root: RunRecord; worker: RunRecord });

export function sendRequestContext(state: ConversationState, request: ConversationSendRequest, sender: RunRecord, recipient: RunRecord) {
  const original = request.requestId ? state.messages.find(message => message.id === request.requestId && message.kind === 'request' && message.state === 'accepted') : undefined;
  if (request.requestId && (!original || (request.kind === 'reply'
    ? original.recipientRunId !== sender.id || original.senderRunId !== recipient.id
    : original.senderRunId !== sender.id || original.recipientRunId !== recipient.id))) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
  const settled = state.outcomes.find(outcome => outcome.requestId === request.requestId);
  // A worker's question has exactly one answer (hearsay-tools/cezarion#505): a second reply is refused, not recorded late.
  if (request.kind === 'reply' && settled && original?.question) throw new DelegationPolicyError('incompatible_state', 'This question was already answered');
  return { original, settled };
}
export function sendAdmission(pair: ConversationPair, root: RunRecord, request: ConversationSendRequest) {
  const { recipient, relationship } = pair;
  const peer = relationship === 'peer';
  const destroyed = recipient.delegation?.role === 'worker' && recipient.delegation.destroy?.phase === 'complete';
  // A peer whose Finish is pending takes nothing more: Finish would settle it unread (spec § 5).
  const resumable = !['queued', 'running', 'waiting'].includes(recipient.status) || !!recipient.stopping || (recipient.delegation?.role === 'worker' && !!recipient.delegation.destroy) || (peer && finishing(recipient));
  const resume = !!request.resume && resumable;
  // The extended bound belongs to a new continuation, not merely the flag.
  // Exact retries have already returned above, even if that continuation is now active.
  if (request.timeoutSeconds > MAX_CONVERSATION_REQUEST_SECONDS && !resume) {
    throw new DelegationPolicyError('incompatible_state', 'Extended request deadlines require resuming a settled worker; active workers accept at most 1800 seconds');
  }
  assertSendResume(recipient, resume, destroyed);
  const instruction = destroyed ? 'Not delivered: this worker was destroyed. Spawn a new worker for further work.'
    : resumable && !resume ? notDeliveredInstruction(pair, root) : undefined;
  return { destroyed, resumable, resume, instruction };
}
function assertSendResume(recipient: RunRecord, resume: boolean, destroyed: boolean): void {
  if (resume && (destroyed || recipient.delegation?.role !== 'worker' || recipient.delegation.destroy ||
    recipient.status === 'cancelled' || recipient.stopping)) throw new DelegationPolicyError('incompatible_state',
      `Worker is ${destroyed ? 'destroyed' : 'stopped or being destroyed'}; --resume cannot restart it. Spawn a new worker with the follow-up instruction`);
}
export function sendMessage(pair: ConversationPair, request: ConversationSendRequest, requestHash: string, now: string,
  settled: RequestOutcome | undefined, admission: { destroyed: boolean; resumable: boolean; resume: boolean; instruction: string | undefined }): ConversationMessage {
  const { project, sender, recipient, relationship } = pair;
  const peer = relationship === 'peer';
  const { destroyed, resumable, resume, instruction } = admission;
  const message: ConversationMessage = { id: request.id, senderRunId: sender.id, recipientRunId: recipient.id,
    kind: request.kind, ...(request.requestId ? { requestId: request.requestId } : {}), ...(peer ? { relationship } : {}),
    text: project.store.redactText(request.text), createdAt: now, requestHash,
    ...(request.kind === 'request' && !destroyed && (!resumable || resume) ? { deadline: new Date(Date.parse(now) + request.timeoutSeconds * 1000).toISOString() } : {}),
    ...(resume ? { resumed: true as const } : {}), ...(instruction ? { instruction } : {}),
    state: request.kind === 'reply' && settled ? 'late' : destroyed ? 'destroyed' : resumable && !resume ? 'continuation-required' : 'accepted' };
  return message;
}
export function sendInput(pair: ConversationPair, root: RunRecord, message: ConversationMessage, requestHash: string, now: string): AgentInput {
  const { sender, recipient, relationship } = pair;
  const peer = relationship === 'peer';
  // `parentRunId` keeps its name and holds the ledger owner (spec § 2, Message identity).
  const input = { id: message.id, source: 'agent' as const, parentRunId: root.id, text: message.text, createdAt: now,
    conversation: { senderRunId: sender.id, recipientRunId: recipient.id, kind: message.kind, ...(message.requestId ? { requestId: message.requestId } : {}), ...(peer ? { relationship } : {}) },
    // A peer input outlives its sender's ledger: it keeps the message's identity for the recipient's inbox.
    ...(peer ? { requestHash, ...(message.deadline ? { deadline: message.deadline } : {}) } : {}) };
  return input;
}
