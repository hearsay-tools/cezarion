import { z } from 'zod';
import { processUsageSchema, referenceStatusesByProjectSchema, runIndexEntrySchema, runSummarySchema } from './runs.ts';

/**
 * The summary mode of `GET /api/v1/workspace/events` (hearsay-tools/cezarion#2730).
 *
 * `?runs=summary` asks the stream for list rows instead of full run records. Without the
 * parameter the stream is unchanged, so an old tab or an old shared worker keeps working.
 *
 * Ordering: the server numbers every `run-summary` and `run-deleted` frame with one `seq` for the
 * whole process. Within one connection and one server `generation`, the frames a client receives
 * carry contiguous numbers across projects. `ready` names the last number before the first frame
 * of the connection. A jump means the client lost frames and must reconcile. A new `generation`
 * is a reset. The `seq` rides in the data, not in the SSE `id:`: the stream has no replay.
 */
export const workspaceEventsQuerySchema = z.object({
  runs: z.literal('summary').optional(),
});
export type WorkspaceEventsQuery = z.infer<typeof workspaceEventsQuerySchema>;

/** The project stamp every project-owned frame carries. */
const projectStamp = z.string().min(1);
/** The process-wide frame number. The first frame of a generation is 1. */
const frameSeq = z.number().int().positive();

/**
 * One run changed. `run` is exactly the row `GET /workspace/runs-index` would return for it:
 * `toRunSummary(record)` with the live usage sample laid over it. `relationships` is a digest of
 * the fields the relationships route renders; equal digests mean the answer did not change.
 */
export const workspaceRunSummaryEventSchema = z.object({
  project: projectStamp,
  seq: frameSeq,
  run: runSummarySchema,
  relationships: z.string().min(1),
});
export type WorkspaceRunSummaryEvent = z.infer<typeof workspaceRunSummaryEventSchema>;

/** One run was deleted. The legacy stream sends `{ id, project }` without `seq`. */
export const workspaceRunDeletedEventSchema = z.object({
  project: projectStamp,
  seq: frameSeq,
  id: z.string().min(1),
});
export type WorkspaceRunDeletedEvent = z.infer<typeof workspaceRunDeletedEventSchema>;

/** The connection is attached. `seq` is the last frame number sent before this connection. */
export const workspaceReadyEventSchema = z.object({
  generation: z.string().min(1),
  seq: z.number().int().nonnegative(),
});
export type WorkspaceReadyEvent = z.infer<typeof workspaceReadyEventSchema>;

/**
 * Live usage of one project's runs. The summary mode also sends one empty `usage` when the
 * project's last live row stops, so a reader never keeps a sample of a run that ended.
 */
export const workspaceUsageEventSchema = z.object({
  project: projectStamp,
  usage: z.record(z.string(), processUsageSchema),
});
export type WorkspaceUsageEvent = z.infer<typeof workspaceUsageEventSchema>;

/**
 * `GET /workspace/runs-index`: the snapshot the workspace stream's frames patch. It lives beside
 * the stream contract because `generation` and `eventSeq` place it in the stream's order.
 */
export const runsIndexResponseSchema = z.object({
  /** Newest first, across every registered project: each project's window
   *  (hearsay-tools/cezarion#864) — every unarchived root run, plus its newest `perProjectLimit`
   *  archived root runs. Owned workers are never included. Older archived runs are reached
   *  through `GET /workspace/runs-search`. */
  runs: z.array(runIndexEntrySchema),
  /** Additive: absent statuses mean "nothing warm", never "nothing to show". */
  referenceStatuses: referenceStatusesByProjectSchema,
  /** How many archived root runs each project contributes at most. Unarchived roots are never cut. */
  perProjectLimit: z.number(),
  /** Ids of the projects that had more archived root runs than `perProjectLimit`. */
  truncated: z.array(z.string()),
  /** The server process that answered: the workspace stream's `ready.generation`. An `eventSeq`
   *  compares only within one generation. */
  generation: z.string().min(1),
  /** The last workspace stream `seq` this answer includes: every `run-summary` and `run-deleted`
   *  frame at or below it is already in `runs`; a frame above it is newer than the snapshot. */
  eventSeq: z.number().int().nonnegative(),
});
export type RunsIndexResponse = z.infer<typeof runsIndexResponseSchema>;
