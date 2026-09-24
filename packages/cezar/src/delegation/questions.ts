import { createHash } from 'node:crypto';
import type { AgentInput, AskRequest, ConversationMessage } from '@open-mercato/cezar-contract';

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

/** What the parent reads: the questions, their options, and the exact reply command. */
export function formatQuestionText(workerRunId: string, messageId: string, request: AskRequest): string {
  const lines = [`Your worker ${workerRunId} is waiting for your answer:`];
  request.questions.forEach((question, index) => {
    lines.push(`${index + 1}. [${question.header}] ${question.question}${question.multiSelect ? ' (choose one or more)' : ''}`);
    for (const option of question.options) lines.push(`   - ${option.label}${option.description ? `: ${option.description}` : ''}`);
  });
  const format = request.questions.map(question => `${question.header}: <option>`).join('\n');
  lines.push(`Answer with one line per question, exactly as the worker reads a human answer:\n${format}`);
  lines.push(`Send it with: worker reply ${workerRunId} '<answer>' --id <new-message-UUID> --request-id ${messageId}`);
  lines.push('If you cannot decide, ask the human with your own question, then reply with their answer.');
  return lines.join('\n');
}

/** Only a reply naming this question answers it; progress and follow-ups never do. */
export function answersQuestion(message: ConversationMessage, input: AgentInput): boolean {
  return !!message.question && input.conversation?.kind === 'reply' && input.conversation.requestId === message.id;
}

/** A UUID-shaped (version 4 layout) identifier derived from a stable key. */
function uuidFrom(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
