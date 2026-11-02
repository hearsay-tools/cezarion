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
import { artifactDirectory, inspectArtifactStorageForIndex, readArtifactMetadataForIndex } from './store.ts';

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
      let complete = true;
      const scan = await inspectArtifactStorageForIndex(join(this.dataDir, 'runs'), path => readdir(path, { withFileTypes: true }));
      if (scan.state !== 'read') return;
      for (const entry of scan.value) {
        const id = entry.name.replace(/-artifacts$/, '');
        if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name.endsWith('-artifacts') && this.db.has(id)) {
          if (this.supportedRun(id) && !await this.indexRun(id)) complete = false;
        }
      }
      if (!this.closed && complete) this.db.transaction({ upserts: [], deletes: [], meta: { [REPORTS_BACKFILL_KEY]: new Date().toISOString() } });
    });
  }
  private supportedRun(id: string): boolean {
    if (z.uuid().safeParse(id).success) return true;
    this.db.reports.deleteRun(id); // Legacy task IDs cannot own published snapshots or retry markers.
    return false;
  }
  reconcile(includeLive = true, settledId?: string): Promise<void> {
    return this.serial(async () => {
      this.store.flush();
      const ids = new Set(this.db.reports.dirty());
      if (includeLive) for (const row of this.db.listLive()) ids.add(row.id);
      if (settledId) ids.add(settledId);
      for (const id of ids) if (this.supportedRun(id)) await this.indexRun(id);
    });
  }
  private async indexRun(runId: string): Promise<boolean> {
    if (!this.supportedRun(runId)) return true;
    const previous = this.db.reports.forRun(runId);
    const revision = this.db.revisionOf(runId);
    const directory = artifactDirectory(this.dataDir, runId);
    const scan = await inspectArtifactStorageForIndex(directory, path => readdir(path));
    if (scan.state === 'indeterminate') {
      console.warn(`[cez] Report scan could not be completed: ${runId}`, scan.error);
      this.db.reports.retry(runId, revision);
      return false;
    }
    const entries = scan.state === 'read' ? scan.value : [];
    const artifacts: IndexedArtifact[] = [];
    let complete = true;
    for (const id of entries) {
      const result = await readArtifactMetadataForIndex(directory, runId, id);
      if (result.state === 'indeterminate') {
        complete = false;
        const cached = previous.find(row => row.id === id);
        if (cached) artifacts.push(cached);
        console.warn(`[cez] Report read could not be completed: ${runId}/${id}`, result.error);
      } else if (result.state === 'read' && /\.html?$/i.test(result.artifact.name)) artifacts.push(result.artifact);
    }
    if (this.closed) return false;
    this.db.reports.replace(runId, artifacts, revision, complete);
    const kept = new Set(artifacts.map(a => a.id));
    for (const missing of previous) if (!kept.has(missing.id)) console.warn(`[cez] Report missing or deleted: ${runId}/${missing.id}`);
    return complete;
  }
  private async present(row: ReportRow): Promise<boolean | null> {
    if (!this.supportedRun(row.runId)) return false;
    const check = await inspectArtifactStorageForIndex(join(artifactDirectory(this.dataDir, row.runId), row.id), path => lstat(join(path, 'content')));
    if (check.state === 'indeterminate') {
      this.db.reports.retry(row.runId, this.db.revisionOf(row.runId));
      console.warn(`[cez] Report content could not be checked: ${row.runId}/${row.id}`, check.error);
      return null;
    }
    if (check.state === 'read' && check.value.isFile() && !check.value.isSymbolicLink() && check.value.size === row.size) return true;
    this.db.reports.drop(row.id);
    console.warn(`[cez] Report missing or deleted: ${row.runId}/${row.id}`);
    return false;
  }
  private matchingRows(q: string): ReportRow[] {
    const matches: ReportRow[] = [];
    const warned = new Set<string>();
    for (const row of this.db.reports.summaries()) {
      const summary = parseStoredSummary(row.summary);
      if (!summary) {
        if (!warned.has(row.runId)) console.warn(`[cez] Report source task could not be read: ${row.runId}`);
        warned.add(row.runId);
        continue;
      }
      if (!q || reportTitle(row).toLowerCase().includes(q) || row.name.toLowerCase().includes(q) || matchesRunSearch(summary, q, { scope: 'stored' })) matches.push(row);
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
    const matches = this.matchingRows(q);
    const limit = query.limit ?? 50;
    const reports: Report[] = [];
    while (reports.length <= limit) {
      const count = limit + 1 - reports.length;
      const rows = q ? matches.filter(row => !before || after(row, before)).slice(0, count) : this.db.reports.page(before, count);
      if (!rows.length) break;
      for (const row of rows) {
        before = cursor(row);
        const entry = report(row);
        if (entry && await this.present(row)) reports.push(entry);
      }
    }
    const more = reports.length > limit;
    if (more) reports.pop();
    const last = reports.at(-1);
    return { reports, total: matches.length,
      nextCursor: more && last ? Buffer.from(JSON.stringify(cursor(last))).toString('base64url') : null };
  }
}
