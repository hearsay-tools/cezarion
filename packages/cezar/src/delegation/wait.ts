import type { WorkerOutcome, WorkerWait } from '@open-mercato/cezar-contract';

/** First terminal observations are durable: later snapshots cannot erase or rewrite them. */
export function reconcileWorkerWait(wait: WorkerWait, outcomes: readonly WorkerOutcome[], now: string): WorkerWait {
  const matches = (outcome: WorkerOutcome) => (outcome.revision ?? 0) ===
    (wait.revisions?.find(selection => selection.workerId === outcome.workerId)?.revision ?? 0);
  const collected = wait.outcomes.filter(matches);
  for (const outcome of outcomes) {
    if (matches(outcome) && wait.workerIds.includes(outcome.workerId) && !collected.some(entry => entry.workerId === outcome.workerId)) {
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
  const unchanged = collected.length === wait.outcomes.length && collected.every((entry, index) => entry === wait.outcomes[index]);
  if (!reason) return unchanged ? wait : { ...wait, outcomes: collected };
  if (wait.phase === 'wake-pending' && wait.wakeId && wait.reason === reason && unchanged) return wait;
  return { ...wait, phase: 'wake-pending', reason, outcomes: collected, wakeId: wait.wakeId ?? wait.id };
}
