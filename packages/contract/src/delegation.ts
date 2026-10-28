import { modelChoicesSchema } from './discovery.ts';
import { z } from 'zod';
import { conversationAttributionSchema, conversationStateSchema, requestOutcomeSchema } from './conversations.ts';
import { effortFieldSchema } from './effort.ts';

/** Owned workers (spec 2026-09-06). No import from runs: runs embeds this metadata. */
export const workerOperationSchema = z.enum(['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait']);
export type WorkerOperation = z.infer<typeof workerOperationSchema>;

const commitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const requestHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** 1–32 unique ids; the worker wait entry and `cezar_wait` reuse it for worker and request ids. */
export const workerIdsSchema = z.array(z.uuid()).min(1).max(32)
  .refine(ids => new Set(ids).size === ids.length);
const permissionsSchema = z.array(workerOperationSchema).max(7)
  .refine(operations => new Set(operations).size === operations.length);
const remainingSchema = z.array(z.enum(['process', 'worktree', 'branch'])).max(3)
  .refine(resources => new Set(resources).size === resources.length);
const errorSchema = z.string().max(2_000);

export const workerWorkspaceSchema = z.object({
  ownerRunId: z.uuid(),
  resourceId: z.uuid(),
  kind: z.literal('owned-isolated'),
  /** Canonical creation path and original branch, never inferred from execution cwd. */
  path: z.string().min(1),
  branch: z.string().min(1),
  baselineSha: commitShaSchema,
}).strict();
export type WorkerWorkspace = z.infer<typeof workerWorkspaceSchema>;

export const workerOutcomeSchema = z.object({
  workerId: z.uuid(),
  status: z.enum(['review', 'done', 'failed', 'cancelled']),
  observedAt: z.iso.datetime(),
  summary: z.string().max(4_000).optional(),
  revision: z.number().int().nonnegative().optional(),
}).strict();
export type WorkerOutcome = z.infer<typeof workerOutcomeSchema>;

export const workerWaitModeSchema = z.enum(['one', 'any', 'all']);

export const workerWaitSchema = z.object({
  id: z.uuid(),
  workerIds: z.array(z.uuid()).max(32).refine(ids => new Set(ids).size === ids.length),
  requestIds: z.array(z.uuid()).min(1).max(32).optional(),
  requestOutcomes: z.array(requestOutcomeSchema).max(32).optional(),
  deadline: z.iso.datetime(),
  mode: workerWaitModeSchema.optional(),
  revisions: z.array(z.object({ workerId: z.uuid(), revision: z.number().int().nonnegative() }).strict()).max(32).optional(),
  reason: z.enum(['outcome', 'timeout', 'cancelled', 'message']).optional(),
  phase: z.enum(['registered', 'parked', 'wake-pending']),
  outcomes: z.array(workerOutcomeSchema).max(32),
  wakeId: z.uuid().optional(),
}).strict();
export type WorkerWait = z.infer<typeof workerWaitSchema>;

/** Cezar's completion wait as inspection and the relationships view show it: the `WorkerWait`
 *  projection without a deadline, which that wait does not have, and the `via` that names it.
 *  `WorkerWait` keeps requiring a deadline (hearsay-tools/cezarion#1301). */
export const workerCompletionWaitSchema = workerWaitSchema.omit({ deadline: true, requestIds: true, requestOutcomes: true })
  .extend({ via: z.literal('completion') }).strict();
export type WorkerCompletionWait = z.infer<typeof workerCompletionWaitSchema>;

/** Automatic retries of a pending destroy (hearsay-tools/cezarion#879): how many scheduled
 * attempts ran since the last explicit request, when the next one is due, and whether they
 * reached the hourly cap with nothing changing, which the cockpit shows as needing attention.
 * Absent until the first automatic attempt; a manual destroy clears it. Stored on the run record
 * (`destroyRetry`), never inside the strict worker delegation, so an older cezar strips it instead
 * of quarantining the worker; the API shows it as the worker's `destroy.retry`. */
export const workerDestroyRetrySchema = z.object({
  attempts: z.number().int().positive(),
  nextAt: z.iso.datetime(),
  needsAttention: z.literal(true).optional(),
}).strict();
export type WorkerDestroyRetry = z.infer<typeof workerDestroyRetrySchema>;

