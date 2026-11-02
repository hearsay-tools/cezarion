import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { matchesRunSearch } from '@open-mercato/cezar-contract/run-search';
import { reportTitle } from '@open-mercato/cezar-contract/report-title';
import type { ReportsQuery, ReportsResponse, Report } from '@open-mercato/cezar-contract/reports';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import type { RunDatabase } from '../runs/run-database.ts';
import { REPORTS_BACKFILL_KEY, type IndexedArtifact, type ReportRow, type ReportCursor } from '../runs/report-rows.ts';
import { parseStoredSummary } from '../runs/run-summary-page.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { artifactDirectory, readArtifactMetadata } from './store.ts';

export { REPORTS_BACKFILL_KEY } from '../runs/report-rows.ts';
const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);
const instances = new WeakMap<RunStore, ReportsIndex>();
export function reportsIndex(db: RunDatabase | null, store: RunStore, dataDir: string, failure?: Error): ReportsIndex {
  if (!db) throw failure ?? new Error('runs database unavailable');
  let index = instances.get(store);
  if (!index) { index = new ReportsIndex(db, store, dataDir); instances.set(store, index); }
  return index;
}
const cursor = (row: IndexedArtifact): ReportCursor => [row.createdAt, row.id];
const after = (row: IndexedArtifact, before: ReportCursor) => row.createdAt < before[0] || (row.createdAt === before[0] && row.id > before[1]);
function report(row: ReportRow): Report | null {
  const summary = parseStoredSummary(row.summary);
  if (!summary) return null;
  return { id: row.id, runId: row.runId, name: row.name, title: reportTitle(row), createdAt: row.createdAt, size: row.size,
    taskTitle: summary.title, taskStatus: summary.status };
}

export class ReportsIndex {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;
  private live = new Set<string>();

  constructor(private db: RunDatabase, private store: RunStore, private dataDir: string) {
    store.flush();
    this.live = new Set(db.listLive().map(row => row.id));
    store.on('run', this.onRun);
    store.once('closed', () => { this.closed = true; store.off('run', this.onRun); });
  }

  private onRun = (run: RunRecord): void => {
    if (isLiveStatus(run.status)) { this.live.add(run.id); return; }
    const settled = this.live.delete(run.id);
    if (this.started && settled) void this.reconcile(false, run.id).catch(error => console.warn('[cez] Reports reconciliation failed:', error));
  };

  /** Only the post-listen boot hook and already-served lazy contexts call this. */
  start(): void {
    this.started = true;
    void this.backfill().catch(error => console.warn('[cez] Reports backfill failed:', error));
  }
  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => { if (!this.closed) await work(); });
    this.queue = next.catch(() => undefined);
    return next;
  }
  backfill(): Promise<void> {
    return this.serial(async () => {
      this.store.flush();
      if (this.db.getMeta(REPORTS_BACKFILL_KEY)) return;
      for (const entry of await readdir(join(this.dataDir, 'runs'), { withFileTypes: true })) {
        const id = entry.name.replace(/-artifacts$/, '');
        if (entry.isDirectory() && entry.name.endsWith('-artifacts') && z.uuid().safeParse(id).success && this.db.has(id)) await this.indexRun(id);
      }
      if (!this.closed) this.db.transaction({ upserts: [], deletes: [], meta: { [REPORTS_BACKFILL_KEY]: new Date().toISOString() } });
    });
  }
  reconcile(includeLive = true, settledId?: string): Promise<void> {
    return this.serial(async () => {
      this.store.flush();
      const ids = new Set(this.db.reports.dirty());
      if (includeLive) for (const row of this.db.listLive()) ids.add(row.id);
      if (settledId) ids.add(settledId);
      for (const id of ids) await this.indexRun(id);
    });
  }
  private async indexRun(runId: string): Promise<void> {
    const previous = this.db.reports.forRun(runId);
    const revision = this.db.revisionOf(runId);
    const directory = artifactDirectory(this.dataDir, runId);
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const artifacts: IndexedArtifact[] = [];
    for (const id of entries) {
      const artifact = await readArtifactMetadata(directory, runId, id);
      if (artifact && /\.html?$/i.test(artifact.name)) artifacts.push(artifact);
    }
    if (this.closed) return;
    this.db.replaceArtifacts(runId, artifacts, revision);
    const kept = new Set(artifacts.map(a => a.id));
    for (const missing of previous) if (!kept.has(missing.id)) console.warn(`[cez] Report missing or deleted: ${runId}/${missing.id}`);
  }
  private async present(row: ReportRow): Promise<boolean> {
    const content = join(artifactDirectory(this.dataDir, row.runId), row.id, 'content');
    const file = await lstat(content).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (file?.isFile() && !file.isSymbolicLink() && file.size === row.size) return true;
    this.db.reports.drop(row.id);
    console.warn(`[cez] Report missing or deleted: ${row.runId}/${row.id}`);
    return false;
  }
  private search(q: string): ReportRow[] {
    const matches: ReportRow[] = [];
    for (const row of this.db.reports.summaries()) {
      const summary = parseStoredSummary(row.summary);
      if (reportTitle(row).toLowerCase().includes(q) || row.name.toLowerCase().includes(q) || (summary && matchesRunSearch(summary, q, { scope: 'stored' }))) matches.push(row);
    }
    return matches;
  }
  async list(query: ReportsQuery): Promise<ReportsResponse | { error: string }> {
    let before: ReportCursor | undefined;
    if (query.before) {
      try { before = cursorSchema.parse(JSON.parse(Buffer.from(query.before, 'base64url').toString())); }
      catch { return { error: 'before is not a cursor this server wrote' }; }
    }
    await this.backfill();
    await this.reconcile();
    const q = query.q?.trim().toLowerCase() ?? '';
    const matches = q ? this.search(q) : undefined;
    const limit = query.limit ?? 50;
    const reports: Report[] = [];
    let missing = 0;
    while (reports.length <= limit) {
      const count = limit + 1 - reports.length;
      const rows = matches ? matches.filter(row => !before || after(row, before)).slice(0, count) : this.db.reports.page(before, count);
      if (!rows.length) break;
      for (const row of rows) {
        before = cursor(row);
        const entry = report(row);
        if (!entry) {
          this.db.reports.drop(row.id);
          console.warn(`[cez] Report source task could not be read: ${row.runId}`);
          missing++;
        } else if (await this.present(row)) reports.push(entry);
        else missing++;
      }
    }
    const more = reports.length > limit;
    if (more) reports.pop();
    const last = reports.at(-1);
    return { reports, total: matches ? matches.length - missing : this.db.reports.count(),
      nextCursor: more && last ? Buffer.from(JSON.stringify(cursor(last))).toString('base64url') : null };
  }
}
