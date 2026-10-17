import { z } from 'zod';
import { ciPrIdentitySchema, ciPrUrlSchema, ciWaitErrorCodeSchema, ciWaitRequestSchema, ciWaitResultSchema } from './ci-wait.ts';
import type { DelegationState, RunDelegationSummary } from './delegation.ts';
import type { RunRecord } from './runs.ts';

/**
 * The wait list (spec `.ai/specs/2026-10-17-unified-waits.md`; phase 1 is
 * hearsay-tools/cezarion#1233). A run holds its open and recently settled waits in
 * `RunRecord.waits`; the agent opens one with `cezar_wait` and closes it with
 * `cezar_cancel_wait`. A wait ends only when its own event fires, its deadline passes, or someone
 * cancels it. Phase 1 carries the `ci` and `timer` kinds; human and worker waits keep their own
 * mechanisms (`hasPendingHumanAsk`, `delegation.wait`) until phases 2 and 3, and
 * `computeWaitingOn` reads those here so `waitingOn` already follows the spec's order.
 */

export const WAIT_LIMIT = 16;
export const LAST_WAITS_LIMIT = 16;
export const TIMER_MIN_SECONDS = 60;
export const TIMER_MAX_SECONDS = 7200;
const NOTE_MAX = 512;

/** `open` → `resolved` (its event fired or its deadline passed) → `delivered`, or `cancelled`. */
export const waitPhaseSchema = z.enum(['open', 'resolved', 'delivered', 'cancelled']);
export type WaitPhase = z.infer<typeof waitPhaseSchema>;
/** What opened the wait: the tool itself, or one of the aliases that map into the same list. */
export const waitViaSchema = z.enum(['cezar_wait', 'cezar_wait_for_ci', 'monitoring-line', 'schedule-wakeup']);
export type WaitVia = z.infer<typeof waitViaSchema>;

const waitBaseShape = {
  id: z.uuid(),
  source: z.enum(['agent', 'cezar']),
  via: waitViaSchema,
  registeredAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  phase: waitPhaseSchema,
  resolvedAt: z.iso.datetime().optional(),
  deliveredAt: z.iso.datetime().optional(),
  cancelledAt: z.iso.datetime().optional(),
  turnId: z.string().min(1).max(256),
};

export const ciWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('ci'),
  ...ciPrIdentitySchema.shape,
  generation: z.string().min(1).max(256),
  timeoutSeconds: z.number().int().min(1).max(7200),
  result: ciWaitResultSchema.optional(),
}).strict();
export type CiWaitEntry = z.infer<typeof ciWaitEntrySchema>;

export const timerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('timer'),
  seconds: z.number().int().min(TIMER_MIN_SECONDS).max(TIMER_MAX_SECONDS),
  note: z.string().max(NOTE_MAX).optional(),
}).strict();
export type TimerWaitEntry = z.infer<typeof timerWaitEntrySchema>;

export const waitSchema = z.discriminatedUnion('kind', [ciWaitEntrySchema, timerWaitEntrySchema]);
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

/** One still-open wait as both tools list it back to the agent. */
export const openWaitSchema = z.object({
  wait_id: z.uuid(),
  kind: z.enum(['ci', 'timer']),
  deadline: z.iso.datetime(),
  summary: z.string().max(256),
}).strict();
export type OpenWait = z.infer<typeof openWaitSchema>;

export const waitErrorCodeSchema = z.enum([...ciWaitErrorCodeSchema.options, 'timers_disabled', 'wake_budget_spent']);
export type WaitErrorCode = z.infer<typeof waitErrorCodeSchema>;

const message = z.string().max(4096);

export const cezarWaitAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    wait_id: z.uuid(),
    kind: openWaitSchema.shape.kind,
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

/** `already_resolved`: the result is owed and arrives with the next wake; cancelling is a no-op. */
export const cezarCancelWaitAnswerSchema = z.discriminatedUnion('cancelled', [
  z.object({
    cancelled: z.literal(true),
    wait_id: z.uuid(),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
  }).strict(),
  z.object({
    cancelled: z.literal(false),
    code: z.enum(['not_found', 'already_resolved', 'invalid_request', 'unavailable']),
    message,
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type CezarCancelWaitAnswer = z.infer<typeof cezarCancelWaitAnswerSchema>;

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

function earliest<T extends Wait>(waits: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const wait of waits) {
    if (!best || Date.parse(wait.deadline) < Date.parse(best.deadline)) best = wait;
  }
  return best;
}

/** Reads only `open` waits; among several of one kind the earliest deadline wins. */
export function computeWaitingOn(run: WaitingOnInput): WaitingOn | undefined {
  if (run.hasPendingHumanAsk) return { kind: 'human' };
  if (run.autoResumeAt) return { kind: 'usage-limit', at: run.autoResumeAt };
  const workers = workersOwed(run.delegation);
  if (workers !== undefined) return { kind: 'workers', count: workers };
  // `Array.isArray`: the cockpit also projects streamed records, whose shape only `id` was checked on.
  const open = (Array.isArray(run.waits) ? run.waits : []).filter((wait) => wait?.phase === 'open');
  const ci = earliest(open.filter((wait): wait is CiWaitEntry => wait.kind === 'ci'));
  if (ci) {
    return { kind: 'ci', waitId: ci.id, prUrl: ci.prUrl, repository: ci.repository, prNumber: ci.prNumber, deadline: ci.deadline };
  }
  const timer = earliest(open.filter((wait): wait is TimerWaitEntry => wait.kind === 'timer'));
  if (timer) return { kind: 'timer', waitId: timer.id, at: timer.deadline, ...(timer.note === undefined ? {} : { note: timer.note }) };
  return undefined;
}

/** A summary's `waitingOn` when it has one; a full or stream-patched record computes it. */
export function resolveWaitingOn(run: { waitingOn?: WaitingOn } & WaitingOnInput): WaitingOn | undefined {
  return run.waitingOn ?? computeWaitingOn(run);
}
