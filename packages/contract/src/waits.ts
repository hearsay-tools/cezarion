import { z } from 'zod';
import { askContextSchema, askRequestSchema } from './ask-schema.ts';
import { ciPrIdentitySchema, ciPrUrlSchema, ciWaitErrorCodeSchema, ciWaitRequestSchema, ciWaitResultSchema, prWaitUntilSchema } from './ci-wait.ts';
import { workerIdsSchema, workerOutcomeSchema, workerWaitModeSchema } from './delegation.ts';
import type { DelegationState, PeerWaitView, RunDelegationSummary, WorkerCompletionWait, WorkerWait } from './delegation.ts';
import { requestOutcomeSchema } from './conversations.ts';
import type { RunRecord } from './runs.ts';

/**
 * The wait list (spec `.ai/specs/2026-10-17-unified-waits.md`; phase 1 is
 * hearsay-tools/cezarion#1233). A run holds its open and recently settled waits in
 * `RunRecord.waits`; the agent opens one with `cezar_wait` and closes it with
 * `cezar_cancel_wait`. A wait ends only when its own event fires, its deadline passes, or someone
 * cancels it. Phase 1 carries the `ci` and `timer` kinds; phase 2 (hearsay-tools/cezarion#1234)
 * adds `human`, which the agent opens with `cezar_ask` and which has no deadline: it ends when
 * the user answers or the agent cancels it.
 * Phase 3a (hearsay-tools/cezarion#1235) adds `worker`, which waits on workers' outcomes or on
 * replies to requests and has a deadline. Phase 3b (hearsay-tools/cezarion#1301) moves the
 * completion gate's own wait into the list as a `source: 'cezar'`, `via: 'completion'` worker
 * entry with no deadline, so the list is all `computeWaitingOn` reads.
 * hearsay-tools/cezarion#1995 adds `peer` (spec `2026-10-27-task-communication-protocol` § 7): a root
 * task waits for named peer root tasks to write or to settle, with a deadline.
 */

export const WAIT_LIMIT = 16;
export const LAST_WAITS_LIMIT = 16;
export const TIMER_MIN_SECONDS = 60;
export const TIMER_MAX_SECONDS = 7200;
const NOTE_MAX = 512;
/** A process wait's bounds (hearsay-tools/cezarion#1446): the CI wait's timeout range. */
export const PROCESS_TIMEOUT_DEFAULT_SECONDS = 1800;
export const PROCESS_TIMEOUT_MAX_SECONDS = 7200;
export const PROCESS_EXIT_FILE_MAX = 4096;
/** A peer wait's deadline, and a request or worker wait's (hearsay-tools/cezarion#1995). */
export const PEER_WAIT_DEFAULT_SECONDS = 600;
export const PEER_WAIT_MAX_SECONDS = 1800;
const pidSchema = z.number().int().min(2);

/** `open` → `resolved` (its event fired or its deadline passed) → `delivered`, or `cancelled`. */
export const waitPhaseSchema = z.enum(['open', 'resolved', 'delivered', 'cancelled']);
export type WaitPhase = z.infer<typeof waitPhaseSchema>;
/** What opened the wait: the tool itself, or one of the aliases that map into the same list.
 *  `no-wait` is the human wait cezar opens when a nudged turn still ends without one; `budget`
 *  is the one it opens when the automatic-wake budget is spent; `cez-worker-wait` is
 *  `cez worker wait`, the alias that opens a `worker` wait; `completion` is the worker wait
 *  cezar opens for a root whose done is refused twice (hearsay-tools/cezarion#1301).
 *  `cez-message-wait` is `cez message wait --peer` (hearsay-tools/cezarion#1995); a request wait
 *  from `cez message wait --request` keeps `cez-worker-wait`. */
export const waitViaSchema = z.enum([
  // `cezar_wait_for_ci` is kept for stored rows only: the tool was removed (hearsay-tools/cezarion#1236).
  'cezar_wait', 'cezar_wait_for_ci', 'cezar_ask', 'monitoring-line', 'schedule-wakeup', 'ask-line', 'native-ask', 'no-wait', 'budget',
  'cez-worker-wait', 'completion', 'cez-message-wait',
]);
export type WaitVia = z.infer<typeof waitViaSchema>;

