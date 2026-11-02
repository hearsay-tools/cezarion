import type { DatabaseSync } from 'node:sqlite';

export const REPORTS_BACKFILL_KEY = 'reports-backfill-complete';
export const REPORTS_MIGRATION = `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL,
    title TEXT, created_at TEXT NOT NULL, size INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX artifacts_created_at ON artifacts (created_at DESC, id);
  CREATE INDEX artifacts_run_id ON artifacts (run_id);
`;
export interface IndexedArtifact {
  id: string; runId: string; name: string; title?: string | undefined; createdAt: string; size: number;
}
export type ReportRow = IndexedArtifact & { summary: string };
export type ReportCursor = readonly [string, string];
const instances = new WeakMap<DatabaseSync, ReportRows>();
type Execute = <T>(work: () => T) => T;
export function reportRows(db: DatabaseSync, execute: Execute): ReportRows {
  let rows = instances.get(db);
  if (!rows) { rows = new ReportRows(db, execute); instances.set(db, rows); }
  return rows;
}
function artifact(row: Record<string, unknown>): IndexedArtifact {
  return { id: row.id as string, runId: row.run_id as string, name: row.name as string,
    ...(row.title === null ? {} : { title: row.title as string }), createdAt: row.created_at as string, size: row.size as number };
}

/** Prepared once per connection. Only replace() owns a transaction; mark/delete join the run write. */
export class ReportRows {
  private statements;
  constructor(private db: DatabaseSync, private execute: Execute) {
    this.statements = {
      live: db.prepare('SELECT live FROM runs WHERE id = ?'),
      exists: db.prepare('SELECT 1 FROM runs WHERE id = ?'),
      mark: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      dirty: db.prepare("SELECT key FROM meta WHERE key >= 'reports-dirty:' AND key < 'reports-dirty;'"),
      clear: db.prepare('DELETE FROM meta WHERE key = ? AND value = ?'),
      clearRun: db.prepare('DELETE FROM meta WHERE key = ?'),
      deleteRun: db.prepare('DELETE FROM artifacts WHERE run_id = ?'),
      drop: db.prepare('DELETE FROM artifacts WHERE id = ?'),
      insert: db.prepare('INSERT INTO artifacts (id, run_id, name, title, created_at, size) VALUES (?, ?, ?, ?, ?, ?)'),
      count: db.prepare('SELECT COUNT(*) AS total FROM artifacts a JOIN runs r ON r.id = a.run_id'),
      all: db.prepare('SELECT a.*, r.summary FROM artifacts a JOIN runs r ON r.id = a.run_id ORDER BY a.created_at DESC, a.id'),
      first: db.prepare('SELECT a.*, r.summary FROM artifacts a JOIN runs r ON r.id = a.run_id ORDER BY a.created_at DESC, a.id LIMIT ?'),
      page: db.prepare(`SELECT a.*, r.summary FROM artifacts a JOIN runs r ON r.id = a.run_id
        WHERE a.created_at < ? OR (a.created_at = ? AND a.id > ?) ORDER BY a.created_at DESC, a.id LIMIT ?`),
      perRun: db.prepare('SELECT * FROM artifacts WHERE run_id = ?'),
    };
  }
  markDirty(id: string, live: boolean, revision: number): void {
    this.execute(() => { if (live || this.statements.live.get(id)?.live === 1) this.statements.mark.run(`reports-dirty:${id}`, String(revision)); });
  }
  dirty(): string[] { return this.execute(() => this.statements.dirty.all().map(row => (row.key as string).slice('reports-dirty:'.length))); }
  deleteRun(id: string): void { this.execute(() => { this.statements.deleteRun.run(id); this.statements.clearRun.run(`reports-dirty:${id}`); }); }
  drop(id: string): void { this.execute(() => this.statements.drop.run(id)); }
  count(): number { return this.execute(() => this.statements.count.get()!.total as number); }
  page(before: ReportCursor | undefined, limit: number): ReportRow[] {
    return this.execute(() => {
    const rows = before ? this.statements.page.all(before[0], before[0], before[1], limit) : this.statements.first.all(limit);
    return rows.map(row => ({ ...artifact(row), summary: row.summary as string }));
    });
  }
  *summaries(): Generator<ReportRow> {
    const iterator = this.execute(() => this.statements.all.iterate());
    for (let next = this.execute(() => iterator.next()); !next.done; next = this.execute(() => iterator.next())) {
      const row = next.value; yield { ...artifact(row), summary: row.summary as string };
    }
  }
  forRun(id: string): IndexedArtifact[] { return this.execute(() => this.statements.perRun.all(id).map(artifact)); }
  list(): IndexedArtifact[] { return this.execute(() => this.statements.all.all().map(artifact)); }
  replace(runId: string, artifacts: readonly IndexedArtifact[], revision?: number): void {
    this.execute(() => {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.deleteRun.run(runId);
      if (this.statements.exists.get(runId)) {
        for (const a of artifacts) this.statements.insert.run(a.id, runId, a.name, a.title ?? null, a.createdAt, a.size);
      }
      this.statements.clear.run(`reports-dirty:${runId}`, String(revision));
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original write failure. */ } }
      throw error;
    }
    });
  }
}
