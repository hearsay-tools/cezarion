import { z } from 'zod';
import { askRequestSchema } from './ask-schema.ts';
import { ciPrIdentitySchema, ciPrUrlSchema, ciWaitErrorCodeSchema, ciWaitRequestSchema, ciWaitResultSchema } from './ci-wait.ts';
import type { DelegationState, RunDelegationSummary } from './delegation.ts';
import type { RunRecord } from './runs.ts';

/**
 * The wait list (spec `.ai/specs/2026-10-17-unified-waits.md`; phase 1 is
 * hearsay-tools/cezarion#1233). A run holds its open and recently settled waits in
 * `RunRecord.waits`; the agent opens one with `cezar_wait` and closes it with
 * `cezar_cancel_wait`. A wait ends only when its own event fires, its deadline passes, or someone
 * cancels it. Phase 1 carries the `ci` and `timer` kinds; phase 2 (hearsay-tools/cezarion#1234)
 * adds `human`, which the agent opens with `cezar_ask` and which has no deadline: it ends when
 * the user answers or the agent cancels it.
 * Worker waits keep `delegation.wait` until phase 3, and `computeWaitingOn` reads it here so
 * `waitingOn` already follows the spec's order.
 */

export const WAIT_LIMIT = 16;
export const LAST_WAITS_LIMIT = 16;
export const TIMER_MIN_SECONDS = 60;
export const TIMER_MAX_SECONDS = 7200;
const NOTE_MAX = 512;

/** `open` → `resolved` (its event fired or its deadline passed) → `delivered`, or `cancelled`. */
export const waitPhaseSchema = z.enum(['open', 'resolved', 'delivered', 'cancelled']);
export type WaitPhase = z.infer<typeof waitPhaseSchema>;
/** What opened the wait: the tool itself, or one of the aliases that map into the same list.
 *  `no-wait` is the human wait cezar opens when a nudged turn still ends without one; `budget`
 *  is the one it opens when the automatic-wake budget is spent. */
export const waitViaSchema = z.enum([
  'cezar_wait', 'cezar_wait_for_ci', 'cezar_ask', 'monitoring-line', 'schedule-wakeup', 'ask-line', 'native-ask', 'no-wait', 'budget',
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

export const ciWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('ci'),
  deadline: z.iso.datetime(),
  ...ciPrIdentitySchema.shape,
  generation: z.string().min(1).max(256),
  timeoutSeconds: z.number().int().min(1).max(7200),
  result: ciWaitResultSchema.optional(),
}).strict();
export type CiWaitEntry = z.infer<typeof ciWaitEntrySchema>;

export const timerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('timer'),
  deadline: z.iso.datetime(),
  seconds: z.number().int().min(TIMER_MIN_SECONDS).max(TIMER_MAX_SECONDS),
  note: z.string().max(NOTE_MAX).optional(),
}).strict();
export type TimerWaitEntry = z.infer<typeof timerWaitEntrySchema>;

/** The user. `questions` is the card the agent asked with, absent for a plain "your turn";
 *  `askSeq` is the event cezar showed it as, once the turn ended: its `ask.requested`, the human
 *  gate a wait without a card raises, or the note that shows Cezar's own wait. */
export const humanWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('human'),
  questions: askRequestSchema.shape.questions.optional(),
  askSeq: z.number().int().nonnegative().optional(),
}).strict();
export type HumanWaitEntry = z.infer<typeof humanWaitEntrySchema>;

export const waitSchema = z.discriminatedUnion('kind', [ciWaitEntrySchema, timerWaitEntrySchema, humanWaitEntrySchema]);
export type Wait = z.infer<typeof waitSchema>;

// ---- the tools ----------------------------------------------------------------------------

/** `cezar_wait`. The `ci` branch keeps `cezar_wait_for_ci`'s bounds and default. */
export const cezarWaitRequestSchema = z.discriminatedUnion('kind', [
  ciWaitRequestSchema.extend({ kind: z.literal('ci') }).strict(),
  z.object({
    kind: z.literal('timer'),
    seconds: z.number().int().min(TIMER_MIN_SECONDS).max(TIMER_MAX_SECONDS),
    note: z.string().max(NOTE_MAX).optional(),
  }).strict(),
]);
export type CezarWaitRequest = z.infer<typeof cezarWaitRequestSchema>;

export const cezarCancelWaitRequestSchema = z.object({ wait_id: z.uuid() }).strict();
export type CezarCancelWaitRequest = z.infer<typeof cezarCancelWaitRequestSchema>;

/** One still-open wait as both tools list it back to the agent. A CI or timer wait carries its
 *  deadline; a human wait has none. */
const openWaitFields = { wait_id: z.uuid(), summary: z.string().max(256) };
export const openWaitSchema = z.discriminatedUnion('kind', [
  z.object({ ...openWaitFields, kind: z.enum(['ci', 'timer']), deadline: z.iso.datetime() }).strict(),
  z.object({ ...openWaitFields, kind: z.literal('human') }).strict(),
]);
export type OpenWait = z.infer<typeof openWaitSchema>;

