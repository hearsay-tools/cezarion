import { isAutomationTask, type ArchiveFinishedScope, type RunRecord } from './runs.ts';
import { isUsageLimitHold } from './waits.ts';

/**
 * Facts about a run that the store, the server, the engine and the cockpit all decide on, each
 * defined once here so that no reader restates one in its own code (hearsay-tools/cezarion#1496).
 * Each takes the record, never a bare status, so no caller can miss a usage-limit hold
 * (hearsay-tools/cezarion#1434). `isUsageLimitHold` lives beside `computeWaitingOn` in `waits.ts`.
 */

const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'waiting']);

/** Status-only live predicate: queued, running or waiting. */
export function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

type OwnershipInput = Pick<RunRecord, 'status'> & Partial<Pick<RunRecord, 'autoResumeAt'>>;

/**
 * The engine still owns the run: queued (parked but claimed), running or waiting. A usage-limit
 * hold is `waiting` with no session (hearsay-tools/cezarion#1236): the engine has let go of it
 * until its resume, so it keeps a closed run's controls. `review` is not owned: a parked review
 * can be continued, archived or deleted like any finished run.
 */
export function engineOwnsRun(run: OwnershipInput): boolean {
  if (isUsageLimitHold(run)) return false;
  return run.status === 'queued' || run.status === 'running' || run.status === 'waiting';
}

/** A live agent session owns the run: the engine owns it and it has left the line. */
export function isSessionOpen(run: OwnershipInput): boolean {
  return engineOwnsRun(run) && run.status !== 'queued';
}

/** What the archive sweep reads. The store passes records and summaries, the cockpit summaries. */
export type SweepInput = Pick<RunRecord, 'archived' | 'status'> & Partial<Pick<RunRecord, 'pinned'>> & {
  delegation?: { role?: string } | null | undefined;
  automationId?: string | undefined;
};

/**
 * The bulk-archive sweep's one predicate (hearsay-tools/cezarion#780, `POST /runs/archive-finished`): finished (a
 * usage-limit hold is `waiting`, hearsay-tools/cezarion#1236), not archived, not an owned worker
 * (those leave with their parent), in the tab `automation` names when given, then filtered by pin
 * state (`scope` absent = both).
 */
export function isSweepable(run: SweepInput, scope?: ArchiveFinishedScope, automation?: boolean): boolean {
  if (run.archived || !(run.status === 'done' || run.status === 'failed' || run.status === 'cancelled')) return false;
  if (run.delegation?.role === 'worker') return false;
  if (automation !== undefined && isAutomationTask(run) !== automation) return false;
  if (scope === 'unpinned') return !run.pinned;
  if (scope === 'pinned') return run.pinned === true;
  return true;
}

/** The subset that can carry an *unread* marker. Cancelled is excluded on purpose: you stopped
 *  the run yourself, so there is nothing you "haven't seen". */
const UNREAD_ELIGIBLE: readonly RunRecord['status'][] = ['done', 'failed'];

/** What the read/unread rule reads — `Pick`ed (like `AttentionInput`) so a test or a partial
 *  record can call it without a full `RunRecord`. */
export type ReadStateInput = Pick<
  RunRecord,
  'status' | 'finishedAt' | 'seenAt' | 'archived' | 'autoResumeAt'
> & { delegation?: { role?: string } | null | undefined };

