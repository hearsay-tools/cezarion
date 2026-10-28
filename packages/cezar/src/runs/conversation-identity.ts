import type { AgentInput, RunRecord } from '@open-mercato/cezar-contract';

/** The delivery steps a `conversation-message:<id>:<step>` projection names (`projectConversationEvents`). */
const CONVERSATION_DELIVERY_STEPS = ['queued', 'delivered', 'consumed', 'not-delivered'] as const;

/** A newly accepted conversation message: its ID, and the two runs it reaches. */
export type ConversationIdentity = { id: string; senderRunId: string; recipientRunId: string };

/** `commitConversation` refused a message whose ID is already in use where it would land. */
export class ConversationIdInUseError extends Error {
  constructor() { super('Message ID already in use; use a new message ID'); this.name = 'ConversationIdInUseError'; }
}

/**
 * A message ID is unique in its ledger only, but the recipient's input, its delivery checkpoints and
 * the `conversation-message:<id>:<step>` projections use it with no ledger in it. So a new ID must be
 * unused in the ledger that will hold it, in the recipient's inputs and in either run's projections
 * (spec 2026-10-27-task-communication-protocol § Message identity). The store runs this inside the
 * synchronous write that stores the message, so of two senders on two ledgers only the first passes.
 */
export function assertConversationIdFree(root: RunRecord, subject: ConversationIdentity | AgentInput | undefined, peek: (id: string) => RunRecord | undefined,
  hasProjection: (runId: string, projectionId: string) => boolean): void {
  // Every new message is checked: a delivered input names its own message (hearsay-tools/cezarion#1990 review).
  // Such a write is Cezar's own (a routed question, a park notice), retried under its deterministic ID
  // after a crash that kept its projections but lost the ledger write. So only a projection no Cezar
  // writer makes counts for it: `not-delivered`. A peer message that reached the recipient has an input.
  const replay = !!subject && 'source' in subject;
  const message = subject && 'source' in subject ? subject.conversation && { id: subject.id, ...subject.conversation } : subject;
  if (!message) return;
  const inLedger = root.delegation?.role === 'root' && !!root.delegation.conversation?.messages.some(entry => entry.id === message.id);
  const queued = !!peek(message.recipientRunId)?.agentInputs?.some(input => input.id === message.id);
  const projections = replay ? [`conversation-message:${message.id}:not-delivered`]
    : [...CONVERSATION_DELIVERY_STEPS.map(step => `conversation-message:${message.id}:${step}`), `request-outcome:${message.id}`, `request-outcome:${message.id}:replied-late`];
  const projected = [message.senderRunId, message.recipientRunId].some(runId => peek(runId) !== undefined && projections.some(id => hasProjection(runId, id)));
  if (inLedger || queued || projected) throw new ConversationIdInUseError();
}
