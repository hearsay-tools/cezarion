import { isAutomationTask, type ArchiveFinishedScope, type RunRecord } from './runs.ts';
import { isUsageLimitHold } from './waits.ts';

/**
 * Facts about a run that the store, the server, the engine and the cockpit all decide on, each
 * defined once here so that no reader restates one in its own code (hearsay-tools/cezarion#1496).
 * Each takes the record, never a bare status, so no caller can miss a usage-limit hold
 * (hearsay-tools/cezarion#1434). `isUsageLimitHold` lives beside `computeWaitingOn` in `waits.ts`.
 */

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