/**
 * Whether a run is *eligible* to wear the unread marker at all — the receipt-independent half
 * of `isUnread`:
 *  - only `done`/`failed` runs qualify (cancelled is self-initiated, so never unread);
 *  - a usage-limit hold (`isUsageLimitHold`, spec 2026-08-03-auto-resume-after-usage-limit) is
 *    not a done item at all: it has an appointment to pick the work back up, so there is no
 *    outcome to have missed yet, and it can neither wear the marker nor be put back into it;
 *  - it must actually have finished (`finishedAt`) — a record caught mid-transition is not yet
 *    a done item;
 *  - archived runs are never unread: archiving is a stronger "I'm done with this" than reading.
 *
 * Split out (hearsay-tools/cezarion#775) because "Mark unread" needs exactly this question minus the receipt: the
 * action is offered for a run that is currently read AND *could* be unread, which is
 * `canBeUnread(run) && !isUnread(run)`. `isReadDoneItem` cannot answer it — that one is true
 * for cancelled and archived rows too, neither of which can ever go unread. Exported rather
 * than restated in `run-actions.ts` so the eligibility rule keeps exactly one definition.
 */
export function canBeUnread(run: ReadStateInput): boolean {
  if (run.archived) return false;
  if (isUsageLimitHold(run)) return false;
  if (!UNREAD_ELIGIBLE.includes(run.status)) return false;
  return run.finishedAt !== undefined;
}

/**
 * Whether a done item is *unread*: a finished run you have not opened since it finished.
 *
 * Eligible (`canBeUnread` above) and unread until seen SINCE it finished. Comparing
 * `seenAt < finishedAt` (not merely "has a receipt") is what makes a resumed-and-re-finished
 * run go unread again for free — its `finishedAt` moves past the old receipt. An explicit
 * "Mark unread" (hearsay-tools/cezarion#775) takes the other road: it *clears* the receipt, and an absent one is
 * unread by this same clause.
 *
 * ISO-8601 strings compare lexicographically because every timestamp cezar writes is UTC
 * (`toISOString()` → trailing `Z`), so `<` on the strings is `<` on the instants.
 */
export function isUnread(run: ReadStateInput): boolean {
  // Read into a local so the narrowing survives the `canBeUnread` call, which checks the same
  // clause but cannot narrow the caller's field.
  const finishedAt = run.finishedAt;
  if (finishedAt === undefined) return false;
  if (!canBeUnread(run)) return false;
  return run.seenAt === undefined || run.seenAt < finishedAt;
}

/** History retention excludes live tasks, delegation families and pinned runs. */
export function isRetentionCandidate(run: Pick<RunRecord, 'status' | 'delegation' | 'pinned'>): boolean {
  return !isLiveStatus(run.status) && !run.delegation && !run.pinned;
}

/** Whether a record names a referenced PR or issue; repository scoping remains separate. */
export function hasReferencedRun(run: Pick<RunRecord, 'referencedPullRequestUrl' | 'referencedIssueUrl'>): boolean {
  return run.referencedPullRequestUrl !== undefined || run.referencedIssueUrl !== undefined;
}

/** SQL prefilters may admit extra rows; matches re-checks the decoded record or summary. */
export const UNREAD_RUN_RULE = {
  sql: "archived = 0 AND status IN ('done', 'failed') AND finished_at IS NOT NULL" +
    " AND (json_extract(summary, '$.seenAt') IS NULL OR json_extract(summary, '$.seenAt') < finished_at)",
  matches: isUnread,
};

export const SWEEPABLE_RUN_RULE = {
  sql: "archived = 0 AND status IN ('done', 'failed', 'cancelled') AND parent_run_id IS NULL",
  matches: isSweepable,
};

// Retention's cold path currently only re-checks archived after decode; kept pending a behavior decision.
export const RETENTION_RUN_RULE = {
  sql: "id IN (SELECT value FROM json_each(?)) AND status NOT IN ('queued', 'running', 'waiting')" +
    " AND parent_run_id IS NULL AND json_extract(summary, '$.delegation') IS NULL" +
    " AND json_extract(summary, '$.pinned') IS NOT 1",
  matches: isRetentionCandidate,
};

export const REFERENCED_RUN_RULE = {
  sql: "json_extract(summary, '$.referencedPullRequestUrl') IS NOT NULL OR json_extract(summary, '$.referencedIssueUrl') IS NOT NULL",
  matches: hasReferencedRun,
};
