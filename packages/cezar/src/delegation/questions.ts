import { createHash } from 'node:crypto';
import type { AgentInput, AskRequest, ConversationMessage, ConversationState } from '@open-mercato/cezar-contract';

/** A worker's question travels to its owning parent as a conversation request (#505). Its ID
 * derives from the worker and the ask's event seq, so routing it again after a restart finds
 * the same message instead of asking twice. */
export function questionMessage(input: {
  workerRunId: string; parentRunId: string; askSeq: number; request: AskRequest; now: string;
}): ConversationMessage {
  const id = uuidFrom(`worker-question:${input.workerRunId}:${input.askSeq}`);
  const text = formatQuestionText(input.workerRunId, id, input.request);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ senderRunId: input.workerRunId, recipientRunId: input.parentRunId, question: input.request }))
    .digest('hex');
  // No deadline: a question settles when it is answered or falls back to a human.
  return { id, senderRunId: input.workerRunId, recipientRunId: input.parentRunId, kind: 'request', text,
    createdAt: input.now, requestHash, state: 'accepted', question: input.request };
}

/** What the parent reads: the context, the questions, their options, and the exact reply command. */
export function formatQuestionText(workerRunId: string, messageId: string, request: AskRequest): string {
  const lines = [`Your worker ${workerRunId} is waiting for your answer:`];
  // hearsay-tools/cezarion#1458: the draft or findings the question depends on come first.
  if (request.context !== undefined) lines.push('Context:', request.context, '');
  request.questions.forEach((question, index) => {
    // hearsay-tools/cezarion#1234: a question without options is open; multiSelect needs options.
    const hint = !question.options ? ' (open question: answer in your own words)' : question.multiSelect ? ' (choose one or more)' : '';
    lines.push(`${index + 1}. [${question.header}] ${question.question}${hint}`);
    for (const option of question.options ?? []) lines.push(`   - ${option.label}${option.description ? `: ${option.description}` : ''}`);
  });
  const format = request.questions.map(question => `${question.header}: ${question.options ? '<option>' : '<your answer>'}`).join('\n');
  lines.push(`Answer with one line per question, exactly as the worker reads a human answer:\n${format}`);
  lines.push(`Send it with: message reply ${workerRunId} '<answer>' --id <new-message-UUID> --request-id ${messageId}`);
  lines.push('If you cannot decide, ask the human with your own question, then reply with their answer.');
  return lines.join('\n');
}

/** Only a reply naming this question answers it; progress and follow-ups never do. */
export function answersQuestion(message: ConversationMessage, input: AgentInput): boolean {
  return !!message.question && input.conversation?.kind === 'reply' && input.conversation.requestId === message.id;
}

/** Routed questions still awaiting an answer. Each one holds a reserved conversation slot, and
 * a slot in its worker's inbox, for its reply: otherwise ordinary traffic could fill both and
 * leave a question nobody can answer (#505). */
export function openQuestions(state: ConversationState): ConversationMessage[] {
  return state.messages.filter(message => message.question && !state.outcomes.some(outcome => outcome.requestId === message.id));
}

/** Ledger room the open requests hold for their replies: every accepted request with no outcome,
 *  a worker's question among them (hearsay-tools/cezarion#1990 review). A reply spends its own. */
export function reservedReplies(state: ConversationState): number {
  return state.messages.filter(message => message.kind === 'request' && message.state === 'accepted' && !state.outcomes.some(outcome => outcome.requestId === message.id)).length;
}

/** A UUID-shaped (version 4 layout) identifier derived from a stable key. */
export function uuidFrom(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
