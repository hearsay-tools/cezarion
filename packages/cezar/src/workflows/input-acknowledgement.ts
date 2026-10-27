import type { ActiveRun } from './active-run.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { chargesBudget, resolvedWaits, waitInputId } from './waits.ts';

/** Facts read when the harness acknowledges its current flight, before its single commit.
 *  Retired markers are cleared here in the same order as the original acknowledgement path. */
export function analyseAcknowledgedInput(runId: string, state: ActiveRun,
  flight: NonNullable<ActiveRun['agentInputFlight']>, inputIds: readonly string[],
  store: Pick<RunStore, 'getRun'>, admitted: ReadonlySet<string>, owesWake: (run: RunRecord) => boolean) {
  const queue = store.getRun(runId)?.agentInputs ?? [];
  if (!queue.some(input => inputIds.includes(input.id) && !input.deliveredAt)) return undefined;
  // One checkpoint per wake batch: every resolved wait it carries is delivered together
  // (hearsay-tools/cezarion#1233); the rest of the batch keeps the ordinary bookkeeping.
  const batch = resolvedWaits(store.getRun(runId) ?? {}).filter(wait => inputIds.includes(waitInputId(wait)));
  const resolvedIds = batch.map(waitInputId);
  // A message an upgraded wait carries as its wake (`wakeInputId`) is still a message: it
  // keeps the conversation bookkeeping beside the wait's delivery.
  const carried = resolvedIds.filter(id => queue.some(input => input.id === id && input.source !== 'lifecycle'));
  const conversationIds = inputIds.filter(id => !resolvedIds.includes(id) || carried.includes(id));
  // Input the harness reported unread while this very POST was pending stays queued:
  // the flush after this acknowledgement resubmits it (#505 review).
  const accepted = conversationIds.filter(id => !state.retiredInFlight?.has(id));
  for (const id of conversationIds) state.retiredInFlight?.delete(id);
  // An observable harness still owes a read: mark it so a restart replays it (#505). A read
  // it reported while this acknowledgement was pending lands with it.
  const observable = state.inputDelivery?.consumption === 'observable';
  const early = observable ? accepted.filter(id => state.consumedBeforeAck?.has(id)) : [];
  // A timer expiry is a self-generated wake: one admitted turn that carries timer results
  // spends the one unit it reserved, however many it carries. CI wakes are external events
  // and do not count.
  const timers = batch.filter(chargesBudget);
  const spent = timers.length && flight.wakeReserved ? (store.getRun(runId)?.automaticWakes ?? 0) + 1 : undefined;
  // A wake of messages alone (hearsay-tools/cezarion#1235) spends its admission the same way;
  // what it still owes is read before its messages are delivered.
  const messageWake = !resolvedIds.length && !!flight.admittedWake && admitted.has(runId);
  const owedBefore = messageWake && owesWake(store.getRun(runId)!);
  const at = new Date().toISOString();
  const resumes = resolvedIds.length > 0 || messageWake;
  return { accepted, resolvedIds, early, spent, observable, at, timers, resumes, owedBefore };
}

export type AcknowledgedInput = NonNullable<ReturnType<typeof analyseAcknowledgedInput>>;
