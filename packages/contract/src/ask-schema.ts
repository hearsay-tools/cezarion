/** The structured question shapes, in a leaf module: conversations import them without
 * pulling in the event schemas that `ask.ts` depends on (#505). */
import { z } from 'zod';

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
    /** Omitted, the question is open: the user types the answer (hearsay-tools/cezarion#1234). A
     *  list still takes 2–4 options, so an empty or one-option list is refused, not made open. */
    options: z
      .array(askOptionSchema)
      .min(2)
      .max(4)
      .refine((opts) => new Set(opts.map((o) => o.label)).size === opts.length, {
        message: 'option labels must be unique within a question',
      })
      .optional(),
    /** Applies to the options; an open question ignores it. */
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
