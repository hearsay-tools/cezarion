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
 * Persisted live predicate used for loading and recovery. The store separately adds pinned runs
 * and their families. Any change that alters stored answers requires a migration to recompute
 * the live column.
 */
export function isLiveRecord(run: RunRecord): boolean {
  if (LIVE_STATUSES.has(run.status)) return true;
  // Any resume time, not `isUsageLimitHold`: an older row can keep one on a finished status, and
  // the store's open must load that row to correct it.
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
 * Encode a record, its summary and all query columns for one upsert. data may include preserved
 * raw fields. Live process usage is attached by readers and is never persisted here.
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
