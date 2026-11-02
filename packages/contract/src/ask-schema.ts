/** The structured question shapes, in a leaf module: conversations import them without
 * pulling in the event schemas that `ask.ts` depends on (#505). */
import { z } from 'zod';

/** The card's limits, shared with the agent-facing tool text and rejections (hearsay-tools/cezarion#1428). */
export const ASK_LIMITS = { questions: 4, id: 64, header: 12, question: 400, minOptions: 2, maxOptions: 4, label: 60, description: 280, context: 20_000 } as const;

/** hearsay-tools/cezarion#1458: the Markdown the user reads above the questions. On Claude, prose
 *  between tool calls can reach Cezar only as a short summary; a field inside the call arrives whole. */
export const askContextSchema = z.string().min(1).max(ASK_LIMITS.context);

export const askOptionSchema = z
  .object({
    label: z.string().min(1).max(ASK_LIMITS.label),
    description: z.string().max(ASK_LIMITS.description).optional(),
  })
  .strict();

export const askQuestionSchema = z
  .object({
    /** Stable key for the answer; defaults to the array index when omitted. */
    id: z.string().min(1).max(ASK_LIMITS.id).optional(),
    /** ≤12-char chip label (matches AskUserQuestion's `header`). */
    header: z.string().min(1).max(ASK_LIMITS.header),
    question: z.string().min(1).max(ASK_LIMITS.question),
    /** Omitted, the question is open: the user types the answer (hearsay-tools/cezarion#1234). A
     *  list still takes 2–4 options, so an empty or one-option list is refused, not made open. */
    options: z
      .array(askOptionSchema)
      .min(ASK_LIMITS.minOptions)
      .max(ASK_LIMITS.maxOptions)
      .refine((opts) => new Set(opts.map((o) => o.label)).size === opts.length, {
        message: 'option labels must be unique within a question',
      })
      .optional(),
    /** Applies to the options; an open question ignores it. */
    multiSelect: z.boolean().optional(),
  })
  .strict();

/** The stored shape: asks recorded before hearsay-tools/cezarion#1458, saved asks from the retired
 *  `CEZ:ASK` marker and a routed question may carry no context. `cezar_ask` requires it (`cezarAskRequestSchema`). */
export const askRequestSchema = z
  .object({
    context: askContextSchema.optional(),
    questions: z
      .array(askQuestionSchema)
      .min(1)
      .max(ASK_LIMITS.questions)
      .refine((qs) => new Set(qs.map((q) => q.question)).size === qs.length, {
        message: 'question texts must be unique',
      }),
  })
  .strict();

export type AskOption = z.infer<typeof askOptionSchema>;
export type AskQuestion = z.infer<typeof askQuestionSchema>;
export type AskRequest = z.infer<typeof askRequestSchema>;