export const workerDestroySchema = z.object({
  requestedAt: z.iso.datetime(),
  phase: z.enum(['requested', 'terminating', 'cleaning', 'complete', 'incomplete']),
  remaining: remainingSchema,
  error: errorSchema.optional(),
}).strict();
export type WorkerDestroy = z.infer<typeof workerDestroySchema>;
/** A worker's destroy as inspection and relationships show it: the stored phase, plus its retry state. */
export const workerDestroyViewSchema = workerDestroySchema.extend({ retry: workerDestroyRetrySchema.optional() }).strict();
export type WorkerDestroyView = z.infer<typeof workerDestroyViewSchema>;

export const workerCreationReceiptSchema = z.object({
  requestId: z.uuid(),
  workerId: z.uuid(),
  /** Hash of the original normalized spawn request, NOT the resolved commit or inherited settings. */
  requestHash: requestHashSchema,
  deletion: z.object({ phase: z.enum(['pending', 'complete']), revision: z.number().int().nonnegative(), resourceId: z.uuid(), generation: z.uuid() }).strict().optional(),
}).strict();

export const workerBackendSchema = z.enum(['claude', 'codex', 'opencode', 'pi', 'cursor', 'omp']);
const relativeInputPath = z.string().min(1).max(4096).refine(path =>
  !/[\\\u0000-\u001f\u007f:]/.test(path) && !path.startsWith('/') &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'));
/**
 * Why a `parent-file` path may never be attached, or undefined. An attached `.gitignore` would
 * rewrite the worker worktree's ignore rules and could re-include another attachment, which its
 * diff and autosave would then carry (hearsay-tools/cezarion#1149). The schema and the server share it.
 */
export function parentFileRefusal(path: string): string | undefined {
  return path.split('/').at(-1)?.toLowerCase() === '.gitignore'
    ? `--attach cannot attach a .gitignore: ${path}; ignore rules must come from the baseline` : undefined;
}
export const workerContextReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('baseline-file'), path: relativeInputPath }).strict(),
  z.object({ kind: z.literal('parent-attachment'), id: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/).refine(id => !id.includes('..')) }).strict(),
  /** A git-ignored file in the parent's own worktree, relative to its root (`cez worker spawn --attach`, hearsay-tools/cezarion#1149). */
  z.object({ kind: z.literal('parent-file'), path: relativeInputPath }).strict().superRefine(({ path }, ctx) => {
    const message = parentFileRefusal(path);
    if (message) ctx.addIssue({ code: 'custom', path: ['path'], message });
  }),
]);
export type WorkerContextReference = z.infer<typeof workerContextReferenceSchema>;
export const workerContextSchema = z.object({
  text: z.string().max(100_000).optional(),
  artifacts: z.array(workerContextReferenceSchema).max(32).optional(),
}).strict().superRefine(({ artifacts = [] }, ctx) => {
  const seen = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.kind !== 'parent-file') continue;
    if (seen.has(artifact.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts', index, 'path'], message: `duplicate --attach path: ${artifact.path}` });
    seen.add(artifact.path);
  }
});
export const workerInputSchema = z.object({
  source: workerContextReferenceSchema,
  path: z.string().min(1).max(8192),
  /** Parent attachment and parent file: SHA-256 of copied bytes. Baseline file: SHA-256 of the pinned Git blob ID
   * (the lowercase hexadecimal ID as UTF-8 text), not of file contents. Interpret by source.kind. */
  sha256: requestHashSchema,
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type WorkerInput = z.infer<typeof workerInputSchema>;
export const workerInputRecipeSchema = z.object({
  text: z.string().max(100_000).optional(),
  inputs: z.array(workerInputSchema).max(32),
}).strict();
export type WorkerInputRecipe = z.infer<typeof workerInputRecipeSchema>;

/** Bounded result evidence; unavailable identifiers never promise retained bytes. */
const unavailableEvidenceSchema = z.object({ state: z.literal('unavailable'), reason: z.enum(['no-assistant-output', 'missing', 'unreadable', 'unverified']), detail: errorSchema.optional() }).strict();
const deletedEvidenceSchema = z.object({ state: z.literal('deleted'), reason: z.literal('missing') }).strict();
const executionOutcomeSchema = z.enum(['running', 'review-ready', 'completed', 'failed', 'cancelled']);
const workerArtifactSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), id: z.string().max(255), path: z.string().max(8192) }).strict(),
  unavailableEvidenceSchema.extend({ id: z.string().max(255), path: z.string().max(8192) }),
  deletedEvidenceSchema.extend({ id: z.string().max(255), path: z.string().max(8192) }),
]);
export const workerCollectedResultSchema = z.object({
  workerId: z.uuid(), parentRunId: z.uuid(), revision: z.number().int().nonnegative(), observedAt: z.iso.datetime(),
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  outcome: z.enum(['running', 'review-ready', 'completed', 'failed', 'cancelled', 'destroyed']),
  lastExecutionOutcome: executionOutcomeSchema, partial: z.boolean(), settled: z.boolean(), error: errorSchema.optional(),
  backend: workerBackendSchema.optional(), model: z.string().max(512).optional(), baselineSha: commitShaSchema,
  workspace: workerWorkspaceSchema.extend({ state: z.enum(['available', 'unavailable', 'deleted']).optional() }),
  cleanup: z.enum(['retained', 'requested', 'terminating', 'cleaning', 'complete', 'incomplete']),
  summary: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), text: z.string().min(1).max(4000), source: z.literal('assistant'), seq: z.number().int().nonnegative(), truncated: z.boolean() }).strict(),
    unavailableEvidenceSchema, deletedEvidenceSchema,
  ]),
  head: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), sha: commitShaSchema }).strict(),
    unavailableEvidenceSchema.extend({ sha: commitShaSchema.optional() }), deletedEvidenceSchema.extend({ sha: commitShaSchema.optional() }),
  ]),
  diff: z.discriminatedUnion('state', [
    // path addresses a workerResultFileSchema JSON document; its diffSnapshot field contains the patch.
    z.object({ state: z.literal('available'), snapshotId: z.uuid(), path: z.string().min(1).max(8192), truncated: z.boolean() }).strict(),
    unavailableEvidenceSchema, deletedEvidenceSchema,
  ]),
  artifacts: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), items: z.array(workerArtifactSchema).max(32), truncated: z.boolean() }).strict(),
    unavailableEvidenceSchema, deletedEvidenceSchema,
  ]),
}).strict();
export type WorkerCollectedResult = z.infer<typeof workerCollectedResultSchema>;
export const workerResultFileSchema = z.object({ result: workerCollectedResultSchema, diffSnapshot: z.string().max(400_000).optional() }).strict();
export const workerResultReferenceSchema = z.object({
  workerId: z.uuid(), revision: z.number().int().nonnegative(), snapshotId: z.uuid(), observedAt: z.iso.datetime(),
  lastExecutionOutcome: executionOutcomeSchema,
  previous: z.object({ revision: z.number().int().nonnegative(), observedAt: z.iso.datetime(), lastExecutionOutcome: executionOutcomeSchema }).strict().optional(),
}).strict();