const waitBaseShape = {
  id: z.uuid(),
  source: z.enum(['agent', 'cezar']),
  via: waitViaSchema,
  registeredAt: z.iso.datetime(),
  phase: waitPhaseSchema,
  resolvedAt: z.iso.datetime().optional(),
  deliveredAt: z.iso.datetime().optional(),
  cancelledAt: z.iso.datetime().optional(),
  turnId: z.string().min(1).max(256),
};

/** A pull request's checks or its merge (hearsay-tools/cezarion#1425; kind `ci` before it, which
 *  the store reads as `until: 'checks'`, `wakeOnConflict: true`). */
export const prWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('pr'),
  deadline: z.iso.datetime(),
  ...ciPrIdentitySchema.shape,
  generation: z.string().min(1).max(256),
  timeoutSeconds: z.number().int().min(1).max(7200),
  until: prWaitUntilSchema,
  wakeOnConflict: z.boolean(),
  result: ciWaitResultSchema.optional(),
}).strict();
export type PrWaitEntry = z.infer<typeof prWaitEntrySchema>;

export const timerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('timer'),
  deadline: z.iso.datetime(),
  seconds: z.number().int().min(TIMER_MIN_SECONDS).max(TIMER_MAX_SECONDS),
  note: z.string().max(NOTE_MAX).optional(),
}).strict();
export type TimerWaitEntry = z.infer<typeof timerWaitEntrySchema>;

/**
 * How a process wait ended (hearsay-tools/cezarion#1446): the exit file appeared (`exitCode` when
 * its first line is an integer, else `exitFileNote`), the process is gone with no exit file
 * (`exited`, code unknown), it still ran at the deadline, or the check failed (`error`).
 */
export const processWaitResultSchema = z.object({
  outcome: z.enum(['exit_file', 'exited', 'deadline', 'error']),
  observedAt: z.iso.datetime(),
  exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  exitFileNote: z.literal('not-an-exit-code').optional(),
  diagnostic: z.string().max(512).optional(),
}).strict();
export type ProcessWaitResult = z.infer<typeof processWaitResultSchema>;

/**
 * A command the agent started in the background, watched by its PID (hearsay-tools/cezarion#1446).
 * `startToken` pins the process incarnation, so a reused PID never matches; it is absent when the
 * PID was already gone at registration or the platform cannot say. `exitFile` is the resolved
 * absolute path the command writes its exit code to.
 */
export const processWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('process'),
  deadline: z.iso.datetime(),
  timeoutSeconds: z.number().int().min(1).max(PROCESS_TIMEOUT_MAX_SECONDS),
  pid: pidSchema,
  startToken: z.string().min(1).max(256).optional(),
  exitFile: z.string().min(1).max(PROCESS_EXIT_FILE_MAX).optional(),
  note: z.string().max(NOTE_MAX).optional(),
  result: processWaitResultSchema.optional(),
}).strict();
export type ProcessWaitEntry = z.infer<typeof processWaitEntrySchema>;

/** The user. `questions` is the card the agent asked with, absent for a plain "your turn";
 *  `askSeq` is the event cezar showed it as, once the turn ended: its `ask.requested`, the human
 *  gate a wait without a card raises, or the note that shows Cezar's own wait. */
export const humanWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('human'),
  questions: askRequestSchema.shape.questions.optional(),
  /** The card's Markdown context (hearsay-tools/cezarion#1458); absent on waits recorded before it. */
  context: askContextSchema.optional(),
  askSeq: z.number().int().nonnegative().optional(),
}).strict();
export type HumanWaitEntry = z.infer<typeof humanWaitEntrySchema>;

/**
 * Workers' outcomes, or replies to requests the run sent (hearsay-tools/cezarion#1235). The
 * target is exactly one of `workerIds` (with `revisions` and `outcomes`) and `requestIds` (with
 * `requestOutcomes`); every outcome is the first observation, durable once recorded. Unlike a
 * CI wait it has no `generation`: a worker's identity is its id. `result.reason` is why it
 * resolved; `cancelled` is a phase, and a message no longer ends a wait.
 * `wakeInputId` is an upgraded row's already-queued wake input, delivered once instead of the
 * list's `input.id === wait.id` convention.
 */
