import type { StatementSync } from 'node:sqlite';
import type { RunRow } from './run-database.ts';

type SqlRow = Record<string, unknown>;
export function toRunRow(row: SqlRow): RunRow {
  return {
    seq: row.seq as number,
    id: row.id as string,
    createdAt: row.created_at as string,
    finishedAt: row.finished_at as string | null,
    status: row.status as string,
    archived: row.archived === 1,
    live: row.live === 1,
    parentRunId: row.parent_run_id as string | null,
    clientRequestId: row.client_request_id as string | null,
    groupId: row.group_id as string | null,
    worktreePath: row.worktree_path as string | null,
    branch: row.branch as string | null,
    baseBranch: row.base_branch as string | null,
    revision: row.revision as number,
    data: row.data as string,
    summary: row.summary as string,
  };
}


/** Both metadata batches keep their order inside RunDatabase.transaction. */
export function writeMetadata(statements: { deleteMeta: StatementSync; setMeta: StatementSync }, values: Readonly<Record<string, string | null>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) statements.deleteMeta.run(key);
    else statements.setMeta.run(key, value);
  }
}
