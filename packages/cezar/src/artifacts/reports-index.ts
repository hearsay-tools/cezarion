import { logPrefix } from '../home/display.ts';
import { ReportsWatch, reportMetadataKey } from './reports-watch.ts';
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
import { artifactRunsRoot, scanArtifactsForIndex, checkArtifactContentForIndex } from './store.ts';

export { REPORTS_BACKFILL_KEY } from '../runs/report-rows.ts';
const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);
const instances = new WeakMap<RunStore, ReportsIndex>();
export function reportsIndex(store: RunStore): ReportsIndex {
  const { db, dataDir, openFailure } = store.reportSource();
  if (!db) throw openFailure ?? new Error('runs database unavailable');
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
  private projectBackfilled = false;
  private live = new Set<string>();
  private runsRoot?: string;
  private changes: ReportsWatch;
  private settlements = new Set<string>();
  state() { return this.changes.state(); }
  watch() { return this.changes.watch(); }
  markRead() { this.changes.markRead(); }
  onChange(listener: Parameters<ReportsWatch['onChange']>[0]) { return this.changes.onChange(listener); }
  private onDeleted = (id: string): void => { this.changes.deleted(id); this.live.delete(id); };


  private root(): string { return this.runsRoot ??= artifactRunsRoot(this.dataDir); }
  private async storage<T>(runId: string, read: (directory: string) => Promise<T>) {
    try {
      // A fallback run and a task the project move left in `.ai/cezar/` keep their artifacts there.
      const source = this.store.sourceDataDir(runId);
      return await read(join(source === this.dataDir ? this.root() : artifactRunsRoot(source), `${runId}-artifacts`));
    }
    catch (error) { return { state: 'indeterminate' as const, error }; }
  }

  constructor(private db: RunDatabase, private store: RunStore, private dataDir: string) {
    this.changes = new ReportsWatch(
      id => this.serial(async () => {
        if (!this.changes.watching()) return;
        if (!this.changes.due(id)) { this.changes.schedule(id); return; }
        this.store.flush(); await this.indexRun(id); this.settlements.delete(id);
      }),
      before => this.serial(async () => {
        if (!this.changes.watching()) return;
        this.store.flush();
        const ids = new Set(this.db.reports.dirty());
        for (const row of this.db.listLive()) if (this.changes.quiet(row.id, before)) ids.add(row.id);
        for (const id of ids) if (this.changes.due(id) && this.supportedRun(id)) await this.indexRun(id);
      }),
      () => {
        // Closing the last shelf must not cancel the existing terminal reconciliation guarantee.
        if (this.settlements.size) {
          this.settlements.clear();
          void this.reconcile(false).catch(error => console.warn(`${logPrefix()} Reports settlement failed:`, error));
        }
      },
    );
    store.flush();
    for (const row of db.reports.summaries()) {
      const summary = parseStoredSummary(row.summary);
      this.changes.seed(row.runId, summary ? reportMetadataKey(summary) : undefined);
    }
    this.live = new Set(db.listLive().map(row => row.id));
    store.on('run', this.onRun);
    store.on('deleted', this.onDeleted);
    store.once('closed', () => { this.closed = true; this.changes.close(); store.off('run', this.onRun); store.off('deleted', this.onDeleted); });
  }

  private onRun = (run: RunRecord): void => {
    const wasLive = this.live.has(run.id);
    if (wasLive && !isLiveStatus(run.status) && this.changes.watching()) this.settlements.add(run.id);
    const live = isLiveStatus(run.status);
    this.changes.run(run, live || wasLive, this.db.reports.forRun(run.id).length > 0);
    if (live) { this.live.add(run.id); return; }
    const settled = this.live.delete(run.id);
    if (this.started && settled && !this.changes.watching()) void this.reconcile(false, run.id).catch(error => console.warn(`${logPrefix()} Reports reconciliation failed:`, error));
  };

  /** Only the post-listen boot hook and already-served lazy contexts call this. */
  start(): void {
    this.started = true;
    void this.backfill().catch(error => console.warn(`${logPrefix()} Reports backfill failed:`, error));
  }
  /** Settles once the scans queued so far end. */
  idle(): Promise<void> { return this.queue; }
  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => { if (!this.closed) await work(); });
    this.queue = next.catch(() => undefined);
    return next;
  }
  backfill(): Promise<void> {
    return this.serial(async () => {
      this.store.flush();
      if (this.db.getMeta(REPORTS_BACKFILL_KEY) && (!this.db.hasProjectSource || this.projectBackfilled)) return;
      let complete = true;
      for (const id of this.db.listIds()) {
        if (this.supportedRun(id) && !await this.indexRun(id)) complete = false;
      }
      if (!this.closed && complete) {
        this.db.transaction({ upserts: [], deletes: [], meta: { [REPORTS_BACKFILL_KEY]: new Date().toISOString() } });
        this.projectBackfilled = true;
      }
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
    this.changes.scanned(runId);
    const previous = this.db.reports.forRun(runId);
    const revision = this.db.revisionOf(runId);
    const scan = await this.storage(runId, directory => scanArtifactsForIndex(directory, runId));
    if (scan.state === 'indeterminate') {
      console.warn(`${logPrefix()} Report scan could not be completed: ${runId}`, scan.error);
      if (this.closed) return false;
      this.db.reports.retry(runId, revision);
      return false;
    }
    const artifacts: IndexedArtifact[] = scan.state === 'read' ? scan.value.artifacts.filter(a => /\.html?$/i.test(a.name)) : [];
    const uncertain = scan.state === 'read' ? scan.value.indeterminate : [];
    for (const cached of previous) if (uncertain.includes(cached.id)) artifacts.push(cached);
    const complete = uncertain.length === 0;
    if (!complete) console.warn(`${logPrefix()} Report read could not be completed: ${runId}`);
    if (this.closed) return false;
    this.db.reports.replace(runId, artifacts, revision, complete);
    const current = this.db.reports.forRun(runId);
    const stable = (rows: IndexedArtifact[]) => JSON.stringify(rows.slice().sort((a, b) => a.id.localeCompare(b.id)));
    if (stable(previous) !== stable(current)) this.changes.content();
    if (current.length) {
      const row = this.db.getSummaries([runId])[0];
      const summary = row && parseStoredSummary(row.summary);
      if (summary) this.changes.updateMetadata(summary);
      else this.changes.seed(runId);
    } else this.changes.forget(runId);
    const kept = new Set(artifacts.map(a => a.id));
    for (const missing of previous) if (!kept.has(missing.id)) console.warn(`${logPrefix()} Report missing or deleted: ${runId}/${missing.id}`);
    return complete;
  }
  private async present(row: ReportRow): Promise<boolean | null> {
    if (!this.supportedRun(row.runId)) return false;
    const check = await this.storage(row.runId, directory => checkArtifactContentForIndex(directory, row.runId, row.id, row.size));
    if (check.state === 'indeterminate') {
      this.db.reports.retry(row.runId, this.db.revisionOf(row.runId));
      console.warn(`${logPrefix()} Report content could not be checked: ${row.runId}/${row.id}`, check.error);
      return null;
    }
    if (check.state === 'read' && check.value) return true;
    this.db.reports.drop(row.id);
    if (!this.db.reports.forRun(row.runId).length) this.changes.forget(row.runId);
    this.changes.content();
    console.warn(`${logPrefix()} Report missing or deleted: ${row.runId}/${row.id}`);
    return false;
  }
  private matchingRows(q: string): ReportRow[] {
    const matches: ReportRow[] = [];
    const warned = new Set<string>();
    for (const row of this.db.reports.summaries()) {
      const summary = parseStoredSummary(row.summary);
      if (!summary) {
        if (!warned.has(row.runId)) console.warn(`${logPrefix()} Report source task could not be read: ${row.runId}`);
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
        if (entry && await this.present(row) !== false) reports.push(entry);
      }
    }
    const more = reports.length > limit;
    if (more) reports.pop();
    const last = reports.at(-1);
    return { reports, total: matches.length,
      nextCursor: more && last ? Buffer.from(JSON.stringify(cursor(last))).toString('base64url') : null };
  }
}
