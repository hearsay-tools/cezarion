import type { RequestOutcome, WorkerOutcome, WorkerWait } from '@open-mercato/cezar-contract';
import type { WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';

const NEVER = '9999-12-31T23:59:59.999Z';

/** First terminal observations are durable: later snapshots cannot erase or rewrite them. */
export function reconcileWorkerWait(wait: WorkerWait, outcomes: readonly WorkerOutcome[], now: string, requestOutcomes: readonly RequestOutcome[] = []): WorkerWait {
  if (wait.requestIds) return reconcileRequestWait(wait, requestOutcomes, now);
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

/** Request settlement is independent of worker lifecycle and transport acceptance. */
function reconcileRequestWait(wait: WorkerWait, outcomes: readonly RequestOutcome[], now: string): WorkerWait {
  const selected = wait.requestIds!;
  const collected = [...(wait.requestOutcomes ?? [])];
  for (const outcome of outcomes) {
    if (selected.includes(outcome.requestId) && !collected.some(previous => previous.requestId === outcome.requestId)) collected.push(outcome);
  }
  const satisfies = (entries: readonly RequestOutcome[]) => wait.mode === 'all'
    ? selected.every(id => entries.some(outcome => outcome.requestId === id)) : entries.length > 0;
  const reason = wait.reason ?? (wait.phase === 'wake-pending'
    ? satisfies(wait.requestOutcomes ?? []) ? 'outcome' : 'timeout'
    : satisfies(collected) ? 'outcome' : Date.parse(now) >= Date.parse(wait.deadline) ? 'timeout' : undefined);
  const unchanged = collected.length === (wait.requestOutcomes?.length ?? 0);
  if (!reason) return unchanged ? wait : { ...wait, requestOutcomes: collected };
  if (wait.phase === 'wake-pending' && wait.wakeId && wait.reason === reason && unchanged) return wait;
  return { ...wait, phase: 'wake-pending', reason, requestOutcomes: collected, wakeId: wait.wakeId ?? wait.id };
}

/** Open wait-list entry as the legacy `WorkerWait` `reconcileWorkerWait` already implements. */
function legacyWorkerWait(entry: WorkerWaitEntry): WorkerWait {
  return { id: entry.id, workerIds: entry.workerIds ?? [], deadline: entry.deadline ?? NEVER, phase: 'registered', outcomes: entry.outcomes ?? [],
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    ...(entry.revisions === undefined ? {} : { revisions: entry.revisions }),
    ...(entry.requestIds === undefined ? {} : { requestIds: entry.requestIds, requestOutcomes: entry.requestOutcomes ?? [] }) };
}

/** First observations stay on the entry object; an unchanged open entry is the same object. */
function observedWorkerEntry<E extends WorkerWaitEntry>(entry: E, next: WorkerWait): E {
  const changed = entry.requestIds
    ? (next.requestOutcomes?.length ?? 0) !== (entry.requestOutcomes?.length ?? 0)
    : next.outcomes.length !== (entry.outcomes?.length ?? 0) || next.outcomes.some((outcome, index) => outcome !== entry.outcomes?.[index]);
  return !changed ? entry : entry.requestIds ? { ...entry, requestOutcomes: next.requestOutcomes ?? [] } : { ...entry, outcomes: next.outcomes };
}

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