export const delegationStateSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('root'),
    conversation: conversationStateSchema.optional(),
    permissions: permissionsSchema,
    // #816: bounded by the creation ceiling (WORKER_CREATION_LIMIT), not by capacity.
    receipts: z.array(workerCreationReceiptSchema).max(1_024).refine(receipts =>
      new Set(receipts.map(receipt => receipt.requestId)).size === receipts.length &&
      new Set(receipts.map(receipt => receipt.workerId)).size === receipts.length),
    // `wait`, `lastWait` and `completion` are the old worker-wait engine's, never written since
    // hearsay-tools/cezarion#1301: every worker wait is a list entry. Kept optional so old rows
    // parse; the store reads them into the list on open (store schemas 6 and 7).
    wait: workerWaitSchema.optional(),
    lastWait: workerWaitSchema.optional(),
    results: z.array(workerResultReferenceSchema).max(1_024).refine(results => new Set(results.map(result => result.workerId)).size === results.length).optional(),
    finishRequestedAt: z.iso.datetime().optional(),
    historyDeletion: z.literal('pending').optional(),
    completion: z.object({ phase: z.enum(['waiting', 'attention']), waitId: z.uuid().optional() }).strict().optional(),
  }).strict(),
  z.object({
    role: z.literal('worker'),
    // Never written since hearsay-tools/cezarion#1301, as for a root; kept so old rows parse.
    wait: workerWaitSchema.optional(),
    lastWait: workerWaitSchema.optional(),
    permissions: permissionsSchema,
    parentRunId: z.uuid(),
    workspace: workerWorkspaceSchema,
    destroy: workerDestroySchema.optional(),
    context: workerInputRecipeSchema.optional(),
    executionRevision: z.number().int().nonnegative().optional(),
    executionStartSeq: z.number().int().nonnegative().optional(),
  }).strict(),
  // A persisted quarantine is distinct from absent legacy metadata and grants no authority.
  z.object({ role: z.literal('invalid') }).strict(),
]);
export type DelegationState = z.infer<typeof delegationStateSchema>;

