import type { RunClaim } from './run-database.ts';
import type { StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { RunDatabaseChanges, RunRow, RunRowInput } from './run-database.ts';

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

/** Convert the input row to the named SQLite bindings without changing optional-column defaults. */
export function toRunBindings(row: RunRowInput, revision: number) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt ?? null,
    status: row.status,
    archived: row.archived ? 1 : 0,
    live: row.live ? 1 : 0,
    parentRunId: row.parentRunId ?? null,
    clientRequestId: row.clientRequestId ?? null,
    groupId: row.groupId ?? null,
    worktreePath: row.worktreePath ?? null,
    branch: row.branch ?? null,
    baseBranch: row.baseBranch ?? null,
    revision,
    data: row.data,
    summary: row.summary,
  };
}

export function toRunClaim(row: Record<string, unknown>): RunClaim {
  return {
    family: row.family as string,
    session: row.session as string,
    pid: row.pid as number,
    startToken: row.start_token as string | null,
    generation: row.generation as number,
  };
}

export function validateChanges(changes: RunDatabaseChanges): void {
  const upserted = new Set<string>();
  for (const row of changes.upserts) {
    if (upserted.has(row.id)) throw new TypeError(`run ${row.id} is upserted twice in one transaction`);
    upserted.add(row.id);
  }
  for (const id of changes.deletes) {
    if (upserted.has(id)) throw new TypeError(`run ${id} is both upserted and deleted in one transaction`);
  }
}

/**
 * What a read-only open opens. `quiescent` (a project migration's dry run, which must leave no
 * trace) also requires this build's exact schema, and reads a database with no WAL file (no
 * connection is open and every commit is in the main file) as immutable, so no -wal or -shm is
 * created. With a WAL file present it coordinates as any reader does.
 */
export function readOnlyTarget(path: string, quiescent: boolean): string {
  return quiescent && !existsSync(`${path}-wal`) ? `${pathToFileURL(path).href}?immutable=1` : path;
}
