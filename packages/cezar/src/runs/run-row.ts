import { toRunSummary } from '@open-mercato/cezar-contract';

import type { RunRowInput } from './run-database.ts';
// Type-only: the store imports this module, so a value import back would be a cycle.
import type { RunRecord } from './store.ts';

/**
 * The one place a run record becomes a database row (#779): the complete record as `data`, its
 * `toRunSummary()` projection as `summary` (the projection every list route reads, so a summary
 * has exactly one owner — Amendment 2 of the #779 plan), and the columns the store queries
 * without decoding either.
 *
 * `summary` carries everything derivable from the record. The live `usage` sample the list routes
 * attach is not: it describes a process, not the run, and is never persisted.
 */
export function encodeRunRow(run: RunRecord): RunRowInput {
  return {
    id: run.id,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    status: run.status,
    archived: run.archived,
    parentRunId: run.delegation?.role === 'worker' ? run.delegation.parentRunId : null,
    wakeAt: earliestWake(run),
    data: JSON.stringify(run),
    summary: JSON.stringify(toRunSummary(run)),
  };
}

/** The earliest deadline at which this run wakes on its own: a monitoring check or a usage-limit
 *  resume. Both are `toISOString()` instants, so the string order is the time order. */
function earliestWake(run: RunRecord): string | null {
  const wakes = [run.monitoringWakeAt, run.autoResumeAt].filter((at): at is string => at !== undefined);
  return wakes.length === 0 ? null : wakes.sort()[0]!;
}
