import { z } from 'zod';
import { runIdParamSchema } from './events.ts';

/**
 * Voice mode v1 (spec 2026-10-21-voice-mode): the ⌘K palette understands sentences. The server
 * asks Jev (TypeSafe) to turn one sentence into one decision; the cockpit executes it. Everything
 * here is Node-free; the server and the cockpit read the same definitions.
 */

/** Longest sentence the palette sends, after trimming. */
export const VOICE_TEXT_MAX = 500;

/** The sidebar statuses a sentence may name, in the vocabulary the cockpit already shows. */
export const VOICE_STATUS_IDS = [
  'needs-you',
  'working',
  'finished',
  'archived',
  'needs-review',
  'needs-permission',
  'failed',
  'running',
  'waiting-for-ci',
  'monitoring',
  'waiting-for-capacity',
  'queued',
  'scheduled',
  'waiting-on-workers',
  'done',
  'cancelled',
  'unread',
] as const;
export const voiceStatusSchema = z.enum(VOICE_STATUS_IDS);
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

/** One plain line per status, written for the engine that picks one. */
export const VOICE_STATUS_DESCRIPTIONS: Record<VoiceStatus, string> = {
  'needs-you': 'Tasks that wait for the user: a question, a permission or a review.',
  working: 'Tasks that are running or waiting on something other than the user.',
  finished: 'Done, failed or cancelled tasks the user has not archived.',
  archived: 'Tasks the user has archived.',
  'needs-review': 'Tasks that stopped at the review gate and wait for the user to review the change.',
  'needs-permission': 'Tasks that wait for the user to allow or deny a tool call.',
  failed: 'Tasks that ended with an error.',
  running: 'Tasks whose agent is working right now.',
  'waiting-for-ci': 'Tasks that wait for the checks of a pull request.',
  monitoring: 'Tasks that parked to watch something and will wake later.',
  'waiting-for-capacity': 'Tasks that wait for a free parallel slot or for memory.',
  queued: 'Tasks that have not started yet.',
  scheduled: 'Tasks that a timer will start or wake at a set time.',
  'waiting-on-workers':
    'Tasks that wait on other tasks: for the workers they started, for replies from their workers, or for a reply from their parent task.',
  done: 'Tasks that finished their work without error.',
  cancelled: 'Tasks the user stopped.',
  unread: 'Tasks with news the user has not seen yet.',
};

/** Which task in the list a sentence points at. */
export const voicePositionSchema = z.union([z.enum(['next', 'previous', 'last']), z.number().int().min(1).max(10)]);
export type VoicePosition = z.infer<typeof voicePositionSchema>;

export const voiceSidebarViewSchema = z.enum(['active', 'automations']);

export const voiceDecideRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(VOICE_TEXT_MAX),
    sidebarView: voiceSidebarViewSchema,
    openRunId: runIdParamSchema.shape.id.optional(),
    proposal: z
      .object({
        decisionId: z.uuid(),
        action: z.enum(['answer', 'tell']),
      })
      .strict()
      .optional(),
  })
  .strict();
export type VoiceDecideRequest = z.infer<typeof voiceDecideRequestSchema>;

/** One answer to one question of an ask: a listed option, or free text. */
export const voiceAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    question: z.number().int().min(0).max(3),
    kind: z.literal('option'),
    labels: z.array(z.string()).min(1).max(4),
  }),
  z.object({
    question: z.number().int().min(0).max(3),
    kind: z.literal('other'),
    text: z.string().min(1).max(VOICE_TEXT_MAX),
  }),
]);
export type VoiceAnswer = z.infer<typeof voiceAnswerSchema>;

const decisionId = z.uuid();
const confidence = z.number().min(0).max(1);

export const voiceDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    decisionId,
    status: voiceStatusSchema,
    position: voicePositionSchema,
    confidence,
    alternatives: z.array(z.object({ status: voiceStatusSchema, position: voicePositionSchema })).max(3).optional(),
  }),
  z.object({
    action: z.literal('answer'),
    decisionId,
    runId: runIdParamSchema.shape.id,
    askRequestId: z.string(),
    answers: z.array(voiceAnswerSchema).min(1).max(4),
    confidence,
  }),
  z.object({
    action: z.literal('tell'),
    decisionId,
    runId: runIdParamSchema.shape.id,
    text: z.string().min(1).max(VOICE_TEXT_MAX),
    confidence,
  }),
  z.object({ action: z.literal('confirm'), decisionId }),
  z.object({ action: z.literal('cancel'), decisionId }),
  z.object({
    action: z.literal('none'),
    decisionId,
    reason: z.enum(['not-a-command', 'no-open-task', 'no-open-question', 'unclear']),
  }),
]);
export type VoiceDecision = z.infer<typeof voiceDecisionSchema>;

/** What became of a decision, reported back so the server can learn which ones were wrong. */
export const voiceOutcomeSchema = z.enum(['executed', 'confirmed', 'cancelled', 'replaced', 'abandoned']);
export type VoiceOutcome = z.infer<typeof voiceOutcomeSchema>;

export const voiceOutcomeRequestSchema = z.object({ decisionId: z.uuid(), outcome: voiceOutcomeSchema }).strict();
export type VoiceOutcomeRequest = z.infer<typeof voiceOutcomeRequestSchema>;

export const voiceOutcomeResponseSchema = z.object({ ok: z.literal(true) });
export type VoiceOutcomeResponse = z.infer<typeof voiceOutcomeResponseSchema>;
