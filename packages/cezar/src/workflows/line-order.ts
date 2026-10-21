/**
 * The line for a regular slot (spec 2026-10-17-unified-waits § Slots and the line,
 * hearsay-tools/cezarion#1236).
 *
 * Two classes, in this order:
 *  1. wakes of runs already in progress — a queued wait wake, and every queued continuation
 *     (a scheduler continuation that reopens a closed session, a usage-limit resume, a Continue),
 *     and a queued owned worker (its family's work in progress, joined at its creation), first
 *     come first served by when the wake joined the line;
 *  2. runs that have not started, first come first served in queue order.
 *
 * An entry that cannot leave the line now (no capacity, an account on a usage-limit hold, a
 * cleanup or a pending finish) keeps its place, and the next eligible entry is taken.
 *
 * Returns the queue index of the entry to take, or -1 when none can leave.
 */
export function nextLineEntry(
  queue: readonly string[],
  wakeJoinedAt: (runId: string) => number | undefined,
  eligible: (runId: string) => boolean,
): number {
  let wake = -1;
  let wakeAt = Number.POSITIVE_INFINITY;
  let unstarted = -1;
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    const joined = wakeJoinedAt(id);
    if (joined === undefined ? unstarted >= 0 : joined >= wakeAt) continue;
    if (!eligible(id)) continue;
    if (joined === undefined) unstarted = index;
    else { wake = index; wakeAt = joined; }
  }
  return wake >= 0 ? wake : unstarted;
}
