import * as historyFile from './history-file.ts';

/**
 * One-at-a-time background queue that compresses archived transcripts.
 * Never blocks a caller; job errors are swallowed (best effort, like retention).
 */
export class HistoryCompressor {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running: string | null = null;
  private draining = false;
  private stopped = false;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly dataDir: string,
    private readonly isEligible: (id: string) => boolean,
  ) {}

  /** Dedupes; starts draining if idle. */
  enqueue(id: string): void {
    if (this.stopped) return;
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.drain();
  }

  /** Drops a queued (not running) job. */
  cancel(id: string): void {
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
    this.notifyIdle();
  }

  private drain(): void {
    if (this.draining || this.stopped) return;
    this.draining = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopped && this.queue.length > 0) {
        const id = this.queue.shift()!;
        this.queued.delete(id);
        this.running = id;
        try {
          await historyFile.compressHistory(this.dataDir, id, () => !this.stopped && this.isEligible(id));
        } catch {
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

  private notifyIdle(): void {
    if (this.running !== null || this.queue.length > 0) return;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