export const workerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('worker'),
  // Cezar's completion wait has neither: it ends when its workers settle (hearsay-tools/cezarion#1301).
  deadline: z.iso.datetime().optional(),
  timeoutSeconds: z.number().int().min(1).max(1800).optional(),
  mode: workerWaitModeSchema.optional(),
  workerIds: workerIdsSchema.optional(),
  revisions: z.array(z.object({ workerId: z.uuid(), revision: z.number().int().nonnegative() }).strict()).max(32).optional(),
  outcomes: z.array(workerOutcomeSchema).max(32).optional(),
  requestIds: workerIdsSchema.optional(),
  requestOutcomes: z.array(requestOutcomeSchema).max(32).optional(),
  result: z.object({ reason: z.enum(['outcome', 'timeout']) }).strict().optional(),
  wakeInputId: z.uuid().optional(),
}).strict().superRefine((wait, ctx) => {
  const hasDeadline = wait.deadline !== undefined;
  const hasTimeout = wait.timeoutSeconds !== undefined;
  if (wait.source === 'agent') {
    if (!hasDeadline) ctx.addIssue({ code: 'custom', message: 'an agent worker wait requires a deadline', path: ['deadline'] });
    if (!hasTimeout) ctx.addIssue({ code: 'custom', message: 'an agent worker wait requires timeoutSeconds', path: ['timeoutSeconds'] });
  } else if (hasDeadline !== hasTimeout) {
    ctx.addIssue({ code: 'custom', message: 'a cezar worker wait takes deadline and timeoutSeconds together or neither', path: [hasDeadline ? 'timeoutSeconds' : 'deadline'] });
  }
  const byWorker = wait.workerIds !== undefined;
  const byRequest = wait.requestIds !== undefined;
  if (byWorker === byRequest) {
    ctx.addIssue({ code: 'custom', message: 'a worker wait names workerIds or requestIds, exactly one', path: [byWorker ? 'requestIds' : 'workerIds'] });
    return;
  }
  if (wait.mode === 'one' && (wait.workerIds ?? wait.requestIds)?.length !== 1) {
    ctx.addIssue({ code: 'custom', message: 'one mode requires exactly one id', path: ['mode'] });
  }
  const own = byWorker ? ['revisions', 'outcomes'] as const : ['requestOutcomes'] as const;
  const other = byWorker ? ['requestOutcomes'] as const : ['revisions', 'outcomes'] as const;
  for (const key of own) {
    if (wait[key] === undefined) ctx.addIssue({ code: 'custom', message: `${key} is required with ${byWorker ? 'workerIds' : 'requestIds'}`, path: [key] });
  }
  for (const key of other) {
    if (wait[key] !== undefined) ctx.addIssue({ code: 'custom', message: `${key} does not go with ${byWorker ? 'workerIds' : 'requestIds'}`, path: [key] });
  }
});
export type WorkerWaitEntry = z.infer<typeof workerWaitEntrySchema>;
/** An entry the legacy `WorkerWait` shape can render: its deadline is required there. Cezar's
 *  deadline-less completion wait is not one (hearsay-tools/cezarion#1301). */
export type DeadlinedWorkerWaitEntry = WorkerWaitEntry & { deadline: string };
export const hasWorkerDeadline = (entry: WorkerWaitEntry): entry is DeadlinedWorkerWaitEntry => entry.deadline !== undefined;

/**
 * Why a peer wait resolved (hearsay-tools/cezarion#1995): a message of any kind from a named peer
 * (`peerRunId`, `messageId`), a named peer that settled (`review`, `done`, `failed`, `cancelled`) or
 * was deleted (`peerRunId`), or the deadline.
 */
export const peerWaitResultSchema = z.object({
  reason: z.enum(['message', 'settled', 'timeout']),
  peerRunId: z.uuid().optional(),
  messageId: z.uuid().optional(),
}).strict();
export type PeerWaitResult = z.infer<typeof peerWaitResultSchema>;

/**
 * Named peer root tasks (hearsay-tools/cezarion#1995, spec `2026-10-27-task-communication-protocol`
 * § 7). It is the one wait a message closes, and only a message from a peer it names; human and
 * family messages wake the run and leave it open. It always has a deadline, its liveness bound.
 */
export const peerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('peer'),
  deadline: z.iso.datetime(),
  timeoutSeconds: z.number().int().min(1).max(PEER_WAIT_MAX_SECONDS),
  peerIds: workerIdsSchema,
  result: peerWaitResultSchema.optional(),
}).strict();
export type PeerWaitEntry = z.infer<typeof peerWaitEntrySchema>;

/** A peer wait as `cez message wait --peer` and `cez message cancel-wait` answer it. */
export function peerWaitView(entry: PeerWaitEntry): PeerWaitView {
  return { id: entry.id, peerIds: entry.peerIds, deadline: entry.deadline, phase: entry.phase, ...entry.result };
}

