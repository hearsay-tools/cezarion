import type { WorkerOutcome, WorkerWait } from '@open-mercato/cezar-contract';

/** First terminal observations are durable: later snapshots cannot erase or rewrite them. */
export function reconcileWorkerWait(wait: WorkerWait, outcomes: readonly WorkerOutcome[], now: string): WorkerWait {
  const collected = [...wait.outcomes];
  for (const outcome of outcomes) {
    if (wait.workerIds.includes(outcome.workerId) && !collected.some(entry => entry.workerId === outcome.workerId)) {
      collected.push(outcome);
    }
  }
  const satisfies = (entries: readonly WorkerOutcome[]) => (wait.mode ?? 'any') === 'all'
    ? wait.workerIds.every(id => entries.some(outcome => outcome.workerId === id))
    : entries.length > 0;
  // An old pending record already settled. Infer from its persisted observations,
  // before adding new outcomes, so later wall time cannot change why it woke.
  const reason = wait.reason ?? (wait.phase === 'wake-pending'
    ? satisfies(wait.outcomes) ? 'outcome' : 'timeout'
    : satisfies(collected) ? 'outcome' : Date.parse(now) >= Date.parse(wait.deadline) ? 'timeout' : undefined);
  if (!reason) return collected.length === wait.outcomes.length ? wait : { ...wait, outcomes: collected };
  if (wait.phase === 'wake-pending' && wait.wakeId && wait.reason === reason && collected.length === wait.outcomes.length) return wait;
  return { ...wait, phase: 'wake-pending', reason, outcomes: collected, wakeId: wait.wakeId ?? wait.id };
}
