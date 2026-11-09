import type { RequestOutcome, WorkerOutcome } from '@open-mercato/cezar-contract';
import type { WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';

/** Keep the first matching observation for each selected worker revision. */
function workerObservations(entry: WorkerWaitEntry, outcomes: readonly WorkerOutcome[]): WorkerOutcome[] {
  const matches = (outcome: WorkerOutcome) => (outcome.revision ?? 0) ===
    (entry.revisions?.find(selection => selection.workerId === outcome.workerId)?.revision ?? 0);
  const collected = (entry.outcomes ?? []).filter(matches);
  for (const outcome of outcomes) {
    if (matches(outcome) && entry.workerIds?.includes(outcome.workerId) && !collected.some(previous => previous.workerId === outcome.workerId)) collected.push(outcome);
  }
  return collected;
}

/** Request settlement is independent of worker lifecycle and transport acceptance. */
function requestObservations(entry: WorkerWaitEntry, outcomes: readonly RequestOutcome[]): RequestOutcome[] {
  const collected = [...(entry.requestOutcomes ?? [])];
  for (const outcome of outcomes) {
    if (entry.requestIds?.includes(outcome.requestId) && !collected.some(previous => previous.requestId === outcome.requestId)) collected.push(outcome);
  }
  return collected;
}

/** Reconcile an open entry, keeping its identity when its first observations have not changed. */
export function reconcileWorkerEntry<E extends WorkerWaitEntry>(entry: E, outcomes: readonly WorkerOutcome[], now: string, requestOutcomes: readonly RequestOutcome[] = []): { entry: E; reason?: 'outcome' | 'timeout' } {
  if (entry.phase !== 'open') return { entry };
  const observed = observeEntry(entry, outcomes, requestOutcomes);
  const satisfied = entry.requestIds
    ? selectionsSatisfied(entry.mode, entry.requestIds, (observed.requestOutcomes ?? []).map(outcome => outcome.requestId))
    : selectionsSatisfied(entry.mode, entry.workerIds ?? [], (observed.outcomes ?? []).map(outcome => outcome.workerId));
  const reason = satisfied ? 'outcome' : entry.deadline !== undefined && Date.parse(now) >= Date.parse(entry.deadline) ? 'timeout' : undefined;
  return reason ? { entry: observed, reason } : { entry: observed };
}

function selectionsSatisfied(mode: WorkerWaitEntry['mode'], selected: readonly string[], reported: readonly string[]): boolean {
  return mode === 'all' ? selected.every(id => reported.includes(id)) : reported.length > 0;
}

function observeEntry<E extends WorkerWaitEntry>(entry: E, outcomes: readonly WorkerOutcome[], requestOutcomes: readonly RequestOutcome[]): E {
  if (entry.requestIds) {
    const collected = requestObservations(entry, requestOutcomes);
    return collected.length === (entry.requestOutcomes?.length ?? 0) ? entry : { ...entry, requestOutcomes: collected };
  }
  const collected = workerObservations(entry, outcomes);
  const previous = entry.outcomes ?? [];
  return collected.length === previous.length && collected.every((outcome, index) => outcome === previous[index]) ? entry : { ...entry, outcomes: collected };
}