export const waitErrorCodeSchema = z.enum([...ciWaitErrorCodeSchema.options, 'timers_disabled', 'wake_budget_spent']);
export type WaitErrorCode = z.infer<typeof waitErrorCodeSchema>;

/** The bound on every wait and done refusal's `message`; the run manager fits its own to it. */
export const WAIT_MESSAGE_MAX = 4096;
const message = z.string().max(WAIT_MESSAGE_MAX);

export const cezarWaitAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    wait_id: z.uuid(),
    kind: z.enum(['ci', 'timer']),
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
 */
export const cezarAskRequestSchema = askRequestSchema;
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

export const doneErrorCodeSchema = z.enum([
  'workers_outstanding', 'workers_uncollected', 'worker_questions', 'human_question_pending', 'worker_wait_pending',
  'root_finish_pending', 'not_final_step', 'manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch', 'invalid_request',
  'unavailable',
]);
export type DoneErrorCode = z.infer<typeof doneErrorCodeSchema>;

export const cezarDoneAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    finishes: z.literal('at_turn_end'),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
  }).strict(),
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
 * The run's top open wait, by the spec's order: human > usage limit > workers > CI > timer.
 * A summary field: lists and `deriveAttention` read it instead of the wait list.
 */
export const waitingOnSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }),
  // `autoResumeAt` is free text on the record, so the instant it carries is too.
  z.object({ kind: z.literal('usage-limit'), at: z.string() }),
  /** The workers still owed an outcome, or the replies awaited; 0 when the row cannot count. */
  z.object({ kind: z.literal('workers'), count: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('ci'),
    waitId: z.uuid(),
    prUrl: ciPrIdentitySchema.shape.prUrl,
    repository: ciPrIdentitySchema.shape.repository,
    prNumber: ciPrIdentitySchema.shape.prNumber,
    deadline: z.iso.datetime(),
  }),
  z.object({ kind: z.literal('timer'), waitId: z.uuid(), at: z.iso.datetime(), note: z.string().max(NOTE_MAX).optional() }),
]);
export type WaitingOn = z.infer<typeof waitingOnSchema>;

/** Full records carry the full delegation state; summaries and index rows the slim projection. */
export type WaitingOnInput = Partial<Pick<RunRecord, 'waits' | 'hasPendingHumanAsk' | 'autoResumeAt'>> & {
  delegation?: DelegationState | RunDelegationSummary;
};

function workersOwed(delegation: WaitingOnInput['delegation']): number | undefined {
  if (!delegation || delegation.role === 'invalid' || !delegation.wait) return undefined;
  const wait = delegation.wait;
  // `wake-pending` means its workers settled and only the wake is left: no longer open.
  if (wait.phase !== 'registered' && wait.phase !== 'parked') return undefined;
  if (wait.requestIds?.length) return wait.requestIds.length;
  const workerIds = 'workerIds' in wait ? wait.workerIds : undefined;
  const outcomes = 'outcomes' in wait ? wait.outcomes : undefined;
  const reported = new Set(outcomes?.map((outcome) => outcome.workerId));
  return workerIds?.filter((id) => !reported.has(id)).length ?? 0;
}

function earliest<T extends CiWaitEntry | TimerWaitEntry>(waits: readonly T[]): T | undefined {
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
  if (run.hasPendingHumanAsk || open.some((wait) => wait.kind === 'human')) return { kind: 'human' };
  if (run.autoResumeAt) return { kind: 'usage-limit', at: run.autoResumeAt };
  const workers = workersOwed(run.delegation);
  if (workers !== undefined) return { kind: 'workers', count: workers };
  const ci = earliest(open.filter((wait): wait is CiWaitEntry => wait.kind === 'ci'));
  if (ci) {
    return { kind: 'ci', waitId: ci.id, prUrl: ci.prUrl, repository: ci.repository, prNumber: ci.prNumber, deadline: ci.deadline };
  }
  const timer = earliest(open.filter((wait): wait is TimerWaitEntry => wait.kind === 'timer'));
  if (timer) return { kind: 'timer', waitId: timer.id, at: timer.deadline, ...(timer.note === undefined ? {} : { note: timer.note }) };
  return undefined;
}

/** A resolved wait is a wake owed to the agent: its result is in, its turn has not started.
 *  Rung 10 of the attention ladder ("waiting for capacity"); a summary carries it as
 *  `waitWakePending`. */
export function hasResolvedWait(run: { waitWakePending?: true } & Pick<WaitingOnInput, 'waits'>): boolean {
  if (run.waitWakePending) return true;
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.phase === 'resolved');
}

/** A summary's `waitingOn` when it has one; a full or stream-patched record computes it. */
export function resolveWaitingOn(run: { waitingOn?: WaitingOn } & WaitingOnInput): WaitingOn | undefined {
  return run.waitingOn ?? computeWaitingOn(run);
}
