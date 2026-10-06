import * as historyFile from './history-file.ts';

/**
 * One-at-a-time background queue that compresses archived transcripts.
 * Never blocks a caller; job errors are swallowed (best effort, like retention).
 */
export class HistoryCompressor {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly retries = new Map<string, number>();
  private running: string | null = null;
  private draining = false;
  private stopped = false;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly dataDir: string,
    private readonly isEligible: (id: string) => boolean,
  ) {}

  /** Dedupes; starts draining if idle. Does no file I/O inline. */
  enqueue(id: string): void {
    if (this.stopped) return;
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.drain();
  }

  /** Drops a queued (not running) job. */
  cancel(id: string): void {
    this.retries.delete(id);
    if (!this.queued.has(id)) return;
    this.queued.delete(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    this.notifyIdle();
  }

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.running === null && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Drops the queue; a running job finishes its own eligibility check. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.queued.clear();
    this.retries.clear();
    this.notifyIdle();
  }

  private drain(): void {
    if (this.draining || this.stopped) return;
    this.draining = true;
    // Yield so setArchived/archiveFinished return without reading files (N3).
    queueMicrotask(() => { void this.loop(); });
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopped && this.queue.length > 0) {
        const id = this.queue.shift()!;
        this.queued.delete(id);
        this.running = id;
        try {
          if (!this.isEligible(id)) {
            this.retries.delete(id);
            continue;
          }
          const result = await historyFile.compressHistory(
            this.dataDir,
            id,
            () => !this.stopped && this.isEligible(id),
          );
          this.afterJob(id, result);
        } catch {
          this.retries.delete(id);
          // Best effort, like retention.
        } finally {
          this.running = null;
        }
      }
    } finally {
      this.draining = false;
      this.notifyIdle();
      if (!this.stopped && this.queue.length > 0) this.drain();
    }
  }

  private afterJob(id: string, result: 'compressed' | 'skipped' | 'changed'): void {
    if (result === 'changed' && !this.stopped && this.isEligible(id)) {
      const n = this.retries.get(id) ?? 0;
      if (n < 3) {
        this.retries.set(id, n + 1);
        if (!this.queued.has(id)) {
          this.queued.add(id);
          this.queue.push(id);
        }
        return;
      }
    }
    this.retries.delete(id);
  }

  private notifyIdle(): void {
    if (this.running !== null || this.queue.length > 0) return;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
