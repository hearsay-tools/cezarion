import { toRunSummary } from '@open-mercato/cezar-contract/runs';

import type { RunRowInput } from './run-database.ts';
// Type-only: the store imports this module, so a value import back would be a cycle.
import type { RunRecord } from './store.ts';

const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'waiting']);

/** Status-only live predicate: queued, running or waiting. */
export function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

/**
 * Whether this record says the run is still in motion (#779, Amendment 2 item 5): what puts a
 * row in the `live` column, so `RunStore.open` loads and recovers it, and what keeps a record in
 * the store's memory. True when any of these holds:
 * - its status is queued, running or waiting;
 * - a wait is open or resolved and not yet delivered (`waits`: a CI wait, a timer, a human question or a worker wait), or a
 *   usage-limit resume is pending (`autoResumeAt`);
 * - it waits on its delegation family: a parent on its workers, or a worker on its parent;
 * - an owned worker's destroy has not completed (its retry is pending);
 * - a root's Finish has not settled (`finishRequestedAt`). A waiting root is live anyway; a
 *   cancelled one is a snapshot older controllers left, which only the delegation sweep repairs
 *   (`commitRootFinishCancellation`), and until it does, Continue refuses the root and its workers;
 * - an accepted Stop has not settled yet (`stopping`). `reconcileLoadedRun` rewrites it, so open
 *   loads those rows and the next save persists the normalized record and its summary. A stored
 *   monitoring `activity` was read into the wait list on every read since store schema 4
 *   (`upgradeLegacyWaits`), so no decoded record carries one and phase 4b
 *   (hearsay-tools/cezarion#1236) dropped it from this predicate without a live recompute.
 *
 * Only what the record itself says. The store adds what a record cannot know: the runs a
 * RunManager pins, and their delegation families (see `RunStore`'s held set).
 *
 * The `live` column is computed when a row is written and never recomputed on read. Once a
 * release has shipped `runs.db`, changing this predicate needs a migration (`MIGRATIONS` in
 * run-database.ts) that recomputes `live` for every row; without one, a row keeps the old answer
 * until it is next written, and a run the new predicate calls live is never loaded or recovered.
 */
export function isLiveRecord(run: RunRecord): boolean {
  if (LIVE_STATUSES.has(run.status)) return true;
  if (run.autoResumeAt !== undefined || run.waits?.some((wait) => wait.phase === 'open' || wait.phase === 'resolved')) return true;
  // A worker wait, Cezar's completion wait included, is a list entry, covered above: store schema 7
  // reads every wait stored in the delegation state into the list on open, so none is left to ask about
  // (hearsay-tools/cezarion#1301), and every row the older predicate called live for one is read up
  // and rewritten by that open.
  if (run.delegation?.role === 'worker' && run.delegation.destroy !== undefined && run.delegation.destroy.phase !== 'complete') return true;
  if (run.delegation?.role === 'root' && run.delegation.finishRequestedAt !== undefined) return true;
  return run.stopping !== undefined;
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
 *
 * `data` defaults to the record itself. The store passes the record merged with what its stored
 * JSON held beyond the schema (`encodeRawRecord`, raw-record.ts), and the import passes the
 * record's original JSON, so a field this cezar does not know is never lost by a write.
 */
export function encodeRunRow(run: RunRecord, data: string = JSON.stringify(run)): RunRowInput {
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
    data,
    summary: JSON.stringify(toRunSummary(run)),
  };
}

/** The branch a run owns: its own, else the one an owned worker was planned with, else the task
 *  branch its worktree implies (`branchFor` in git-worktree.ts, which this module must not import:
 *  tests replace that module wholesale). */
function ownedBranch(run: RunRecord, plannedWorkerBranch: string | undefined): string | null {
  return run.branch ?? plannedWorkerBranch ?? (run.worktreePath !== undefined ? `cez/${run.id.slice(0, 8)}` : null);
}