/** Slim list/palette projection. Never copies resource paths, permissions or receipts. */
export const runDelegationSummarySchema = z.discriminatedUnion('role', [
  delegationStateSchema.options[0].pick({ role: true }).strip().extend({
    // The awaited worker ids and which of them reported (ids only) keep a list's counted label,
    // "waiting on 2 workers" (#617), now that lists read summaries instead of records (#817).
    wait: workerWaitSchema.pick({ phase: true, requestIds: true, workerIds: true }).partial({ workerIds: true }).strip().extend({
      outcomes: z.array(workerOutcomeSchema.pick({ workerId: true }).strip()).max(32).optional(),
    }).optional(),
  }),
  // `parentRunId` is the one worker field a list needs: the sidebar lights the parent's row for
  // a worker URL, and `cez task list` hides workers by it (#817). Never paths or permissions.
  delegationStateSchema.options[1].pick({ role: true, parentRunId: true }).strip().extend({
    wait: workerWaitSchema.pick({ phase: true, requestIds: true }).strip().optional(),
  }),
  delegationStateSchema.options[2].strip(),
]);
export type RunDelegationSummary = z.infer<typeof runDelegationSummarySchema>;

export const workerSpawnRequestSchema = z.object({
  task: z.string().min(1).max(100_000),
  baseline: z.string().min(1).max(1_024),
  requestId: z.uuid(),
  context: workerContextSchema.optional(),
  backend: workerBackendSchema.optional(),
  model: z.string().trim().min(1).max(512).optional(),
  effort: effortFieldSchema,
  /** Catalog workflow name (built-in quick-task or `.ai/cezar/workflows/*.yaml`, #451). Absent with no skill means quick-task. */
  workflow: z.string().trim().min(1).max(200).optional(),
  /** Discovered skill to run as a one-step task, mutually exclusive with workflow (#778). */
  skill: z.string().trim().min(1).max(200).optional(),
}).strict().refine(request => request.skill === undefined || request.workflow === undefined, { message: '--skill and --workflow cannot be used together' }).refine(request => request.task.length + (request.context?.text?.length ?? 0) <= 100_000, { message: 'Combined task and context exceed 100000 characters' });
export type WorkerSpawnRequest = z.infer<typeof workerSpawnRequestSchema>;

export const workerSteerRequestSchema = z.object({
  text: z.string().max(100_000).refine(text => text.trim().length > 0),
}).strict();
export type WorkerSteerRequest = z.infer<typeof workerSteerRequestSchema>;

export const workerWaitRequestSchema = z.object({
  workerIds: workerIdsSchema,
  timeoutSeconds: z.number().int().min(1).max(1800).default(600),
  mode: workerWaitModeSchema.optional(),
}).strict().refine(request => request.mode !== 'one' || request.workerIds.length === 1, { message: 'one mode requires exactly one worker' });
export type WorkerWaitRequest = z.infer<typeof workerWaitRequestSchema>;

export const inboxClaimSchema = z.object({
  receiptId: z.uuid(), generation: z.uuid(), expiresAt: z.iso.datetime(), acknowledgedAt: z.iso.datetime().optional(),
  /** Optional on read for receipts persisted before member manifests existed. */
  memberIds: z.array(z.uuid()).min(1).max(32).refine(ids => new Set(ids).size === ids.length).optional(),
}).strict();
export type InboxClaim = z.infer<typeof inboxClaimSchema>;

