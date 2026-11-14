/** What branch cleanup and git-log attribution read about each run (`RunStore.listBranchOwners`). */
import type { RunRecord, RunStatus } from '@open-mercato/cezar-contract';
import type { BranchOwnerRow } from './run-database.ts';
import { encodeRunRow, isEndedRoot, isLiveRecord } from './run-row.ts';
import { parseStoredSummary } from './run-summary-page.ts';

/** What branch cleanup and git-log attribution read about a run (`RunStore.listBranchOwners`). */
export interface BranchOwner {
  id: string;
  title: string;
  status: RunStatus;
  archived: boolean;
  createdAt: string;
  /** The branch the run owns (see `encodeRunRow`); absent for a run listed for its PR alone. */
  branch?: string;
  baseBranch?: string;
  pullRequestUrl?: string;
  /** A settled owned worker whose family has ended (hearsay-tools/squawk#911): its root is
   *  archived and settled and no member is live. Its receipt alone no longer keeps its branch in use. */
  endedWorker?: true;
  /** A worker's parent task. */
  parentRunId?: string;
}

const SETTLED_WORKER: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled', 'review']);

/** The parent of a worker that may end with its family: settled, not live, no destroy recorded. */
function settledWorkerParent(run: Pick<RunRecord, 'status'> & { delegation?: { role?: string; parentRunId?: string; destroy?: unknown } | null | undefined }): string | undefined {
  const delegation = run.delegation;
  return delegation?.role === 'worker' && !delegation.destroy && SETTLED_WORKER.has(run.status) ? delegation.parentRunId : undefined;
}

/** A record as a branch owner, or undefined when it owns no branch and created no PR: the
 *  projection `listBranchOwners` reads off a row's summary and columns, computed from memory. */
export function branchOwnerOf(run: RunRecord): BranchOwner | undefined {
  const branch = encodeRunRow(run).branch;
  if (!branch && run.pullRequestUrl === undefined) return undefined;
  return {
    id: run.id, title: run.title, status: run.status, archived: run.archived, createdAt: run.createdAt,
    ...(branch ? { branch } : {}),
    ...(run.baseBranch === undefined ? {} : { baseBranch: run.baseBranch }),
    ...(run.pullRequestUrl === undefined ? {} : { pullRequestUrl: run.pullRequestUrl }),
    ...(run.delegation?.role === 'worker' ? { parentRunId: run.delegation.parentRunId } : {}),
  };
}

/** A stored row as a branch owner: its summary and columns, no record decoded. */
function branchOwnerOfRow(row: BranchOwnerRow, summary: ReturnType<typeof parseStoredSummary>): BranchOwner {
  return {
    id: row.id, createdAt: row.createdAt, status: row.status as RunStatus, archived: row.archived,
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.baseBranch === null ? {} : { baseBranch: row.baseBranch }),
    title: summary?.title ?? row.id,
    ...(summary?.pullRequestUrl === undefined ? {} : { pullRequestUrl: summary.pullRequestUrl }),
    ...(summary?.delegation?.role === 'worker' ? { parentRunId: summary.delegation.parentRunId } : {}),
  };
}

/**
 * The branch owners of the stored `rows` (rows no held run replaces) and of the `held` runs, which
 * answer from memory. A settled worker is marked `endedWorker` once its root is archived and settled
 * and no worker of the family is live: live runs are all held. `getRun` finds a root.
 */
export function listBranchOwners(rows: readonly BranchOwnerRow[], held: readonly RunRecord[],
  getRun: (id: string) => RunRecord | undefined): BranchOwner[] {
  const owners = new Map<string, BranchOwner>();
  const parents = new Map<string, string>();
  for (const row of rows) {
    const summary = parseStoredSummary(row.summary);
    const parent = summary && settledWorkerParent({ status: row.status as RunStatus, delegation: summary.delegation });
    if (parent) parents.set(row.id, parent);
    owners.set(row.id, branchOwnerOfRow(row, summary));
  }
  for (const run of held) {
    const owner = branchOwnerOf(run);
    if (!owner) continue;
    owners.set(run.id, owner);
    const parent = isLiveRecord(run) ? undefined : settledWorkerParent(run);
    if (parent) parents.set(run.id, parent);
  }
  const live = new Set(held.flatMap((run) => isLiveRecord(run) && run.delegation?.role === 'worker' ? [run.delegation.parentRunId] : []));
  const ended = new Map<string, boolean>();
  for (const [id, parent] of parents) {
    if (!ended.has(parent)) { const root = getRun(parent); ended.set(parent, !!root && isEndedRoot(root) && !live.has(parent)); }
    if (ended.get(parent)) owners.get(id)!.endedWorker = true;
  }
  return [...owners.values()];
}
