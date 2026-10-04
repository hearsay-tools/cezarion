import type { WorkerCapacity } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

/**
 * Per-parent worker limits (#816, spec 2026-10-04-reclaimable-worker-capacity). Fixed values,
 * never configuration. Capacity bounds owned resources and is reclaimed by verified destroy;
 * the creation ceiling bounds runaway spawning and every receipt-sized payload. Neither is a
 * spending budget: Continue can re-run a worker, and destroy cannot undo earlier charges.
 */
export const WORKER_CAPACITY = 32;
export const WORKER_CREATION_LIMIT = 1_024;

/**
 * Derived from durable state on every call, never counted, so a slot returns exactly once and
 * survives restart and Continue without migration. A receipt is released only by a verified
 * complete destroy, or by history deletion (which requires one); everything else, including a
 * record that vanished without a deletion marker, keeps its slot.
 */
export function workerCapacity(parent: RunRecord, getRun: (id: string) => RunRecord | undefined): WorkerCapacity {
  const receipts = parent.delegation?.role === 'root' ? parent.delegation.receipts : [];
  const outstanding = receipts.filter(receipt => {
    if (receipt.deletion) return false;
    const owned = getRun(receipt.workerId)?.delegation;
    return !(owned?.role === 'worker' && owned.destroy?.phase === 'complete' && owned.destroy.remaining.length === 0);
  }).length;
  return { outstanding, limit: WORKER_CAPACITY, created: receipts.length, creationLimit: WORKER_CREATION_LIMIT };
}

/** The refusal for a NEW creation, naming its recovery; undefined when a creation fits. */
export function capacityError(capacity: WorkerCapacity): string | undefined {
  if (capacity.created >= capacity.creationLimit) return 'Parent reached 1,024 worker creations; start a new task to delegate further';
  if (capacity.outstanding >= capacity.limit) {
    return 'Parent has 32 outstanding workers (accepted, live, or not verifiably destroyed). Collect results, then destroy finished workers to free capacity; incomplete cleanup holds its slot until a retry completes';
  }
  return undefined;
}