export const agentInputSchema = z.object({
  conversation: conversationAttributionSchema.optional(),
  id: z.uuid(),
  source: z.enum(['agent', 'lifecycle']),
  parentRunId: z.uuid(),
  text: z.string().min(1).max(100_000),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().optional(),
  /** The model received it, when the harness can show that (#505). Absent on
   * unobservable backends and on records written before #505. */
  consumedAt: z.iso.datetime().optional(),
  /** Accepted by a harness that reports reading, and not read yet. A restart replays
   * such input; records written before #505 never carry it, so nothing historical replays. */
  awaitingRead: z.literal(true).optional(),
  inboxClaim: inboxClaimSchema.optional(),
  /** A completion refusal Cezar queued for a closed session (hearsay-tools/cezarion#1301): its
   * delivery is the nudge's turn, bounded by the nudge's reply bound, and a session that closes
   * before it is a failed delivery. Absent on every other input and on records written before. */
  purpose: z.literal('completion-refusal').optional(),
  /** A peer message's own hash and request deadline (hearsay-tools/cezarion#1990): the sender's
   *  ledger can be deleted before the recipient reads it. Absent on family and lifecycle inputs. */
  requestHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  deadline: z.iso.datetime().optional(),
}).strict();
export type AgentInput = z.infer<typeof agentInputSchema>;

export const workerInspectionSchema = z.object({
  workerId: z.uuid(),
  parentRunId: z.uuid(),
  status: z.enum(['queued', 'running', 'waiting', ...workerOutcomeSchema.shape.status.options]),
  currentStepId: z.string().optional(),
  workspace: workerWorkspaceSchema,
  backend: workerBackendSchema.optional(),
  model: z.string().max(512).optional(),
  inputs: z.array(workerInputSchema).max(32).optional(),
  wait: workerWaitSchema.optional(),
  /** The parent's deadline-less completion wait on this worker (hearsay-tools/cezarion#1301). */
  completionWait: workerCompletionWaitSchema.optional(),
  destroy: workerDestroyViewSchema.optional(),
  outcome: workerOutcomeSchema.optional(),
});
export type WorkerInspection = z.infer<typeof workerInspectionSchema>;

/** Small summaries omit inspection inputs, wait payloads and assistant output. */
export const workerListEntrySchema = workerInspectionSchema.pick({
  workerId: true, parentRunId: true, status: true, workspace: true, destroy: true,
}).extend({
  revision: z.number().int().nonnegative(),
  settled: z.boolean(),
  destroyed: z.boolean(),
}).strict();
export const workerListResultSchema = z.object({ workers: z.array(workerListEntrySchema).max(1_024) }).strict();
export type WorkerListResult = z.infer<typeof workerListResultSchema>;
/** Receipt offsets are scoped to the authenticated parent; each page examines at most 32. */
export const workerListQuerySchema = z.object({ offset: z.string().regex(/^\d{1,4}$/).refine(value => Number(value) <= 1_024).optional() }).strict();
export type WorkerListQuery = z.infer<typeof workerListQuerySchema>;
export const workerListPageSchema = workerListResultSchema.extend({
  workers: z.array(workerListEntrySchema).max(32),
  nextOffset: z.number().int().min(1).max(1_024).optional(),
}).strict();
export type WorkerListPage = z.infer<typeof workerListPageSchema>;

export const workerDiffSchema = z.object({
  workerId: z.uuid(),
  baselineSha: commitShaSchema,
  diff: z.string().max(400_000),
  truncated: z.boolean(),
});
export type WorkerDiff = z.infer<typeof workerDiffSchema>;

export const workerStopResultSchema = z.object({
  workerId: z.uuid(),
  state: z.enum(['stopping', 'terminated']),
});
export type WorkerStopResult = z.infer<typeof workerStopResultSchema>;

export const workerDestroyResultSchema = z.object({
  workerId: z.uuid(),
  state: z.enum(['complete', 'incomplete']),
  deleted: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('worktree'), path: z.string().max(8192) }).strict(),
    z.object({ kind: z.literal('branch'), ref: z.string().max(1024) }).strict(),
  ])).max(2).optional(),
  remaining: remainingSchema,
  error: errorSchema.optional(),
});
export type WorkerDestroyResult = z.infer<typeof workerDestroyResultSchema>;

/** #816: outstanding allocations against `limit`, lifetime creations against `creationLimit`. */
export const workerCapacitySchema = z.object({
  outstanding: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  creationLimit: z.number().int().nonnegative(),
}).strict();
export type WorkerCapacity = z.infer<typeof workerCapacitySchema>;