export const waitSchema = z.discriminatedUnion('kind', [prWaitEntrySchema, timerWaitEntrySchema, humanWaitEntrySchema, workerWaitEntrySchema, processWaitEntrySchema, peerWaitEntrySchema]);
export type Wait = z.infer<typeof waitSchema>;

// ---- the tools ----------------------------------------------------------------------------

const oneModeTakesOneId = (ids: readonly string[], mode: string | undefined, ctx: z.RefinementCtx) => {
  if (mode === 'one' && ids.length !== 1) ctx.addIssue({ code: 'custom', message: 'one mode requires exactly one id', path: ['mode'] });
};
const waitTimeoutSeconds = z.number().int().min(1).max(PEER_WAIT_MAX_SECONDS).default(PEER_WAIT_DEFAULT_SECONDS);

/** `cezar_wait`. The `pr` branch keeps the removed `cezar_wait_for_ci`'s bounds and default;
 *  it replaced kind `ci` (hearsay-tools/cezarion#1425). Kind `request` took `request_ids` from kind
 *  `worker`, and kind `peer` is new (hearsay-tools/cezarion#1995); a request wait is still stored
 *  as a `worker` entry with `requestIds`. */
export const cezarWaitRequestSchema = z.discriminatedUnion('kind', [
  ciWaitRequestSchema.extend({ kind: z.literal('pr') }).strict(),
  z.object({
    kind: z.literal('worker'),
    worker_ids: workerIdsSchema,
    mode: workerWaitModeSchema.optional(),
    timeout_seconds: waitTimeoutSeconds,
  }).strict().superRefine((request, ctx) => oneModeTakesOneId(request.worker_ids, request.mode, ctx)),
  z.object({
    kind: z.literal('request'),
    request_ids: workerIdsSchema,
    mode: workerWaitModeSchema.optional(),
    timeout_seconds: waitTimeoutSeconds,
  }).strict().superRefine((request, ctx) => oneModeTakesOneId(request.request_ids, request.mode, ctx)),
  z.object({
    kind: z.literal('peer'),
    peer_ids: workerIdsSchema,
    timeout_seconds: waitTimeoutSeconds,
  }).strict(),
  z.object({
    kind: z.literal('timer'),
    seconds: z.number().int().min(TIMER_MIN_SECONDS).max(TIMER_MAX_SECONDS),
    note: z.string().max(NOTE_MAX).optional(),
  }).strict(),
  z.object({
    kind: z.literal('process'),
    pid: pidSchema,
    exit_file: z.string().min(1).max(PROCESS_EXIT_FILE_MAX).optional(),
    timeout_seconds: z.number().int().min(1).max(PROCESS_TIMEOUT_MAX_SECONDS).default(PROCESS_TIMEOUT_DEFAULT_SECONDS),
    note: z.string().max(NOTE_MAX).optional(),
  }).strict(),
]);
export type CezarWaitRequest = z.infer<typeof cezarWaitRequestSchema>;
/** What a caller may send: the defaults (`until`, `wake_on_conflict`, `timeout_seconds`) still unset. */
export type CezarWaitRequestInput = z.input<typeof cezarWaitRequestSchema>;

export const cezarCancelWaitRequestSchema = z.object({ wait_id: z.uuid() }).strict();
export type CezarCancelWaitRequest = z.infer<typeof cezarCancelWaitRequestSchema>;

/** One still-open wait as both tools list it back to the agent. A PR, timer, worker, process or
 *  peer wait carries its deadline; a human wait has none. */
const openWaitFields = { wait_id: z.uuid(), summary: z.string().max(256) };
export const openWaitSchema = z.discriminatedUnion('kind', [
  z.object({ ...openWaitFields, kind: z.enum(['pr', 'timer', 'worker', 'process', 'peer']), deadline: z.iso.datetime() }).strict(),
  z.object({ ...openWaitFields, kind: z.literal('human') }).strict(),
]);
export type OpenWait = z.infer<typeof openWaitSchema>;

export const waitErrorCodeSchema = z.enum([...ciWaitErrorCodeSchema.options, 'timers_disabled', 'wake_budget_spent', 'denied_scope',
  'exit_file_outside', 'process_not_allowed', 'process_not_owned']);
export type WaitErrorCode = z.infer<typeof waitErrorCodeSchema>;

