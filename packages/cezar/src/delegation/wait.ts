import type { WorkerOutcome, WorkerWait } from '@open-mercato/cezar-contract';

/** First terminal observations are durable: later snapshots cannot erase or rewrite them. */
export function reconcileWorkerWait(wait: WorkerWait, outcomes: readonly WorkerOutcome[], now: string): WorkerWait {
  const collected = [...wait.outcomes];
  for (const outcome of outcomes) {
    if (wait.workerIds.includes(outcome.workerId) && !collected.some(entry => entry.workerId === outcome.workerId)) {
      collected.push(outcome);
    }
  }
  if (!collected.length && Date.parse(now) < Date.parse(wait.deadline) && wait.phase !== 'wake-pending') return wait;
  if (wait.phase === 'wake-pending' && wait.wakeId && collected.length === wait.outcomes.length) return wait;
  return { ...wait, phase: 'wake-pending', outcomes: collected, wakeId: wait.wakeId ?? wait.id };
}
