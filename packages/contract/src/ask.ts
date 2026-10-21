/** Structured human questions share one validation and acknowledgement policy
 * across runner delivery, compact history, and current cockpit attention. */
import { z } from 'zod';
import { humanAskClosedEventSchema, humanInputDeliveredEventSchema, type RunEvent } from './events.ts';

export { ASK_LIMITS, askOptionSchema, askQuestionSchema, askRequestSchema } from './ask-schema.ts';
export type { AskOption, AskQuestion, AskRequest } from './ask-schema.ts';
import { askRequestSchema } from './ask-schema.ts';

/** The event types `advancePendingHumanAsk` reads. A reader that filters a transcript before
 * folding it keeps exactly these, so a new way to retire a question reaches every reader. */
export const HUMAN_ASK_EVENT_TYPES: ReadonlySet<string> = new Set(['ask.requested', 'human-input-delivered', 'human-ask-closed']);

/** Only a matching successful human delivery, or the Finish that closed the question, retires the
 * latest valid ask. Attempt bubbles, agent input and lifecycle events are not acknowledgements. */
export function advancePendingHumanAsk<T extends RunEvent>(pending: T | undefined, event: T): T | undefined {
  if (event.type === 'ask.requested' && typeof event.requestId === 'string' &&
    askRequestSchema.safeParse({ questions: event.questions }).success) return event;
  if (event.type === 'human-input-delivered' || event.type === 'human-ask-closed') {
    const retired = (event.type === 'human-input-delivered' ? humanInputDeliveredEventSchema : humanAskClosedEventSchema).safeParse(event);
    if (retired.success && retired.data.askSeq === pending?.seq) return undefined;
  }
  return pending;
}

export function pendingHumanAsk<T extends RunEvent>(events: Iterable<T>): T | undefined {
  let pending: T | undefined;
  for (const event of events) pending = advancePendingHumanAsk(pending, event);
  return pending;
}
