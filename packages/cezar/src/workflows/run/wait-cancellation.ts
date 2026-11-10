import type { Wait } from '@open-mercato/cezar-contract/waits';
import type { RunModuleContext } from './types.ts';

interface CancelWaitsOptions {
  onCommitFailure?: 'throw' | 'skip';
  superseded?: true;
  log?: string;
}

interface WaitCancellationHost {
  disarmWait(id: string): void;
  abortRegistrations(id: string): void;
  disarmRun(id: string): void;
  forgetRetries(id: string): void;
  resetWakeDelivery(id: string): void;
  removeWake(id: string, active: boolean): void;
  retireAdmission(id: string): unknown;
  hasActive(id: string): boolean;
}

export class WaitCancellation {
  constructor(private readonly context: RunModuleContext, private readonly host: WaitCancellationHost) {}

  /** Keep watches armed until cancellation is durable. A skipped write disarms nothing. */
  cancel(
    runId: string, ids: readonly string[], opts: CancelWaitsOptions = {},
  ): Wait[] {
    let settled: Wait[];
    try {
      ({ settled } = this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: ids, ...(opts.superseded ? { superseded: true } : {}) }));
    } catch (error) {
      if (opts.onCommitFailure !== 'skip') throw error;
      console.warn(`${opts.log ?? '[cez] wait cancellation failed'}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    for (const id of ids) this.host.disarmWait(id);
    return settled;
  }

  /**
   * Cancel every open or resolved wait of a run without waking the agent: stop, Finish, cancel,
   * deletion, DONE and any terminal status. Human input cancels none (hearsay-tools/cezarion#1233).
   * A failed commit leaves the record as a crash would and never stops the disarm, so Stop still
   * reaches the session when the store is closed or broken (hearsay-tools/cezarion#1234).
   */
  cancelAll(runId: string): void {
    const before = this.context.store.getRun(runId)?.waits ?? [];
    const remaining = (this.context.store.getRun(runId)?.waits ?? []).map(wait => wait.id);
    try { if (remaining.length) this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: remaining }); }
    catch (error) { console.warn(`[cez] wait cancellation failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (const wait of before) this.host.disarmWait(wait.id);
    this.forgetRun(runId);
  }

  /** Stop every watch, timer, retry and queued wake a run's waits hold in memory. */
  forgetRun(runId: string): void {
    this.host.abortRegistrations(runId);
    this.host.disarmRun(runId);
    this.host.forgetRetries(runId);
    this.host.resetWakeDelivery(runId);
    this.host.removeWake(runId, this.host.hasActive(runId));
    this.host.retireAdmission(runId);
  }
}
