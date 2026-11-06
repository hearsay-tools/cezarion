import { randomUUID } from 'node:crypto';
import { RUN_SEARCH_FIELDS, type RunSearchField } from '@open-mercato/cezar-contract/run-search';
import { toRunSummary, type RunSummary } from '@open-mercato/cezar-contract/runs';
import type { ReportsFrame, ReportsState } from '@open-mercato/cezar-contract/reports';
import type { RunRecord } from '../runs/store.ts';

/** Search's stored projection is also the metadata change boundary. */
export function reportMetadataKey(summary: RunSummary): string {
  return JSON.stringify([summary.title, summary.status, ...((RUN_SEARCH_FIELDS as readonly RunSearchField[])
    .filter(field => field.scopes.includes('stored'))
    .map(field => field.kind === 'reference' ? field.numbers(summary, {}) : field.texts(summary, {})))]);
}

/** Demand-bound timers, shared by the topic and finite HTTP readers. */
export class ReportsWatch {
  private readonly epoch = randomUUID();
  private generation = 0;
  private metadataGeneration = 0;
  private listeners = new Set<(frame: ReportsFrame) => void>();
  private demand = 0;
  private tick?: ReturnType<typeof setInterval>;
  private lease?: ReturnType<typeof setTimeout>;
  private releaseRead: (() => void) | undefined;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private lastEvent = new Map<string, number>();
  private lastScan = new Map<string, number>();
  private metadata = new Map<string, string>();
  private owners = new Set<string>();
  private closed = false;

  constructor(private scan: (id: string) => Promise<void>, private reconcile: (quietBefore: number) => Promise<void>, private idle: () => void = () => undefined) {}
  state(): ReportsState { return { epoch: this.epoch, generation: this.generation, metadataGeneration: this.metadataGeneration }; }
  onChange(listener: (frame: ReportsFrame) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(frame: ReportsFrame): void { for (const listener of this.listeners) listener(frame); }
  content(): void { this.generation++; this.emit({ type: 'content', ...this.state() }); }
  seed(id: string, key?: string): void { this.owners.add(id); if (key !== undefined) this.metadata.set(id, key); }
  forget(id: string): void { this.owners.delete(id); this.metadata.delete(id); }
  deleted(id: string): void {
    if (this.owners.has(id)) { this.forget(id); this.content(); }
    this.lastEvent.delete(id); this.lastScan.delete(id);
    clearTimeout(this.pending.get(id)); this.pending.delete(id);
  }
  run(run: RunRecord, scan: boolean, ownsRows: boolean): void {
    if (ownsRows) this.updateMetadata(toRunSummary(run));
    this.lastEvent.set(run.id, Date.now());
    if (scan) this.schedule(run.id);
  }
  updateMetadata(summary: RunSummary): void {
    const key = reportMetadataKey(summary);
    const previous = this.metadata.get(summary.id);
    this.seed(summary.id, key);
    if (previous === undefined || key === previous) return;
    this.metadataGeneration++;
    this.emit({ type: 'metadata', ...this.state(), runs: [{ runId: summary.id, taskTitle: summary.title, taskStatus: summary.status }] });
  }
  schedule(id: string): void {
    if (!this.demand || this.pending.has(id)) return;
    // Hold the first deadline under continuous events. Every execution is serialized by the index.
    const delay = Math.max(0, 1_000 - (Date.now() - (this.lastScan.get(id) ?? 0)));
    const timer = setTimeout(() => {
      this.pending.delete(id);
      void this.scan(id).catch(error => console.warn('[cez] Reports watch scan failed:', error));
    }, delay);
    timer.unref?.(); this.pending.set(id, timer);
  }
  due(id: string): boolean { return Date.now() - (this.lastScan.get(id) ?? 0) >= 1_000; }
  scanned(id: string): void { this.lastScan.set(id, Date.now()); }
  quiet(id: string, before: number): boolean { return (this.lastEvent.get(id) ?? 0) <= before; }
  watching(): boolean { return this.demand > 0; }
  watch(): () => void {
    if (this.closed) return () => undefined;
    if (++this.demand === 1) {
      this.tick = setInterval(() => {
        void this.reconcile(Date.now() - 5_000).catch(error => console.warn('[cez] Reports watch tick failed:', error));
      }, 5_000);
      this.tick.unref?.();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.demand === 0) {
        clearInterval(this.tick);
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        this.idle();
      }
    };
  }
  markRead(): void {
    if (this.closed) return;
    this.releaseRead ??= this.watch();
    clearTimeout(this.lease);
    this.lease = setTimeout(() => { this.releaseRead?.(); this.releaseRead = undefined; }, 15_000);
    this.lease.unref?.();
  }
  close(): void {
    this.closed = true; clearInterval(this.tick); clearTimeout(this.lease);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear(); this.listeners.clear();
  }
}
