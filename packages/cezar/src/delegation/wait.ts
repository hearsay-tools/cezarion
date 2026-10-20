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

/**
 * `reconcileWorkerWait` for a `worker` entry in the wait list (hearsay-tools/cezarion#1235): the
 * same revision matching, `all`/`any` rule and durable first observations, by running the entry
 * through it as an open legacy wait. `reason` is set once the entry should resolve; a settled
 * entry is returned as it is. An unchanged open entry comes back as the same object.
 */
export function reconcileWorkerEntry<E extends WorkerWaitEntry>(entry: E, outcomes: readonly WorkerOutcome[], now: string, requestOutcomes: readonly RequestOutcome[] = []): { entry: E; reason?: 'outcome' | 'timeout' } {
  if (entry.phase !== 'open') return { entry };
  // Cezar's completion wait has no deadline and never times out (hearsay-tools/cezarion#1301); the
  // legacy shape needs one, which stays inside this call.
  const legacy: WorkerWait = { id: entry.id, workerIds: entry.workerIds ?? [], deadline: entry.deadline ?? NEVER, phase: 'registered', outcomes: entry.outcomes ?? [],
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    ...(entry.revisions === undefined ? {} : { revisions: entry.revisions }),
    ...(entry.requestIds === undefined ? {} : { requestIds: entry.requestIds, requestOutcomes: entry.requestOutcomes ?? [] }) };
  const next = reconcileWorkerWait(legacy, outcomes, now, requestOutcomes);
  const reason = next.reason === 'outcome' || next.reason === 'timeout' ? next.reason : undefined;
  const changed = entry.requestIds
    ? (next.requestOutcomes?.length ?? 0) !== (entry.requestOutcomes?.length ?? 0)
    : next.outcomes.length !== (entry.outcomes?.length ?? 0) || next.outcomes.some((outcome, index) => outcome !== entry.outcomes?.[index]);
  const observed = !changed ? entry : entry.requestIds ? { ...entry, requestOutcomes: next.requestOutcomes ?? [] } : { ...entry, outcomes: next.outcomes };
  return reason ? { entry: observed, reason } : { entry: observed };
}
