import { delegationStateSchema, type WorkerOutcome } from '@open-mercato/cezar-contract';
import type { RunRecord } from './store.ts';

/** Malformed authority quarantines only this record, never the whole index or into an eligible root. */
export const storedDelegationStateSchema = delegationStateSchema.optional().catch({ role: 'invalid' });

export function workerOutcome(run: RunRecord, observedAt: string): WorkerOutcome | undefined {
  if (run.delegation?.role !== 'worker') return undefined;
  const status = run.status;
  if (status !== 'review' && status !== 'done' && status !== 'failed' && status !== 'cancelled') return undefined;
  return { workerId: run.id, status, observedAt: run.finishedAt ?? observedAt,
    ...(run.error ? { summary: run.error.slice(0, 4_000) } : {}) };
}
