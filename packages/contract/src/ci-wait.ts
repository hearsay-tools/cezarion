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
/** What a PR wait waits for (hearsay-tools/cezarion#1425): its checks' outcome, or its merge. */
export const prWaitUntilSchema = z.enum(['checks', 'merge']);
export type PrWaitUntil = z.infer<typeof prWaitUntilSchema>;
export const ciWaitRequestSchema = z.object({
  pr: ciPrUrlSchema,
  until: prWaitUntilSchema.default('checks'),
  /** False keeps a conflicting PR from ending the wait: for a PR the agent does not own. */
  wake_on_conflict: z.boolean().default(true),
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
export const ciWaitOutcomeSchema = z.enum(['passed', 'failed', 'cancelled', 'skipped', 'no_checks', 'head_changed', 'conflicting', 'deadline', 'error', 'merged', 'closed']);
export const ciWaitErrorCodeSchema = z.enum(['invalid_request', 'unsupported_host', 'gh_missing', 'authentication', 'inaccessible_pr', 'malformed_data', 'output_limit', 'query_timeout', 'command_failed', 'wait_conflict', 'capacity', 'unavailable', 'unauthorized', 'persistence',
  'manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch',
  'worker_wait_pending', 'worker_execution_stopped',
  'root_finish_pending', 'registration_aborted', 'turn_changed',
]);
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
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional(),
  mergeStateStatus: z.string().max(64).optional(),
  /** A merge wait's `merged` outcome: when, and as which commit, GitHub merged the PR. */
  mergedAt: z.iso.datetime({ offset: true }).optional(),
  mergeCommitSha: sha.optional(),
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
  // Legacy `ciWait` rows predate the target (hearsay-tools/cezarion#1425): they waited for checks.
  until: prWaitUntilSchema.default('checks'),
  wakeOnConflict: z.boolean().default(true),
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
