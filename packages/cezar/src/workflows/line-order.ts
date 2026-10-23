/**
 * Select the oldest eligible wake before unstarted work, then preserve queue order. Ineligible
 * entries retain their place. Return the selected queue index or -1.
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
