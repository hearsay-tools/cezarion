import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { matchesRunSearch } from '@open-mercato/cezar-contract/run-search';
import type { ReportsQuery, ReportsResponse, Report } from '@open-mercato/cezar-contract/reports';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import type { RunDatabase, IndexedArtifact } from '../runs/run-database.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { artifactDirectory, readArtifactMetadata } from './store.ts';

export const REPORTS_BACKFILL_KEY = 'reports-backfill-complete';
const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

export class ReportsIndex {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;

  constructor(private db: RunDatabase, private store: RunStore, private dataDir: string) {
    store.on('run', this.onRun);
    store.once('closed', () => { this.closed = true; store.off('run', this.onRun); });
  }

  // Terminal run events are the settlement trigger, including workers and recovery.
  private onRun = (run: RunRecord): void => {
    if (this.started && !isLiveStatus(run.status)) void this.reconcile().catch(error => console.warn('[cez] Reports reconciliation failed:', error));
  };

  /** Called only after the listener is up. A failed backfill keeps its marker absent for retry. */
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

  reconcile(): Promise<void> {
    return this.serial(async () => {
      this.store.flush();
      const live = this.db.listLive().map(row => row.id);
      const ids = new Set([...this.db.listDirtyReportRuns(), ...live]);
      for (const id of ids) await this.indexRun(id);
    });
  }

  private async indexRun(runId: string): Promise<void> {
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
    if (!this.closed) this.db.replaceArtifacts(runId, artifacts, revision);
  }

  private async matchingReports(query: string): Promise<Report[]> {
    const q = query.trim().toLowerCase();
    const reports: Report[] = [];
    for (const artifact of this.db.listArtifacts()) {
      const run = this.store.getRun(artifact.runId);
      if (!run) continue;
      const title = artifact.title || artifact.name.replace(/(.+)\.[^.]+$/, '$1');
      if (q && !title.toLowerCase().includes(q) && !artifact.name.toLowerCase().includes(q) && !matchesRunSearch(toRunSummary(run), q)) continue;
      const content = join(artifactDirectory(this.dataDir, artifact.runId), artifact.id, 'content');
      const exists = await lstat(content).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!exists || !exists.isFile() || exists.isSymbolicLink() || exists.size !== artifact.size) {
        this.db.dropArtifact(artifact.id);
        console.warn(`[cez] Report missing or deleted: ${artifact.runId}/${artifact.id}`);
        continue;
      }
      reports.push({ ...artifact, title, taskTitle: run.title ?? run.task, taskStatus: run.status });
    }
    return reports;
  }

  async list(query: ReportsQuery): Promise<ReportsResponse | { error: string }> {
    let before: z.infer<typeof cursorSchema> | undefined;
    if (query.before) {
      try { before = cursorSchema.parse(JSON.parse(Buffer.from(query.before, 'base64url').toString())); }
      catch { return { error: 'before is not a cursor this server wrote' }; }
    }
    await this.backfill();
    await this.reconcile();
    const reports = await this.matchingReports(query.q ?? '');
    const candidates = before ? reports.filter(a => a.createdAt < before[0] || (a.createdAt === before[0] && a.id > before[1])) : reports;
    const page = candidates.slice(0, query.limit ?? 50);
    const last = page.at(-1);
    return { reports: page, total: reports.length, nextCursor: candidates.length > page.length && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null };
  }
}
