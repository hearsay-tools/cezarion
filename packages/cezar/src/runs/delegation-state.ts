import { delegationStateSchema, type WorkerDestroyView, type WorkerOutcome } from '@open-mercato/cezar-contract';
import type { RunRecord } from './store.ts';

/** Malformed authority quarantines only this record, never the whole index or into an eligible root. */
export const storedDelegationStateSchema = delegationStateSchema.optional().catch({ role: 'invalid' });

export function workerOutcome(run: RunRecord, observedAt: string): WorkerOutcome | undefined {
  if (run.delegation?.role !== 'worker') return undefined;
  const status = run.status;
  if (status !== 'review' && status !== 'done' && status !== 'failed' && status !== 'cancelled') return undefined;
  return { workerId: run.id, status, revision: run.delegation.executionRevision ?? 0, observedAt: run.finishedAt ?? observedAt,
    ...(run.error ? { summary: run.error.slice(0, 4_000) } : {}) };
}

/** A worker's destroy as inspection and relationships show it: the stored phase, plus the automatic
 * retry state the run keeps beside its delegation while the destroy is pending
 * (hearsay-tools/cezarion#879). The one place both surfaces build it. */
export function workerDestroyView(run: RunRecord): WorkerDestroyView | undefined {
  if (run.delegation?.role !== 'worker' || !run.delegation.destroy) return undefined;
  const { destroy } = run.delegation;
  return destroy.phase !== 'complete' && run.destroyRetry ? { ...destroy, retry: run.destroyRetry } : destroy;
}
