import type { AgentInput } from '@open-mercato/cezar-contract';
import type { AgentSession } from '../../core/agent-runner.ts';
import type { RunOutcome } from '../../runs/outcome-commit.ts';
import type { ActiveRun } from '../active-run.ts';
import { answerOutcomes, chargedIf, retryDeliveryCheckpoint } from '../outcome-batches.ts';
import { WORKER_FALLBACK_REPLY_NOTE } from '../turn-end.ts';
import { clearUnreadInputTimer, clearHeldHumanInputTimer, harnessOwesInput } from './input-timers.ts';
import type { RunModuleContext } from './types.ts';
import { withFailuresCleared } from './wake-ledger.ts';

export interface InputReceiptsHost {
  reconcileWorkerWaits(): void;
  flushAgentInputs(runId: string): void;
  isCurrentState(runId: string, state: ActiveRun): boolean;
}

/** Only the current session's observation writes consumedAt (hearsay-tools/cezarion#505). An ID reported
 * before its acceptance checkpoint lands is applied when that checkpoint commits. */
export function handleAgentInputConsumed(context: RunModuleContext, host: InputReceiptsHost, runId: string, state: ActiveRun, session: AgentSession | undefined, ids: readonly string[]): void {
  if (!session || !host.isCurrentState(runId, state) || state.session !== session) return;
  const inFlight = state.agentInputFlight?.inputIds ?? [];
  for (const id of ids) if (inFlight.includes(id)) state.consumedBeforeAck?.add(id);
  const read = ids.filter(id => !inFlight.includes(id));
  for (const id of read) state.unreadInputIds?.delete(id);
  if (!harnessOwesInput(state)) clearUnreadInputTimer(state);
  try {
    if (!read.length) return;
    // The read and the failure count it ends are one commit (hearsay-tools/cezarion#1805).
    context.store.commitOutcome(runId, withFailuresCleared(context.store, runId, [{ kind: 'consumed', inputIds: read, at: new Date().toISOString() }], read));
    host.reconcileWorkerWaits(); // projects the consumed receipt
  } catch (error) { console.warn(`[cez] agent input consumption checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
}

/** hearsay-tools/cezarion#505: input the harness accepted but will never read returns to the queue, so
 * DONE, auto-end and park see queued work. Out of a turn (an OpenCode lost wake)
 * it is submitted right away; at a turn-end the handler's own flush submits it. */
export function retireUnreadInputs(context: RunModuleContext, host: InputReceiptsHost, runId: string, state: ActiveRun, ids: readonly string[], outOfTurn: boolean): void {
  if (!ids.length || state.cancelled || !host.isCurrentState(runId, state)) return;
  // Durable first: a failed checkpoint must never let this boundary finish (DONE, park)
  // over input that is still marked delivered but was never read.
  try { context.store.commitOutcome(runId, { kind: 'requeued', inputIds: ids }); }
  catch (error) {
    if (state.agentInputError) return;
    state.agentInputError = `agent input requeue checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
    try { state.session?.interrupt(); } finally {
      try { context.store.appendEvent(runId, { type: 'error', message: state.agentInputError }); }
      catch { console.error(`[cez] ${state.agentInputError}`); }
    }
    return;
  }
  for (const id of ids) state.unreadInputIds?.delete(id);
  // Reported before its own acknowledgement landed: that acknowledgement must not
  // mark it delivered again.
  for (const id of ids) if (state.agentInputFlight?.inputIds.includes(id)) (state.retiredInFlight ??= new Set()).add(id);
  context.store.appendEvent(runId, { type: 'note', message: `resubmitting ${ids.length} message${ids.length === 1 ? '' : 's'} the agent did not read` });
  if (outOfTurn) host.flushAgentInputs(runId);
}

/** hearsay-tools/cezarion#505: the harness started the opening turn, so the opening input was accepted.
 * Its replay-prompt retirement still waits for that turn's successful end. */
export function recordOpeningAccepted(context: RunModuleContext, host: InputReceiptsHost, runId: string, state: ActiveRun): void {
  const id = state.openingAgentInputId;
  if (!id || state.cancelled || !host.isCurrentState(runId, state)) return;
  const inputs = context.store.getRun(runId)?.agentInputs ?? [];
  if (!inputs.some(input => input.id === id && !input.deliveredAt)) return;
  const deliveredAt = new Date().toISOString();
  try { context.store.commitOutcome(runId, { kind: 'delivered', inputIds: [id], at: deliveredAt }); }
  catch (error) { console.warn(`[cez] opening input acceptance checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Bundled messages and answer outcomes commit together. A refused write retries its
 *  accounting best effort; `retryDeliveryCheckpoint` preserves a deferred message's replay
 *  policy (hearsay-tools/cezarion#1805). Returns why the first write was refused. */
export function commitBundledDelivery(context: RunModuleContext, runId: string, state: ActiveRun, ids: readonly string[], also: readonly RunOutcome[] = []): string | undefined {
  const deliveredAt = new Date().toISOString();
  const awaiting = state.inputDelivery?.consumption === 'observable' ? { awaitingRead: true as const } : {};
  const outcomes = [...also, ...(ids.length ? [{ kind: 'delivered' as const, inputIds: ids, at: deliveredAt, ...awaiting }] : [])];
  let refused: string | undefined;
  try { context.store.commitOutcome(runId, outcomes); } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
    console.warn(`[cez] bundled delivery checkpoint failed: ${refused}`);
    const retry = retryDeliveryCheckpoint(context.store, runId, outcomes);
    if (retry.outcomes !== outcomes) return refused;
    if (retry.committed) refused = undefined;
  }
  if (ids.length) state.bundledInputIds = [...(state.bundledInputIds ?? []), ...ids];
  return refused;
}

/** The fallback reply's charge, the question it answers and the reply it delivers are one commit
 *  (hearsay-tools/cezarion#1805): no restart reads the charge without the reply. */
export function commitRoutedAnswer(context: RunModuleContext, runId: string, state: ActiveRun, delivered: readonly string[], fallback: boolean, maxAutoContinues: number): void {
  const spent = fallback ? (context.store.getRun(runId)?.automaticWakes ?? 0) + 1 : undefined;
  commitBundledDelivery(context, runId, state, delivered, [{ kind: 'answered' }, ...chargedIf(spent)]);
  if (spent !== undefined) context.store.appendEvent(runId, { type: 'note', message: `${WORKER_FALLBACK_REPLY_NOTE} (${spent}/${maxAutoContinues})` });
}

/** One commit (hearsay-tools/cezarion#1805): the human waits a message answers, the messages bundled
 *  with it and a deferred message's queue entry. A refused queue entry interrupts the session:
 *  stdin and disk cannot transact, so it stays for conservative recovery. */
export function commitAnswer(context: RunModuleContext, runId: string, state: ActiveRun, bundle: { inputs: AgentInput[] } | undefined, messageId: string | undefined): void {
  const refused = commitBundledDelivery(context, runId, state, bundle?.inputs.map(input => input.id) ?? [], answerOutcomes(messageId, context.store.getRun(runId)?.automaticWakes));
  if (!refused || !messageId) return;
  state.agentInputError = `human input delivery checkpoint failed: ${refused}`;
  state.session?.interrupt();
}

/** The turn that carried bundled messages has ended: the model read them. */
export function readBundledInputs(context: RunModuleContext, host: InputReceiptsHost, runId: string, state: ActiveRun): void {
  const ids = state.bundledInputIds ?? [];
  state.bundledInputIds = undefined;
  if (!ids.length || state.cancelled) return;
  try { context.store.commitOutcome(runId, { kind: 'consumed', inputIds: ids, at: new Date().toISOString() }); host.reconcileWorkerWaits(); }
  catch (error) { console.warn(`[cez] bundled read checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); }
}

/** hearsay-tools/cezarion#505: the session closed without reporting it read (failure, stop, exit): the input
 * goes back to the queue so a later session delivers it; never shown as delivered. */
export function requeueUnreadAtClose(context: RunModuleContext, host: InputReceiptsHost, runId: string, state: ActiveRun, session: AgentSession | undefined): void {
  clearUnreadInputTimer(state);
  clearHeldHumanInputTimer(state);
  // Everything this session accepted but never saw read: steered input, messages bundled
  // behind a human answer, and an opening instruction whose turn never succeeded.
  const opening = state.openingAgentInputId && context.store.getRun(runId)?.agentInputs?.some(input =>
    input.id === state.openingAgentInputId && input.deliveredAt && !input.consumedAt) ? [state.openingAgentInputId] : [];
  const ids = [...new Set([...(state.unreadInputIds ?? []), ...(state.bundledInputIds ?? []), ...opening])];
  if (!session || !ids.length || !host.isCurrentState(runId, state) || state.session !== session) return;
  state.unreadInputIds?.clear();
  state.bundledInputIds = undefined;
  try { context.store.commitOutcome(runId, { kind: 'requeued', inputIds: ids }); }
  catch (error) { console.warn(`[cez] agent input requeue failed: ${error instanceof Error ? error.message : String(error)}`); }
}

