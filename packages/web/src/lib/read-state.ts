import type { RunSummary } from '@open-mercato/cezar-api-client'
import { isUsageLimitHold } from '@open-mercato/cezar-api-client/contract/waits'
import { canBeUnread as contractCanBeUnread, isUnread as contractIsUnread } from '@open-mercato/cezar-api-client/contract/run-predicates'
import type { ReadStateInput } from '@open-mercato/cezar-api-client'
export type { ReadStateInput } from '@open-mercato/cezar-api-client'
import { isOwnedWorker } from './task-groups'

/** The terminal statuses a *done item* can be — the sidebar's "Finished" set. */
const DONE_STATUSES: readonly RunSummary['status'][] = ['done', 'failed', 'cancelled']

/** A finished run — done, failed, or cancelled. These are the rows the read/unread treatment
 *  applies to (the "Finished" bucket); everything else carries its live attention signal instead. */
export function isDoneItem(status: RunSummary['status']): boolean {
  return DONE_STATUSES.includes(status)
}

/** Receipt-independent eligibility, shared with the store's mark-read sweep. */
export function canBeUnread(run: ReadStateInput): boolean {
  return contractCanBeUnread(run)
}

/** A finished eligible outcome not seen since it finished. */
export function isUnread(run: ReadStateInput): boolean {
  return contractIsUnread(run)
}

/**
 * A *read* done item: a finished row that is not unread — a done/failed run you have already
 * opened, or a cancelled run (never unread). This is what the treatment dims: the read history
 * steps back so the unread rows read at a glance. Non-finished rows are never "read" — they show
 * their live attention state, not a past outcome — so they are excluded here.
 */
export function isReadDoneItem(run: ReadStateInput): boolean {
  // A usage-limit hold has no history to dim: it is work with an appointment.
  if (isUsageLimitHold(run)) return false
  return isDoneItem(run.status) && !isUnread(run)
}

/** How many done items are unread — the Tasks nav badge's number. Archived runs are already
 *  excluded by `isUnread`, so this counts exactly the rows that wear the unread marker. */
export function unreadDoneCount(runs: readonly ReadStateInput[]): number {
  return runs.reduce((total, run) => (isOwnedWorker(run) || !isUnread(run) ? total : total + 1), 0)
}

/**
 * The unread marker's colour (#617): the run's OUTCOME, not a colour of its own. Violet now means
 * running, so a violet "unread" dot beside a finished run said the wrong thing; green for an
 * unread done run and red for an unread failed one repeat the outcome the marker is about.
 * Returned as a StatusDot tone name so this module stays UI-free.
 */
export function unreadMarkerTone(run: Pick<RunSummary, 'status'>): 'success' | 'danger' {
  return run.status === 'failed' ? 'danger' : 'success'
}
