import { z } from 'zod';
import { runHistoryCursorSchema, runHistoryEventSchema, runIdParamSchema } from './events.ts';

export const LIVE_RUN_LIMIT = 32;
export const LIVE_EVENT_LIMIT = 256;
export const LIVE_BYTE_LIMIT = 1024 * 1024;

export const liveRunDemandSchema = z.object({
  projectId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  runId: runIdParamSchema.shape.id,
  cursor: runHistoryCursorSchema.optional(),
  afterSeq: z.number().int().nonnegative().safe(),
});
export type LiveRunDemand = z.infer<typeof liveRunDemandSchema>;
export const liveRunsRequestSchema = z.object({
  runs: z.array(liveRunDemandSchema).min(1).max(LIVE_RUN_LIMIT),
}).refine(({ runs }) => new Set(runs.map(r => `${r.projectId}/${r.runId}`)).size === runs.length, {
  message: 'duplicate run demand',
});
export type LiveRunsRequest = z.infer<typeof liveRunsRequestSchema>;

const identity = liveRunDemandSchema.pick({ projectId: true, runId: true });
export const liveRunErrorSchema = identity.extend({
  type: z.enum(['error', 'reset']),
  status: z.union([z.literal(400), z.literal(404), z.literal(409), z.literal(413), z.literal(503)]),
  error: z.string(),
});
export const liveRunBatchSchema = identity.extend({
  type: z.literal('batch'),
  events: z.array(runHistoryEventSchema).max(LIVE_EVENT_LIMIT),
  cursor: runHistoryCursorSchema,
  afterSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type LiveRunBatch = z.infer<typeof liveRunBatchSchema>;
export const liveRunBatchResultSchema = z.union([liveRunBatchSchema, liveRunErrorSchema]);
export type LiveRunBatchResult = z.infer<typeof liveRunBatchResultSchema>;
export const liveRunBatchResponseSchema = z.object({
  generation: z.string(),
  results: z.array(liveRunBatchResultSchema),
});
export type LiveRunBatchResponse = z.infer<typeof liveRunBatchResponseSchema>;

export const liveRunFrameSchema = z.union([
  z.object({ type: z.literal('ready'), generation: z.string() }),
  z.object({ type: z.literal('ping') }),
  identity.extend({ type: z.literal('event'), name: z.enum(['run-event', 'ui-event']), event: runHistoryEventSchema }),
  liveRunErrorSchema,
]);
export type LiveRunFrame = z.infer<typeof liveRunFrameSchema>;
