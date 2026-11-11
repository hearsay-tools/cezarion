import type { RunRecord } from './runs.ts';

/**
 * A usage-limit hold (hearsay-tools/cezarion#1236): a `waiting` run with a booked resume time. It
 * holds no slot and no session, so the engine does not own it; its resume or the user's Continue
 * wakes it. The one definition every reader calls (hearsay-tools/cezarion#1496). It takes the
 * record, never a bare status, and the store clears the resume time on every write that leaves
 * `waiting`, so a resume time on any other run is stale and this reads it as no hold. It narrows
 * the time only, so a caller can still settle the hold to another status.
 *
 * This module has no runtime imports: `vitest.setup.ts` loads it through `run-exits.ts`, so every
 * cezar test loads it (hearsay-tools/cezarion#3241). `waits.ts` re-exports it.
 */
export function isUsageLimitHold<T extends Partial<Pick<RunRecord, 'status' | 'autoResumeAt'>>>(
  run: T,
): run is T & { autoResumeAt: string } {
  return run.status === 'waiting' && run.autoResumeAt !== undefined;
}