/** The bound on every wait and done refusal's `message`; the run manager fits its own to it. */
export const WAIT_MESSAGE_MAX = 4096;
const message = z.string().max(WAIT_MESSAGE_MAX);

export const cezarWaitAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    wait_id: z.uuid(),
    /** The kind the call asked for: a `request` wait is stored as a `worker` entry. */
    kind: z.enum(['pr', 'timer', 'worker', 'request', 'process', 'peer']),
    deadline: z.iso.datetime(),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: waitErrorCodeSchema,
    message,
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type CezarWaitAnswer = z.infer<typeof cezarWaitAnswerSchema>;

/**
 * `cezar_ask` (hearsay-tools/cezarion#1234): the user's answer, asked with a card. A question
 * without options is open, and the user types its answer. The wait it opens has no deadline.
 * `context` is required here (hearsay-tools/cezarion#1458), optional in every stored shape.
 */
export const cezarAskRequestSchema = askRequestSchema.extend({ context: askContextSchema });
export type CezarAskRequest = z.infer<typeof cezarAskRequestSchema>;

/** The refusals a question can meet: the session's, the run's capacity, and an autonomous run. */
export const askErrorCodeSchema = z.enum([
  'invalid_request', 'capacity', 'persistence', 'unavailable', 'unauthorized', 'autonomous_run',
  'manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping', 'session_replaced',
  'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch', 'worker_wait_pending',
  'worker_execution_stopped', 'root_finish_pending',
]);
export type AskErrorCode = z.infer<typeof askErrorCodeSchema>;

