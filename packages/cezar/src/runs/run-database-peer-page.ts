import type { DatabaseSync } from 'node:sqlite';
import type { RunSummaryRow } from './run-database.ts';

export type PeerSummaryPageQuery = { all: boolean; excluded: readonly string[]; offset: number; limit: number };

/** Each archive branch uses the existing runs_archived_roots index (archive, date, seq).
 * SQLite merges those ordered branches before LIMIT; no archive or worker list enters JS. */
export function readPeerSummaryPage(db: DatabaseSync, options: PeerSummaryPageQuery): RunSummaryRow[] {
  const archives = options.all ? [0, 1] : [0];
  const selects = archives.map(archived => `SELECT seq, id, created_at, revision, summary FROM runs
    WHERE parent_run_id IS NULL AND archived = ${archived}
      AND id NOT IN (SELECT value FROM json_each(?))
      AND CASE WHEN json_valid(data) THEN
        (json_extract(data, '$.delegation.role') IS NULL OR json_extract(data, '$.delegation.role') = 'root')
        AND json_extract(data, '$.delegation.historyDeletion') IS NULL
        ELSE 0 END`);
  const excluded = JSON.stringify(options.excluded);
  return db.prepare(`${selects.join(' UNION ALL ')} ORDER BY created_at DESC, seq LIMIT ? OFFSET ?`)
    .all(...archives.map(() => excluded), options.limit, options.offset).map(toSummaryRow);
}

export function toSummaryRow(row: Record<string, unknown>): RunSummaryRow {
  return {
    seq: row.seq as number,
    id: row.id as string,
    createdAt: row.created_at as string,
    revision: row.revision as number,
    summary: row.summary as string,
  };
}

