import { z } from 'zod';
import { ATTENTION_RUNGS } from './attention.ts';
import { prWaitUntilSchema } from './ci-wait.ts';
import { requestOutcomeSchema } from './conversations.ts';
import { workerWaitModeSchema } from './delegation.ts';
import { runnerSchema } from './runner.ts';
import { PROJECT_ID_PATTERN } from './project-limits.ts';
import { runStatusSchema } from './run-status.ts';
import type { ToolKind } from './tool-display.ts';

/**
 * The live activity view's snapshot (spec `.ai/specs/2026-11-05-live-activity-view.md`, Data):
 * what each active task and worker does or waits for, and the open requests between tasks.
 * `GET /api/v1/workspace/activity` answers it; the `activity` topics will carry the same shape.
 */

/** One bucket per second of the heartbeat strip, oldest first. */
export const ACTIVITY_RATE_SECONDS = 30;
/** A request's text and a human wait's question, as the view shows them. */
export const ACTIVITY_TEXT_MAX = 500;
/** One line of a run's error. */
export const ACTIVITY_ERROR_MAX = 200;
/** A tool call's title, as the task thread shows it. */
export const ACTIVITY_TOOL_TITLE_MAX = 160;
/** The checks a PR wait lists, and the length of one check name. */
export const ACTIVITY_CHECKS_MAX = 100;
export const ACTIVITY_CHECK_NAME_MAX = 100;
/** How long a stored request outcome stays in `closed`, by its `observedAt`. */
export const ACTIVITY_CLOSED_WINDOW_MS = 30_000;

const iso = z.iso.datetime();
const count = z.number().int().nonnegative();
const runId = z.string().min(1);

/** `ToolKind` as values; `activity.test.ts` holds the two lists equal. */
export const ACTIVITY_TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'task', 'plan', 'other'] as const satisfies readonly ToolKind[];

/** The latest tool call of a run: the title the task thread shows, never its input or output. */
export const activityToolSchema = z.object({
  title: z.string().max(ACTIVITY_TOOL_TITLE_MAX),
  toolKind: z.enum(ACTIVITY_TOOL_KINDS),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'declined']),
  startedAt: iso,
  endedAt: iso.optional(),
}).strict();
export type ActivityTool = z.infer<typeof activityToolSchema>;

/** GitHub's check buckets (`gh pr checks --json bucket`). */
export const activityCheckBucketSchema = z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']);
export type ActivityCheckBucket = z.infer<typeof activityCheckBucketSchema>;

/** A PR wait's check progress. `counts` covers every check, counted before `checks` is cut to
 *  the first `ACTIVITY_CHECKS_MAX`; `truncated` says it was cut. */
export const activityPrProgressSchema = z.object({
  checks: z.array(z.object({ name: z.string().max(ACTIVITY_CHECK_NAME_MAX), bucket: activityCheckBucketSchema }).strict()).max(ACTIVITY_CHECKS_MAX),
  counts: z.object({ pass: count, fail: count, pending: count, skipping: count, cancel: count }).strict(),
  truncated: z.literal(true).optional(),
}).strict();
export type ActivityPrProgress = z.infer<typeof activityPrProgressSchema>;

/**
 * A run's top wait: the kind `computeWaitingOn` reports, with the detail the view needs.
 * `since` is the earliest registration of the open entries it covers, `deadline` the earliest
 * deadline. A usage-limit hold has no wait entry, so it has no `since`.
 */
