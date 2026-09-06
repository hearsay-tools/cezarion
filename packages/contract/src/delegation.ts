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
}).strict();
export type WorkerOutcome = z.infer<typeof workerOutcomeSchema>;

export const workerWaitSchema = z.object({
  id: z.uuid(),
  workerIds: workerIdsSchema,
  deadline: z.iso.datetime(),
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

export const delegationStateSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('root'),
    permissions: permissionsSchema,
    receipts: z.array(workerCreationReceiptSchema).max(32).refine(receipts =>
      new Set(receipts.map(receipt => receipt.requestId)).size === receipts.length &&
      new Set(receipts.map(receipt => receipt.workerId)).size === receipts.length),
    wait: workerWaitSchema.optional(),
    finishRequestedAt: z.iso.datetime().optional(),
  }).strict(),
  z.object({
    role: z.literal('worker'),
    permissions: permissionsSchema,
    parentRunId: z.uuid(),
    workspace: workerWorkspaceSchema,
    destroy: workerDestroySchema.optional(),
  }).strict(),
  // A persisted quarantine is distinct from absent legacy metadata and grants no authority.
  z.object({ role: z.literal('invalid') }).strict(),
]);
export type DelegationState = z.infer<typeof delegationStateSchema>;

export const workerSpawnRequestSchema = z.object({
  task: z.string().min(1).max(100_000),
  baseline: z.string().min(1).max(1_024),
  requestId: z.uuid(),
}).strict();
export type WorkerSpawnRequest = z.infer<typeof workerSpawnRequestSchema>;

export const workerSteerRequestSchema = z.object({
  text: z.string().max(100_000).refine(text => text.trim().length > 0),
}).strict();
export type WorkerSteerRequest = z.infer<typeof workerSteerRequestSchema>;

export const workerWaitRequestSchema = z.object({
  workerIds: workerIdsSchema,
  timeoutSeconds: z.number().int().min(1).max(1800).default(600),
}).strict();
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
