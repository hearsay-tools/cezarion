/** Structured human questions share one validation and acknowledgement policy
 * across runner delivery, compact history, and current cockpit attention. */
import { z } from 'zod';
import { humanInputDeliveredEventSchema, type RunEvent } from './events.ts';

export const askOptionSchema = z
  .object({
    label: z.string().min(1).max(60),
    description: z.string().max(280).optional(),
  })
  .strict();

export const askQuestionSchema = z
  .object({
    /** Stable key for the answer; defaults to the array index when omitted. */
    id: z.string().min(1).max(64).optional(),
    /** ≤12-char chip label (matches AskUserQuestion's `header`). */
    header: z.string().min(1).max(12),
    question: z.string().min(1).max(400),
    options: z
      .array(askOptionSchema)
      .min(2)
      .max(4)
      .refine((opts) => new Set(opts.map((o) => o.label)).size === opts.length, {
        message: 'option labels must be unique within a question',
      }),
    multiSelect: z.boolean().optional(),
  })
  .strict();

export const askRequestSchema = z
  .object({
    questions: z
      .array(askQuestionSchema)
      .min(1)
      .max(4)
      .refine((qs) => new Set(qs.map((q) => q.question)).size === qs.length, {
        message: 'question texts must be unique',
      }),
  })
  .strict();

export type AskOption = z.infer<typeof askOptionSchema>;
export type AskQuestion = z.infer<typeof askQuestionSchema>;
export type AskRequest = z.infer<typeof askRequestSchema>;

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
