import type { AgentInput } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import { applyOutcomes, type RunOutcome } from '../../runs/outcome-commit.ts';
import { hasLiveInboxClaim } from '../../delegation/input.ts';
import type { ActiveRun } from '../active-run.ts';
import { chargesBudgetMessage, openWaits, resolvedWaits, waitInputId, waitNamedInputIds } from '../waits.ts';

interface ConversationWakeReads {
  routedAnswer(runId: string): AgentInput | undefined;
  countAutomaticWakes(runId: string, beforeHumanReset?: { spent: number }): number;
  providerOwnsInboxInput(runId: string, inputId: string): boolean;
}

interface WakeReads {
  routedAnswer(runId: string): AgentInput | undefined;
  pendingConversationWakes(run: RunRecord, beforeHumanReset?: { spent: number }): AgentInput[];
}

/** The closing session leaves something undelivered: a resolved wait, or a wake of messages
 *  alone (`owesWake`), which reopens the run as a resolved wait does and so counts against the
 *  same bound (hearsay-tools/cezarion#1235). */
export function owesDelivery(store: Pick<RunStore, 'getRun'>, runId: string, owesWake: (run: RunRecord) => boolean): boolean {
  const run = store.getRun(runId);
  return !!run && (resolvedWaits(run).length > 0 || owesWake(run));
}

/** `outcomes`, clearing the failure count when they deliver a wait result (`cleared`) or leave one
 *  of `ids` a message the agent received (hearsay-tools/cezarion#1235). The opening prompt of a wake
 *  continuation is not one: a session that reads it and fails has delivered nothing it owed, nor
 *  has a read reported for a message whose submission was never acknowledged. */
export function withFailuresCleared(store: Pick<RunStore, 'getRun'>, runId: string, outcomes: RunOutcome[], ids: readonly string[], cleared = false): RunOutcome[] {
  const run = store.getRun(runId);
  const next = run && applyOutcomes(run, outcomes).next;
  const received = !!next?.agentInputs?.some(input => ids.includes(input.id) && !!input.deliveredAt && !input.awaitingRead && (!!input.conversation || isUnnamedLifecycleInput(next, input)));
  return cleared || received ? [...outcomes, { kind: 'counted', waitDeliveryFailures: undefined }] : outcomes;
}

/** A lifecycle input no wait names is a wake of its own, a queued refusal among them
 *  (hearsay-tools/cezarion#1301): `owesDelivery` counts it as owed, so its delivery ends the run
 *  of failed deliveries, as a message's does. */
export function isUnnamedLifecycleInput(run: RunRecord, input: AgentInput): boolean {
  return input.source === 'lifecycle' && !waitNamedInputIds(run).has(input.id);
}

/**
 * Automatic wakes spent since the user last wrote: timer wakes and autonomous nudges, against
 * one budget of `MAX_AUTO_CONTINUES` (hearsay-tools/cezarion#1234). The count is on the run
 * record, so a restart, a scheduler continuation and a usage-limit resume keep it. A timer batch
 * still awaiting its acknowledgement counts the unit it reserved.
 */
export function automaticWakes(store: Pick<RunStore, 'getRun'>, active: Pick<Map<string, ActiveRun>, 'get'>, runId: string, beforeHumanReset?: { spent: number }): number {
  const reserved = active.get(runId)?.agentInputFlight?.wakeReserved ? 1 : 0;
  return (beforeHumanReset?.spent ?? store.getRun(runId)?.automaticWakes ?? 0) + reserved;
}

/**
 * Messages are not waits (hearsay-tools/cezarion#1235): every conversation input the run has not
 * received is an owed wake in its own right, beside its waits and beside a pending question. Not
 * one claimed by an inbox read, one a provider flight or opening already carries, one a resolved
 * wait carries as its wake, or the parent's answer to a routed question, which goes through the
 * answer seam (`answerRoutedQuestion`). A lifecycle input no wait carries any more counts as one:
 * the wake a legacy cancelled worker wait queued before the upgrade, which the wait list keeps as
 * a cancelled entry and delivers as ordinary input, and a refusal queued for a closed session
 * (hearsay-tools/cezarion#1301). One a listed wait or a delivered one names is that wait's, never
 * owed again.
 */
export function pendingConversationWakes(run: RunRecord, reads: ConversationWakeReads, MAX_AUTO_CONTINUES: number, beforeHumanReset?: { spent: number }): AgentInput[] {
  const owed = new Set(resolvedWaits(run).map(waitInputId));
  const named = waitNamedInputIds(run);
  const answer = reads.routedAnswer(run.id);
  // Past the automatic-wake budget a peer message wakes nothing: it stays queued for the next
  // turn (spec 2026-10-27-task-communication-protocol § 8, `holdPeerWakesAtCap`).
  const spent = reads.countAutomaticWakes(run.id, beforeHumanReset) >= MAX_AUTO_CONTINUES;
  return (run.agentInputs ?? []).filter(input => { return (!!input.conversation || (input.source === 'lifecycle' && !named.has(input.id))) &&
    !input.deliveredAt && !hasLiveInboxClaim(input) && !(spent && chargesBudgetMessage(input)) &&
    !owed.has(input.id) && input.id !== answer?.id && !reads.providerOwnsInboxInput(run.id, input.id); });
}

/** A wake is owed: a resolved wait, a message, or a parent's answer the run has not received. */
export function owesWake(run: RunRecord, reads: WakeReads, beforeHumanReset?: { spent: number }): boolean {
  // A pending native question takes nothing but its answer: results and messages wait for the
  // answer's turn end, and a run with no session is not reopened for them, where its provider
  // would ask again (hearsay-tools/cezarion#1235, parent spec § Wakes beside questions).
  if (openWaits(run).some(wait => wait.kind === 'human' && wait.via === 'native-ask')) return reads.routedAnswer(run.id) !== undefined;
  if (resolvedWaits(run).length) return true;
  return reads.pendingConversationWakes(run, beforeHumanReset).length > 0 || reads.routedAnswer(run.id) !== undefined;
}

/** A live session takes a wake at its turn boundary. A native question is mid-turn and takes one
 *  input there: the parent's answer to it, through the answer seam (hearsay-tools/cezarion#505). */
export function takesWake(runId: string, state: ActiveRun, routedAnswer: (runId: string) => AgentInput | undefined): boolean {
  return state.atTurnBoundary === state.session || (!!state.pendingHumanAsk && routedAnswer(runId) !== undefined);
}