/** A related run's display title: the three fields `runTitle` reads (#864). The cockpit's run list
 *  carries only the newest archived runs, so the relationships answer names its own runs. */
export const relatedRunTitleSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleSummary: z.string().optional(),
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
});
export type RelatedRunTitle = z.infer<typeof relatedRunTitleSchema>;

export const runRelationshipsSchema = z.object({
  parentRunId: z.uuid().optional(),
  workers: z.array(workerInspectionSchema).max(1_024),
  /** The parent's title for a worker, each worker's for a parent; absent when there is none. */
  titles: z.array(relatedRunTitleSchema).max(1_025).optional(),
  /** Present for a delegation root only. */
  capacity: workerCapacitySchema.optional(),
});
export type RunRelationships = z.infer<typeof runRelationshipsSchema>;

export const delegationErrorResponseSchema = z.object({
  code: z.enum([
    'unavailable_transport', 'unauthenticated', 'denied_scope', 'invalid_input',
    'invalid_baseline', 'incompatible_state', 'capacity_limit', 'unavailable_diff', 'incomplete_cleanup',
  ]),
  error: errorSchema,
  modelChoices: modelChoicesSchema.optional(),
});
export type DelegationErrorResponse = z.infer<typeof delegationErrorResponseSchema>;

export const workerParamsSchema = z.object({ workerId: z.uuid() }).strict();
export type WorkerParams = z.infer<typeof workerParamsSchema>;
export const workerSpawnResultSchema = z.object({ workerId: z.uuid(), baselineSha: commitShaSchema }).strict();
export type WorkerSpawnResult = z.infer<typeof workerSpawnResultSchema>;
export const workerSteerResultSchema = z.object({ workerId: z.uuid(), state: z.enum(['queued', 'delivered']) }).strict();
export type WorkerSteerResult = z.infer<typeof workerSteerResultSchema>;
export const workerWaitResultSchema = z.object({ wait: workerWaitSchema, instruction: z.string().min(1).max(1_000) }).strict();
export type WorkerWaitResult = z.infer<typeof workerWaitResultSchema>;
export const workerEmptyRequestSchema = z.object({}).strict();

export const workerCancelWaitRequestSchema = z.object({ waitId: z.uuid() }).strict();
export type WorkerCancelWaitRequest = z.infer<typeof workerCancelWaitRequestSchema>;
export const workerCancelWaitResultSchema = z.object({ wait: workerWaitSchema }).strict();
export type WorkerCancelWaitResult = z.infer<typeof workerCancelWaitResultSchema>;

/**
 * `cez message wait --peer` (hearsay-tools/cezarion#1995): a root task waits on 1–32 named peer
 * root tasks, with a deadline of 1–1,800 s (default 600). The wait answers as its list entry does:
 * its phase, and once it resolved, why and from which peer.
 */
export const peerWaitRequestSchema = z.object({
  peerIds: workerIdsSchema,
  timeoutSeconds: z.number().int().min(1).max(1800).default(600),
}).strict();
export type PeerWaitRequest = z.infer<typeof peerWaitRequestSchema>;
export const peerWaitViewSchema = z.object({
  id: z.uuid(),
  peerIds: workerIdsSchema,
  deadline: z.iso.datetime(),
  phase: z.enum(['open', 'resolved', 'delivered', 'cancelled']),
  reason: z.enum(['message', 'settled', 'timeout']).optional(),
  peerRunId: z.uuid().optional(),
  messageId: z.uuid().optional(),
}).strict();
export type PeerWaitView = z.infer<typeof peerWaitViewSchema>;
export const peerWaitRegisteredSchema = z.object({ wait: peerWaitViewSchema, instruction: z.string().min(1).max(1_000) }).strict();
export const peerCancelWaitResultSchema = z.object({ wait: peerWaitViewSchema }).strict();
/** What `POST /delegation/wait` and `/cancel-wait` answer: a worker or request wait, or a peer wait. */
export const delegationWaitResultSchema = z.union([workerWaitResultSchema, peerWaitRegisteredSchema]);
export const delegationCancelWaitResultSchema = z.union([workerCancelWaitResultSchema, peerCancelWaitResultSchema]);