export const cezarAskAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), wait_id: z.uuid(), open_waits: z.array(openWaitSchema).max(WAIT_LIMIT) }).strict(),
  z.object({
    ok: z.literal(false),
    code: askErrorCodeSchema,
    message,
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type CezarAskAnswer = z.infer<typeof cezarAskAnswerSchema>;

/** `already_resolved`: the result is owed and arrives with the next wake; cancelling is a no-op.
 *  `human_question`: the question already reached the user, so only their answer ends it. */
export const cezarCancelWaitAnswerSchema = z.discriminatedUnion('cancelled', [
  z.object({
    cancelled: z.literal(true),
    wait_id: z.uuid(),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
  }).strict(),
  z.object({
    cancelled: z.literal(false),
    code: z.enum(['not_found', 'already_resolved', 'human_question', 'invalid_request', 'unavailable']),
    message,
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type CezarCancelWaitAnswer = z.infer<typeof cezarCancelWaitAnswerSchema>;

/** `cezar_done`: the run finishes when this turn ends. The summary becomes the closing note. */
export const cezarDoneRequestSchema = z.object({ summary: z.string().max(2000).optional() }).strict();
export type CezarDoneRequest = z.infer<typeof cezarDoneRequestSchema>;

// `worker_wait_pending` (here and in the ask and CI wait codes) was the old completion wait's
// refusal; it is kept for old clients and never returned since hearsay-tools/cezarion#1301.
// `not_final_step` is kept the same way: every agent step accepts a done since
// hearsay-tools/cezarion#1620.
export const doneErrorCodeSchema = z.enum([
  'workers_outstanding', 'workers_uncollected', 'worker_questions', 'human_question_pending', 'worker_wait_pending',
  'root_finish_pending', 'not_final_step', 'manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch', 'invalid_request',
  'unavailable',
]);
export type DoneErrorCode = z.infer<typeof doneErrorCodeSchema>;

const doneAccepted = {
  ok: z.literal(true),
  finishes: z.literal('at_turn_end'),
  open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
};

/** An accepted done finishes the task, or, in a workflow step that is not the last, completes that
 *  step and starts `next_step`, named as the run's rail names it (hearsay-tools/cezarion#1620). */
export const cezarDoneAnswerSchema = z.discriminatedUnion('ok', [
  z.discriminatedUnion('completes', [
    z.object({ ...doneAccepted, completes: z.literal('task') }).strict(),
    z.object({ ...doneAccepted, completes: z.literal('step'), next_step: z.string().min(1) }).strict(),
  ]),
  z.object({
    ok: z.literal(false),
    code: doneErrorCodeSchema,
    message,
    /** The workers that block the finish, and why each one does. */
    workers: z.array(z.object({
      worker_id: z.string(),
      reason: z.enum(['outstanding', 'uncollected', 'question']),
    }).strict()).max(64).optional(),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type CezarDoneAnswer = z.infer<typeof cezarDoneAnswerSchema>;

// ---- what the run is waiting on -----------------------------------------------------------

/**
 * The run's top open wait, by the spec's order: human > usage limit > workers > peers > PR > process
 * > timer. A summary field: lists and `deriveAttention` read it instead of the wait list.
 */
const waitingOnUnionSchema = z.discriminatedUnion('kind', [
  /** `shown` once the user sees the question (its `askSeq`): attention reads that as Needs you at
   *  any status, a wake turn's included (phase 4b, hearsay-tools/cezarion#1236). */
  z.object({ kind: z.literal('human'), shown: z.literal(true).optional() }),
  // `autoResumeAt` is free text on the record, so the instant it carries is too.
  z.object({ kind: z.literal('usage-limit'), at: z.string() }),
  /** The workers still owed an outcome, or the replies awaited; 0 when the row cannot count.
   *  `replies` when every open worker entry waits on request replies, so a summary, which carries
   *  no `waits`, can still say so (hearsay-tools/cezarion#1235). `peers` when one of those
   *  requests went to a peer task (hearsay-tools/cezarion#1995). */
  z.object({ kind: z.literal('workers'), count: z.number().int().nonnegative(), replies: z.literal(true).optional(), peers: z.literal(true).optional() }),
  /** The peer tasks the open peer waits name, counted once each (hearsay-tools/cezarion#1995). */
  z.object({ kind: z.literal('peers'), count: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('pr'),
    until: prWaitUntilSchema,
    waitId: z.uuid(),
    prUrl: ciPrIdentitySchema.shape.prUrl,
    repository: ciPrIdentitySchema.shape.repository,
    prNumber: ciPrIdentitySchema.shape.prNumber,
    deadline: z.iso.datetime(),
  }),
  /** A background command (hearsay-tools/cezarion#1446). */
  z.object({ kind: z.literal('process'), waitId: z.uuid(), pid: pidSchema, deadline: z.iso.datetime(), note: z.string().max(NOTE_MAX).optional() }),
  z.object({ kind: z.literal('timer'), waitId: z.uuid(), at: z.iso.datetime(), note: z.string().max(NOTE_MAX).optional() }),
]);
/** Stored summaries written before hearsay-tools/cezarion#1425 carry `{ kind: 'ci' }`: a checks wait. */
export const waitingOnSchema = z.preprocess(
  (value) => value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'ci' ? { ...value, kind: 'pr', until: 'checks' } : value,
  waitingOnUnionSchema,
);
export type WaitingOn = z.infer<typeof waitingOnSchema>;

/** Full records carry the full delegation state; summaries and index rows the slim projection. */
export type WaitingOnInput = Partial<Pick<RunRecord, 'status' | 'waits' | 'autoResumeAt'>> & {
  delegation?: DelegationState | RunDelegationSummary | undefined;
};

/**
 * A usage-limit hold (hearsay-tools/cezarion#1236): a `waiting` run with a booked resume time. It
 * holds no slot and no session, so the engine does not own it; its resume or the user's Continue
 * wakes it. The one definition every reader calls (hearsay-tools/cezarion#1496). It takes the
 * record, never a bare status, and the store clears the resume time on every write that leaves
 * `waiting`, so a resume time on any other run is stale and this reads it as no hold. It narrows
 * the time only, so a caller can still settle the hold to another status.
 */
export function isUsageLimitHold<T extends Partial<Pick<RunRecord, 'status' | 'autoResumeAt'>>>(
  run: T,
): run is T & { autoResumeAt: string } {
  return run.status === 'waiting' && run.autoResumeAt !== undefined;
}

/** The requests a root sent to peer tasks, read from its own ledger: a request wait on one of them
 *  is not a wait on workers (hearsay-tools/cezarion#1995). A summary's slim delegation has none. */
function peerRequestIds(delegation: WaitingOnInput['delegation']): Set<string> {
  const conversation = delegation?.role === 'root' && 'conversation' in delegation ? delegation.conversation : undefined;
  return new Set((conversation?.messages ?? []).filter((message) => message.relationship === 'peer' && message.kind === 'request').map((message) => message.id));
}

/** Ids a worker entry has not heard about yet, or requests without an outcome. */
function workerEntryOwed(wait: WorkerWaitEntry): number {
  if (wait.requestIds) {
    const answered = new Set(wait.requestOutcomes?.map((outcome) => outcome.requestId));
    return wait.requestIds.filter((id) => !answered.has(id)).length;
  }
  const reported = new Set(wait.outcomes?.map((outcome) => outcome.workerId));
  return wait.workerIds?.filter((id) => !reported.has(id)).length ?? 0;
}

/** The count over every open worker entry; undefined when there is none. */
function workersOwed(open: readonly Wait[]): number | undefined {
  const entries = open.filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
  if (!entries.length) return undefined;
  return entries.reduce((sum, wait) => sum + workerEntryOwed(wait), 0);
}

function earliest<T extends PrWaitEntry | TimerWaitEntry | ProcessWaitEntry>(waits: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const wait of waits) {
    if (!best || Date.parse(wait.deadline) < Date.parse(best.deadline)) best = wait;
  }
  return best;
}

/** Reads only `open` waits; among several of one kind the earliest deadline wins. */
export function computeWaitingOn(run: WaitingOnInput): WaitingOn | undefined {
  // `Array.isArray`: the cockpit also projects streamed records, whose shape only `id` was checked on.
  const open = (Array.isArray(run.waits) ? run.waits : []).filter((wait) => wait?.phase === 'open');
  const human = open.filter((wait) => wait.kind === 'human');
  if (human.length) return human.some((wait) => wait.askSeq !== undefined) ? { kind: 'human', shown: true } : { kind: 'human' };
  if (isUsageLimitHold(run)) return { kind: 'usage-limit', at: run.autoResumeAt };
  const workers = workersOwed(open);
  if (workers !== undefined) {
    const entries = open.filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
    const replies = entries.every((wait) => wait.requestIds !== undefined);
    const toPeers = peerRequestIds(run.delegation);
    const peers = replies && entries.some((wait) => wait.requestIds?.some((id) => toPeers.has(id)));
    return { kind: 'workers', count: workers, ...(replies ? { replies: true as const } : {}), ...(peers ? { peers: true as const } : {}) };
  }
  const peerWaits = open.filter((wait): wait is PeerWaitEntry => wait.kind === 'peer');
  if (peerWaits.length) return { kind: 'peers', count: new Set(peerWaits.flatMap((wait) => wait.peerIds)).size };
  const pr = earliest(open.filter((wait): wait is PrWaitEntry => wait.kind === 'pr'));
  if (pr) {
    return { kind: 'pr', until: pr.until, waitId: pr.id, prUrl: pr.prUrl, repository: pr.repository, prNumber: pr.prNumber, deadline: pr.deadline };
  }
  const process = earliest(open.filter((wait): wait is ProcessWaitEntry => wait.kind === 'process'));
  if (process) return { kind: 'process', waitId: process.id, pid: process.pid, deadline: process.deadline, ...(process.note === undefined ? {} : { note: process.note }) };
  const timer = earliest(open.filter((wait): wait is TimerWaitEntry => wait.kind === 'timer'));
  if (timer) return { kind: 'timer', waitId: timer.id, at: timer.deadline, ...(timer.note === undefined ? {} : { note: timer.note }) };
  return undefined;
}

/** Whether the run waits on the user: an open human wait (phase 4b, hearsay-tools/cezarion#1236). */
export function asksHuman(run: Pick<WaitingOnInput, 'waits'>): boolean {
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.kind === 'human' && wait.phase === 'open');
}

/** Whether a question waits on the user: an open human wait the agent opened, or one of Cezar's
 *  that carries a card (a worker's fallback question to its parent). Cezar's other waits
 *  (`no-wait`, `budget`, `completion`) wait for the user without a question. */
export function asksQuestion(run: Pick<WaitingOnInput, 'waits'>): boolean {
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.kind === 'human' && wait.phase === 'open' && (wait.source === 'agent' || !!wait.questions?.length));
}

/** A resolved wait is a wake owed to the agent: its result is in, its turn has not started.
 *  Rung 10 of the attention ladder ("waiting for capacity"); a summary carries it as
 *  `waitWakePending`. */
export function hasResolvedWait(run: { waitWakePending?: true | undefined } & Pick<WaitingOnInput, 'waits'>): boolean {
  if (run.waitWakePending) return true;
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.phase === 'resolved');
}

/** A summary's `waitingOn` when it has one; a full or stream-patched record computes it. */
export function resolveWaitingOn(run: { waitingOn?: WaitingOn | undefined } & WaitingOnInput): WaitingOn | undefined {
  return run.waitingOn ?? computeWaitingOn(run);
}

/**
 * A run's worker wait in the old `WorkerWait` shape, for views that still show one: the newest
 * open or owed `worker` entry the agent registered (hearsay-tools/cezarion#1235). Cezar's
 * completion wait has no deadline, which that shape requires, so it is not one
 * (hearsay-tools/cezarion#1301). An open entry reads `parked` once the run waits on it, unless a
 * pending question holds the run.
 */
export function workerWaitView(run: Partial<Pick<RunRecord, 'status' | 'waits' | 'delegation'>>): WorkerWait | undefined {
  const delegation = run.delegation;
  if (!delegation || delegation.role === 'invalid') return undefined;
  const entry = (run.waits ?? []).filter((wait): wait is DeadlinedWorkerWaitEntry => wait.kind === 'worker' && hasWorkerDeadline(wait) && (wait.phase === 'open' || wait.phase === 'resolved')).at(-1);
  if (!entry) return undefined;
  const legacy = workerWaitEntryToLegacy(entry);
  return entry.phase === 'open' && run.status === 'waiting' && !asksHuman(run) ? { ...legacy, phase: 'parked' } : legacy;
}

/** The newest open or owed deadline-less completion entry, which `workerWaitView` leaves out. */
export function completionWaitEntry(waits: readonly Wait[] | undefined, workerId?: string): WorkerWaitEntry | undefined {
  return (waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker' && wait.via === 'completion' && !hasWorkerDeadline(wait) &&
    (wait.phase === 'open' || wait.phase === 'resolved') && (workerId === undefined || !!wait.workerIds?.includes(workerId))).at(-1);
}

/**
 * Cezar's completion wait as inspection and the relationships view show it, read from the list
 * like `workerWaitView` (hearsay-tools/cezarion#1301): its phases map as the legacy shape's do.
 */
export function workerCompletionWaitProjection(entry: WorkerWaitEntry, run: Partial<Pick<RunRecord, 'status' | 'waits'>>): WorkerCompletionWait {
  const reason = entry.phase === 'cancelled' ? 'cancelled' : entry.phase === 'open' ? undefined : entry.result?.reason;
  const parked = entry.phase === 'open' && run.status === 'waiting' && !asksHuman(run);
  return {
    id: entry.id,
    via: 'completion',
    workerIds: entry.workerIds ?? [],
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    ...(entry.revisions?.length ? { revisions: entry.revisions } : {}),
    ...(reason === undefined ? {} : { reason }),
    phase: parked ? 'parked' : entry.phase === 'open' ? 'registered' : 'wake-pending',
    outcomes: entry.outcomes ?? [],
    wakeId: entry.wakeInputId ?? entry.id,
  };
}

/** A run's deadline-less completion wait in its projection, for the relationships view. */
export function completionWaitView(run: Partial<Pick<RunRecord, 'status' | 'waits' | 'delegation'>>): WorkerCompletionWait | undefined {
  if (run.delegation?.role !== 'root') return undefined;
  const entry = completionWaitEntry(run.waits);
  return entry ? workerCompletionWaitProjection(entry, run) : undefined;
}

/**
 * A worker wait as `cez worker wait` and `cez worker cancel-wait` answer it: the old
 * `WorkerWait` shape, whose wire stays unchanged (hearsay-tools/cezarion#1235). Open is
 * `registered`; every settled phase is `wake-pending` and the reason says how it ended.
 */
export function workerWaitEntryToLegacy(entry: DeadlinedWorkerWaitEntry): WorkerWait {
  const reason = entry.phase === 'cancelled' ? 'cancelled' : entry.phase === 'open' ? undefined : entry.result?.reason;
  return {
    id: entry.id,
    workerIds: entry.workerIds ?? [],
    ...(entry.requestIds === undefined ? {} : { requestIds: entry.requestIds }),
    ...(entry.requestOutcomes === undefined ? {} : { requestOutcomes: entry.requestOutcomes }),
    deadline: entry.deadline,
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    // An upgraded wait that never recorded revisions carries an empty list; the legacy shape had none.
    ...(entry.revisions?.length ? { revisions: entry.revisions } : {}),
    ...(reason === undefined ? {} : { reason }),
    phase: entry.phase === 'open' ? 'registered' : 'wake-pending',
    outcomes: entry.outcomes ?? [],
    wakeId: entry.wakeInputId ?? entry.id,
  };
}
