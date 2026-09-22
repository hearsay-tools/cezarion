import { z } from 'zod';

/** CI observations never authorize merging, accepting review, or completing a task. */
export const CI_WAIT_LIMITATION = 'Passing reported checks does not prove that every expected workflow has appeared or that the PR is merge-ready. This observation is not merge approval.';
export const CI_WAIT_RECEIPT_INSTRUCTION = 'End your turn to wait for CI; no marker is needed. ' + CI_WAIT_LIMITATION;

// Node-free: strict lexical validation also rejects explicit default ports and URL normalization.
const prPattern = /^https:\/\/([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/pull\/([1-9][0-9]*)$/;
export const ciPrUrlSchema = z.string().max(2048).regex(prPattern).refine(value => {
  const match = prPattern.exec(value);
  return !!match && Number.isSafeInteger(Number(match[4])) && match[3] !== '.' && match[3] !== '..';
}, 'Expected an HTTPS GitHub PR URL with a positive integer PR number');
export const ciWaitRequestSchema = z.object({
  pr: ciPrUrlSchema,
  timeout_seconds: z.number().int().min(1).max(7200).default(1800),
}).strict();
export type CiWaitRequest = z.infer<typeof ciWaitRequestSchema>;
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
export const ciPrIdentitySchema = z.object({
  prUrl: ciPrUrlSchema,
  repository: z.string().max(2048).regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/),
  prNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  headSha: sha,
}).strict();
export type CiPrIdentity = z.infer<typeof ciPrIdentitySchema>;
export const ciWaitOutcomeSchema = z.enum(['passed', 'failed', 'cancelled', 'skipped', 'no_checks', 'head_changed', 'deadline', 'error']);
export const ciWaitErrorCodeSchema = z.enum(['invalid_request', 'unsupported_host', 'gh_missing', 'authentication', 'inaccessible_pr', 'malformed_data', 'output_limit', 'query_timeout', 'command_failed', 'wait_conflict', 'capacity', 'unavailable', 'unauthorized', 'persistence']);
export const ciWaitErrorSchema = z.object({ code: ciWaitErrorCodeSchema, message: z.string().max(4096) }).strict();
export type CiWaitError = z.infer<typeof ciWaitErrorSchema>;
export type CiWaitErrorCode = z.infer<typeof ciWaitErrorCodeSchema>;
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export const ciWaitResultSchema = z.object({
  outcome: ciWaitOutcomeSchema,
  headSha: sha,
  observedHeadSha: sha.optional(),
  observedAt: z.iso.datetime(),
  checks: z.array(z.object({ name: z.string().max(256), state: z.string().max(256), link: z.string().max(2048) }).strict()).max(100),
  totalChecks: z.number().int().nonnegative(),
  truncated: z.boolean(),
  diagnostic: z.string().max(4096).refine(value => utf8Bytes(value) <= 4096).optional(),
}).strict().refine(value => utf8Bytes(JSON.stringify(value)) <= 32 * 1024, 'CI result exceeds 32 KiB');
export type CiWaitResult = z.infer<typeof ciWaitResultSchema>;
export const ciWaitSchema = ciPrIdentitySchema.extend({
  id: z.uuid(),
  generation: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  timeoutSeconds: z.number().int().min(1).max(7200),
  registeredAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  phase: z.enum(['registered', 'parked', 'wake-pending', 'delivered', 'withdrawn']),
  result: ciWaitResultSchema.optional(),
  wakeId: z.string().min(1).max(256).optional(),
  deliveredAt: z.iso.datetime().optional(),
}).strict();
export type CiWait = z.infer<typeof ciWaitSchema>;
/** Model-facing acknowledgement; internal authority and delivery checkpoints stay private. */
export const ciWaitReceiptSchema = ciPrIdentitySchema.extend({
  waitId: z.uuid(),
  registeredAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  phase: ciWaitSchema.shape.phase,
}).strict();
export type CiWaitReceipt = z.infer<typeof ciWaitReceiptSchema>;
