import { z } from 'zod';

/** Owned workers (spec 2026-09-06). No import from runs: runs embeds this metadata. */
export const workerOperationSchema = z.enum(['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait']);
export type WorkerOperation = z.infer<typeof workerOperationSchema>;

const commitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const requestHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const workerIdsSchema = z.array(z.uuid()).min(1).max(32)
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
  workerIds: workerIdsSchema,
  deadline: z.iso.datetime(),
  mode: workerWaitModeSchema.optional(),
  revisions: z.array(z.object({ workerId: z.uuid(), revision: z.number().int().nonnegative() }).strict()).max(32).optional(),
  reason: z.enum(['outcome', 'timeout', 'cancelled']).optional(),
  phase: z.enum(['registered', 'parked', 'wake-pending']),
  outcomes: z.array(workerOutcomeSchema).max(32),
  wakeId: z.uuid().optional(),
}).strict();
export type WorkerWait = z.infer<typeof workerWaitSchema>;

export const workerDestroySchema = z.object({
  requestedAt: z.iso.datetime(),
  phase: z.enum(['requested', 'terminating', 'cleaning', 'complete', 'incomplete']),
  remaining: remainingSchema,
  error: errorSchema.optional(),
}).strict();
export type WorkerDestroy = z.infer<typeof workerDestroySchema>;

export const workerCreationReceiptSchema = z.object({
  requestId: z.uuid(),
  workerId: z.uuid(),
  /** Hash of the original normalized spawn request, NOT the resolved commit or inherited settings. */
  requestHash: requestHashSchema,
}).strict();

export const workerBackendSchema = z.enum(['claude', 'codex', 'opencode', 'pi']);
const relativeInputPath = z.string().min(1).max(4096).refine(path =>
  !/[\\\u0000-\u001f\u007f:]/.test(path) && !path.startsWith('/') &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
export const workerContextReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('baseline-file'), path: relativeInputPath }).strict(),
  z.object({ kind: z.literal('parent-attachment'), id: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/).refine(id => !id.includes('..')) }).strict(),
]);
export type WorkerContextReference = z.infer<typeof workerContextReferenceSchema>;
export const workerContextSchema = z.object({
  text: z.string().max(100_000).optional(),
  artifacts: z.array(workerContextReferenceSchema).max(32).optional(),
}).strict();
export const workerInputSchema = z.object({
  source: workerContextReferenceSchema,
  path: z.string().min(1).max(8192),
  /** Parent attachment: SHA-256 of copied bytes. Baseline file: SHA-256 of the pinned Git blob ID
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
  workspace: workerWorkspaceSchema,
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
    permissions: permissionsSchema,
    receipts: z.array(workerCreationReceiptSchema).max(32).refine(receipts =>
      new Set(receipts.map(receipt => receipt.requestId)).size === receipts.length &&
      new Set(receipts.map(receipt => receipt.workerId)).size === receipts.length),
    wait: workerWaitSchema.optional(),
    lastWait: workerWaitSchema.optional(),
    results: z.array(workerResultReferenceSchema).max(32).refine(results => new Set(results.map(result => result.workerId)).size === results.length).optional(),
    finishRequestedAt: z.iso.datetime().optional(),
    completion: z.object({ phase: z.enum(['waiting', 'attention']), waitId: z.uuid().optional() }).strict().optional(),
  }).strict(),
  z.object({
    role: z.literal('worker'),
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
    wait: workerWaitSchema.pick({ phase: true }).strip().optional(),
  }),
  delegationStateSchema.options[1].pick({ role: true }).strip(),
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
}).strict().refine(request => request.task.length + (request.context?.text?.length ?? 0) <= 100_000, { message: 'Combined task and context exceed 100000 characters' });
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

export const agentInputSchema = z.object({
  id: z.uuid(),
  source: z.enum(['agent', 'lifecycle']),
  parentRunId: z.uuid(),
  text: z.string().min(1).max(100_000),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().optional(),
}).strict();
export type AgentInput = z.infer<typeof agentInputSchema>;

export const workerInspectionSchema = z.object({
  workerId: z.uuid(),
  parentRunId: z.uuid(),
  status: z.enum(['queued', 'running', 'waiting', ...workerOutcomeSchema.shape.status.options]),
  currentStepId: z.string().optional(),
  activity: z.enum(['monitoring']).optional(),
  workspace: workerWorkspaceSchema,
  backend: workerBackendSchema.optional(),
  model: z.string().max(512).optional(),
  inputs: z.array(workerInputSchema).max(32).optional(),
  wait: workerWaitSchema.optional(),
  destroy: workerDestroySchema.optional(),
  outcome: workerOutcomeSchema.optional(),
});
export type WorkerInspection = z.infer<typeof workerInspectionSchema>;

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
  remaining: remainingSchema,
  error: errorSchema.optional(),
});
export type WorkerDestroyResult = z.infer<typeof workerDestroyResultSchema>;

export const runRelationshipsSchema = z.object({
  parentRunId: z.uuid().optional(),
  workers: z.array(workerInspectionSchema).max(32),
});
export type RunRelationships = z.infer<typeof runRelationshipsSchema>;

export const delegationErrorResponseSchema = z.object({
  code: z.enum([
    'unavailable_transport', 'unauthenticated', 'denied_scope', 'invalid_input',
    'invalid_baseline', 'incompatible_state', 'capacity_limit', 'unavailable_diff', 'incomplete_cleanup',
  ]),
  error: errorSchema,
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
