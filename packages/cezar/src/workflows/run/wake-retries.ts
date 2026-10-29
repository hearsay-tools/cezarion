import type { RunModuleContext } from './types.ts';
import type { RunRecord } from '../../runs/store.ts';
import { noJitter, retryDelayMs, type Backoff } from '../../delegation/retry-backoff.ts';

interface WakeRetriesHost {
  owesWake(run: RunRecord): boolean;
  queueWaitWake(runId: string): void;
  retryWaitAdmission(runId: string): void;
  wakeRetryBackoff(): Backoff;
}

export class WakeRetries {
  /** A wake that could not be admitted yet, retried by run id. */
  readonly wakeRetries = new Map<string, NodeJS.Timeout>();
  /** The last "retained; continuation unavailable" note per run: the 1 Hz admission retry writes
   *  it on the transition into refusal or when the reason changes, never once per retry. */
  private readonly retainedNotes = new Map<string, string>();
  /** The wait before the next automatic delivery attempt after a failed one, by run id. */
  readonly wakeBackoffs = new Map<string, NodeJS.Timeout>();

  constructor(private readonly context: RunModuleContext, private readonly host: WakeRetriesHost) {}

  retryWaitAdmission(runId: string): void {
    const run = this.context.store.getRun(runId);
    if (this.context.disposed() || this.wakeRetries.has(runId) || !run || !this.host.owesWake(run)) return;
    const timer = setTimeout(() => {
      this.wakeRetries.delete(runId);
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    }, 1000);
    timer.unref(); this.wakeRetries.set(runId, timer);
  }

  clearWakeBackoff(runId: string): void {
    const timer = this.wakeBackoffs.get(runId); if (timer) clearTimeout(timer); this.wakeBackoffs.delete(runId);
  }

  stopRetry(runId: string): void {
    const retry = this.wakeRetries.get(runId); if (retry) clearTimeout(retry); this.wakeRetries.delete(runId);
  }

  backoff(runId: string, failures: number): void {
    const previous = this.wakeBackoffs.get(runId); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.wakeBackoffs.get(runId) !== timer) return;
      this.wakeBackoffs.delete(runId);
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    }, retryDelayMs(failures - 1, this.host.wakeRetryBackoff(), noJitter));
    timer.unref(); this.wakeBackoffs.set(runId, timer);
  }

  inBackoff(runId: string): boolean {
    return this.wakeBackoffs.has(runId);
  }

  noteRetained(runId: string, message: string): boolean {
    if (this.retainedNotes.get(runId) !== message) {
      this.retainedNotes.set(runId, message);
      return true;
    }
    return false;
  }

  clearRetained(runId: string): void {
    this.retainedNotes.delete(runId);
  }

  forget(runId: string): void {
    const timer = this.wakeRetries.get(runId); if (timer) clearTimeout(timer); this.wakeRetries.delete(runId);
    this.retainedNotes.delete(runId);
  }

  dispose(): void {
    for (const timer of this.wakeRetries.values()) clearTimeout(timer);
    this.wakeRetries.clear();
    for (const timer of this.wakeBackoffs.values()) clearTimeout(timer);
    this.wakeBackoffs.clear();
  }
}
