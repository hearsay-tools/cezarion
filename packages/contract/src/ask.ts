/** Structured human questions share one validation and acknowledgement policy
 * across runner delivery, compact history, and current cockpit attention. */
import { z } from 'zod';
import { humanInputDeliveredEventSchema, type RunEvent } from './events.ts';

export { askOptionSchema, askQuestionSchema, askRequestSchema } from './ask-schema.ts';
export type { AskOption, AskQuestion, AskRequest } from './ask-schema.ts';
import { askRequestSchema } from './ask-schema.ts';

/** Only a matching successful human delivery retires the latest valid ask.
 * Attempt bubbles, agent input and lifecycle events are not acknowledgements. */
export function advancePendingHumanAsk<T extends RunEvent>(pending: T | undefined, event: T): T | undefined {
  if (event.type === 'ask.requested' && typeof event.requestId === 'string' &&
    askRequestSchema.safeParse({ questions: event.questions }).success) return event;
  if (event.type === 'human-input-delivered') {
    const delivered = humanInputDeliveredEventSchema.safeParse(event);
    if (delivered.success && delivered.data.askSeq === pending?.seq) return undefined;
  }
  return pending;
}

export function pendingHumanAsk<T extends RunEvent>(events: Iterable<T>): T | undefined {
  let pending: T | undefined;
  for (const event of events) pending = advancePendingHumanAsk(pending, event);
  return pending;
}