export const activityWaitSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('human'),
    since: iso,
    detail: z.object({
      /** The ask card's first question. */
      question: z.string().max(ACTIVITY_TEXT_MAX).optional(),
      /** `question`: an open question; `turn-end`: Squawk's `no-wait` wait; `budget`: the
       *  automatic-wake budget is spent; `completion`: Squawk's completion gate. */
      reason: z.enum(['question', 'turn-end', 'budget', 'completion']),
      /** Inputs not delivered yet, when there are any. */
      queuedMessages: z.number().int().positive().optional(),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal('usage-limit'), detail: z.object({ resumeAt: z.string() }).strict() }).strict(),
  z.object({
    kind: z.literal('workers'),
    since: iso,
    deadline: iso.optional(),
    detail: z.object({
      /** `computeWaitingOn`'s count: the unanswered targets, summed over the entries. */
      owed: count,
      /** Targets named and targets settled, summed over the entries. */
      total: count,
      settled: count,
      /** Every open entry waits on request replies. */
      replies: z.literal(true).optional(),
      /** Only when one entry is open. */
      mode: workerWaitModeSchema.optional(),
      /** Who owes the awaited replies, each once. */
      recipientRunIds: z.array(runId),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal('peers'), since: iso, deadline: iso, detail: z.object({ peerRunIds: z.array(runId) }).strict() }).strict(),
  z.object({ kind: z.literal('subagents'), since: iso, deadline: iso, detail: z.object({ running: count }).strict() }).strict(),
  z.object({
    kind: z.literal('pr'),
    since: iso,
    deadline: iso,
    detail: z.object({
      number: z.number().int().positive(),
      target: prWaitUntilSchema,
      /** Check progress, while the CI progress registry holds some for this wait. */
      checks: activityPrProgressSchema.shape.checks.optional(),
      counts: activityPrProgressSchema.shape.counts.optional(),
      truncated: z.literal(true).optional(),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal('process'), since: iso, deadline: iso, detail: z.object({ pid: z.number().int(), note: z.string().optional() }).strict() }).strict(),
  z.object({ kind: z.literal('timer'), since: iso, deadline: iso, detail: z.object({ wakeAt: iso, note: z.string().optional() }).strict() }).strict(),
]);
export type ActivityWait = z.infer<typeof activityWaitSchema>;

const activityRunShape = {
  runId,
  /** The display title: `titleSummary ?? title`. */
  title: z.string(),
  status: runStatusSchema,
  /** The `deriveAttention` rung id, never a label. */
  rung: z.enum(ATTENTION_RUNGS),
  runner: runnerSchema.optional(),
  model: z.string().optional(),
  currentStepId: z.string().optional(),
  startedAt: z.string().optional(),
  wait: activityWaitSchema.optional(),
  tool: activityToolSchema.optional(),
  /** Tool calls started per second, oldest first. */
  rate: z.array(count).length(ACTIVITY_RATE_SECONDS),
  /** One line of `RunRecord.error`. */
  error: z.string().max(ACTIVITY_ERROR_MAX).optional(),
};

/** A worker row under its root's card, settled workers included. */
export const activityWorkerSchema = z.object({
  ...activityRunShape,
  /** The worker's current execution revision. */
  revision: count,
  /** The parent holds a collected result for this revision. */
  collected: z.boolean(),
}).strict();
export type ActivityWorker = z.infer<typeof activityWorkerSchema>;

/** One card: an active root task (D8) with its workers. */
export const activityRunSchema = z.object({ ...activityRunShape, workers: z.array(activityWorkerSchema) }).strict();
export type ActivityRun = z.infer<typeof activityRunSchema>;

/** An open request: no outcome in its ledger (D2). A title is absent when its record cannot be read. */
export const activityRequestSchema = z.object({
  requestId: z.uuid(),
  relationship: z.enum(['family', 'peer']),
  senderRunId: runId,
  recipientRunId: runId,
  text: z.string().max(ACTIVITY_TEXT_MAX),
  senderTitle: z.string().optional(),
  recipientTitle: z.string().optional(),
  createdAt: iso,
  deadline: iso.optional(),
}).strict();
export type ActivityRequest = z.infer<typeof activityRequestSchema>;

/** An outcome a ledger stores, observed in the last `ACTIVITY_CLOSED_WINDOW_MS`. */
export const activityClosedRequestSchema = z.object({
  requestId: z.uuid(),
  senderRunId: runId,
  recipientRunId: runId,
  status: requestOutcomeSchema.shape.status,
  observedAt: iso,
}).strict();
export type ActivityClosedRequest = z.infer<typeof activityClosedRequestSchema>;

export const activityProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  /** False for a project this process has not loaded: its lists are empty because nothing was read. */
  loaded: z.boolean(),
  /** The project is loaded but its run store cannot open: the failure its project routes answer.
   *  The lists are empty because nothing could be read, not because nothing runs. */
  unavailable: z.object({ status: z.union([z.literal(404), z.literal(409), z.literal(503)]), error: z.string() }).strict().optional(),
  /** Root tasks in review: the summary chip (D8). */
  inReview: count,
  tasks: z.array(activityRunSchema),
  requests: z.array(activityRequestSchema),
  closed: z.array(activityClosedRequestSchema),
}).strict();
export type ActivityProject = z.infer<typeof activityProjectSchema>;

export const activitySnapshotSchema = z.object({
  /** The server clock; the client ticks ages from it. */
  generatedAt: iso,
  /** One entry, or every visible project for the global read. */
  projects: z.array(activityProjectSchema),
}).strict();
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>;

/** `GET /workspace/activity`: one project, or every project without `project`. */
export const activityQuerySchema = z.object({
  project: z.union([z.literal('default'), z.string().regex(PROJECT_ID_PATTERN)]).optional(),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
