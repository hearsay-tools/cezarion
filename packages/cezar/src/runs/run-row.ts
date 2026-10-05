import { toRunSummary } from '@open-mercato/cezar-contract';

import type { RunRowInput } from './run-database.ts';
// Type-only: the store imports this module, so a value import back would be a cycle.
import type { RunRecord } from './store.ts';

const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'waiting']);

/**
 * Whether this record says the run is still in motion (#779, Amendment 2 item 5): what puts a
 * row in the `live` column, so `RunStore.open` loads and recovers it, and what keeps a record in
 * the store's memory. True when any of these holds:
 * - its status is queued, running or waiting;
 * - a wake is pending: a monitoring check (`monitoringWakeAt`), a usage-limit resume
 *   (`autoResumeAt`) or a CI wait (`ciWait`);
 * - it waits on its delegation family: a parent on its workers, or a worker on its parent;
 * - an owned worker's destroy has not completed (its retry is pending);
 * - a root's Finish has not settled (`finishRequestedAt`). A waiting root is live anyway; a
 *   cancelled one is a snapshot older controllers left, which only the delegation sweep repairs
 *   (`commitRootFinishCancellation`), and until it does, Continue refuses the root and its workers;
 * - an accepted Stop has not settled yet (`stopping`), or a monitoring `activity` is still on it.
 *   `reconcileLoadedRun` rewrites both, so open loads those rows and the next save persists the
 *   normalized record and its summary.
 *
 * Only what the record itself says. The store adds what a record cannot know: the runs a
 * RunManager pins, and their delegation families (see `RunStore`'s held set).
 */
export function isLiveRecord(run: RunRecord): boolean {
  if (LIVE_STATUSES.has(run.status)) return true;
  if (run.monitoringWakeAt !== undefined || run.autoResumeAt !== undefined || run.ciWait !== undefined) return true;
  if (run.delegation && run.delegation.role !== 'invalid' && run.delegation.wait !== undefined) return true;
  if (run.delegation?.role === 'worker' && run.delegation.destroy !== undefined && run.delegation.destroy.phase !== 'complete') return true;
  if (run.delegation?.role === 'root' && run.delegation.finishRequestedAt !== undefined) return true;
  return run.stopping !== undefined || run.activity !== undefined;
}

/**
 * The one place a run record becomes a database row (#779): the complete record as `data`, its
 * `toRunSummary()` projection as `summary` (the projection every list route reads, so a summary
 * has exactly one owner — Amendment 2 of the #779 plan), and the columns the store queries
 * without decoding either. Every column is computed here, in the same upsert as `data`, so a row
 * never disagrees with its own columns.
 *
 * `summary` carries everything derivable from the record. The live `usage` sample the list routes
 * attach is not: it describes a process, not the run, and is never persisted.
 */
export function encodeRunRow(run: RunRecord): RunRowInput {
  const worker = run.delegation?.role === 'worker' ? run.delegation : undefined;
  return {
    id: run.id,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    status: run.status,
    archived: run.archived,
    live: isLiveRecord(run),
    parentRunId: worker ? worker.parentRunId : null,
    clientRequestId: run.clientRequestId ?? null,
    groupId: run.groupId ?? null,
    // Materialized only: retention reclaims the directory and keeps the path on the record.
    worktreePath: run.worktreePath !== undefined && run.worktreeReclaimedAt === undefined ? run.worktreePath : null,
    branch: ownedBranch(run, worker?.workspace.branch),
    baseBranch: run.baseBranch ?? null,
    data: JSON.stringify(run),
    summary: JSON.stringify(toRunSummary(run)),
  };
}

/** The branch a run owns: its own, else the one an owned worker was planned with, else the task
 *  branch its worktree implies (`branchFor` in git-worktree.ts, which this module must not import:
 *  tests replace that module wholesale). */
function ownedBranch(run: RunRecord, plannedWorkerBranch: string | undefined): string | null {
  return run.branch ?? plannedWorkerBranch ?? (run.worktreePath !== undefined ? `cez/${run.id.slice(0, 8)}` : null);
}
