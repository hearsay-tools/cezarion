import { isSquawkHumanWait } from './run/wait-kinds.ts';
import { WAIT_KINDS } from './run/wait-kinds.ts';
import { type ProcessWaitResult, type PeerWaitResult, type SubagentWaitResult } from '@open-mercato/cezar-contract/waits';
import type { CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { AgentInput, CiWait, OpenWait, PrWaitEntry, RunRecord, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';

/**
 * Pure wait-list readers and agent-facing text. RunManager owns registration, resolution and
 * delivery.
 */

/** `cezar_cancel_wait` answers that cancel nothing (hearsay-tools/cezarion#1233). */
export const CANCEL_MESSAGES = {
  not_found: 'No open wait has this wait_id. open_waits lists the waits still open.',
  already_resolved: 'This wait already resolved; its result arrives with your next wake. Cancelling it changed nothing.',
  human_question: 'The user already sees this question, so only their answer closes it. End your turn to wait for the answer.',
} as const;

/** A run that failed while it still owed wait results keeps them, and its open waits, until a human
 *  acts: Continue delivers them, Stop discards them (hearsay-tools/cezarion#1233). */
export const holdsOwedResults = (run: RunRecord): boolean => run.status === 'failed' && resolvedWaits(run).length > 0;

/** The inputs a listed wait, or a delivered one, names: that wait's own, never a wake of their own
 *  (hearsay-tools/cezarion#1301). */
export function waitNamedInputIds(run: RunRecord): Set<string> {
  return new Set([...run.waits ?? [], ...(run.lastWaits ?? []).filter(wait => wait.phase === 'delivered')].flatMap(wait => [wait.id, waitInputId(wait)]));
}

/** The kind a `cezar_wait` answer names: the kind the call asked for. A request wait is stored as a
 *  `worker` entry with `requestIds` (hearsay-tools/cezarion#1995). */
export function waitAnswerKind(wait: Wait): Exclude<Wait['kind'], 'human' | 'subagent'> | 'request' {
  const kind = WAIT_KINDS[wait.kind].answerKind(wait);
  if (kind === undefined) throw new Error(`a ${wait.kind} wait is not a cezar_wait answer`);
  return kind;
}

/** Waits still waiting for their event, in list order. */
export function openWaits(run: Pick<RunRecord, 'waits'>): Wait[] {
  return (run.waits ?? []).filter((wait) => wait.phase === 'open');
}

/** Waits whose event fired and whose result is not delivered yet, oldest `resolvedAt` first:
 *  the order a wake delivers them in. */
export function resolvedWaits(run: Pick<RunRecord, 'waits'>): Wait[] {
  const at = (wait: Wait) => Date.parse(wait.resolvedAt ?? wait.registeredAt);
  return (run.waits ?? []).filter((wait) => wait.phase === 'resolved').sort((a, b) => at(a) - at(b));
}

/** The kind row decides charging from the durable result. Empty dependency deadlines are
 * free; explicit timers, safety deadlines and substantive outcomes keep their own policy. */
export function chargesBudget(wait: Wait): boolean {
  const charge = WAIT_KINDS[wait.kind].chargesWake;
  return typeof charge === 'function' ? charge(wait) : charge;
}

/**
 * A peer message counts against the same budget when it starts a turn: two root tasks have no
 * parent to stop a loop between them. Family messages never count (spec
 * 2026-10-27-task-communication-protocol § 8).
 */
export function chargesBudgetMessage(input: Pick<AgentInput, 'conversation'>): boolean {
  return input.conversation?.relationship === 'peer';
}

/** The open waits as both tools list them back to the agent. A human wait has no deadline, and
 *  Cezar's own deadline-less worker wait is not the agent's to list (hearsay-tools/cezarion#1301). */
export function openWaitList(waits: readonly Wait[]): OpenWait[] {
  return waits.filter((wait) => wait.phase === 'open' && !isSquawkHumanWait(wait) && (WAIT_KINDS[wait.kind].deadline === 'none' || WAIT_KINDS[wait.kind].hasDeadline(wait))).map((wait): OpenWait => WAIT_KINDS[wait.kind].deadline === 'none'
    ? { wait_id: wait.id, kind: wait.kind as 'human', summary: WAIT_KINDS[wait.kind].summary(wait) }
    : { wait_id: wait.id, kind: wait.kind as Exclude<Wait['kind'], 'human'>, deadline: ('deadline' in wait ? wait.deadline : undefined)!, summary: WAIT_KINDS[wait.kind].summary(wait) });
}

export { identicalWait } from './run/wait-kinds.ts';
export const identicalWorkerWait = WAIT_KINDS.worker.duplicateWorker;
export const identicalPeerWait = WAIT_KINDS.peer.duplicatePeer;

/** The agent input that delivers a resolved wait's result: the wait's own id, or for an upgraded
 *  worker wait whose wake was already queued, that input (`wakeInputId`). */
export function waitInputId(wait: Wait): string {
  return WAIT_KINDS[wait.kind].inputId(wait);
}

/** The CI watcher still speaks the schema-3 `CiWait`; an open entry is a parked one to it. */
export function ciWatchRequest(wait: PrWaitEntry): CiWait {
  const { id, prUrl, repository, prNumber, headSha, generation, turnId, timeoutSeconds, until, wakeOnConflict, registeredAt, deadline } = wait;
  return { id, prUrl, repository, prNumber, headSha, generation, turnId, timeoutSeconds, until, wakeOnConflict, registeredAt, deadline, phase: 'parked' };
}

/** An open or resolved PR wait: it holds conversation input for its own wake (#476). */
export function hasPrWait(run: Pick<RunRecord, 'waits'>): boolean {
  return (run.waits ?? []).some((wait) => WAIT_KINDS[wait.kind].holdsConversationInput && (wait.phase === 'open' || wait.phase === 'resolved'));
}

export const timerWaitEntry = WAIT_KINDS.timer.entry;
export const prWaitEntry = WAIT_KINDS.pr.entry;
export const processWaitEntry = WAIT_KINDS.process.entry;

export type WaitResult = CiWaitResult | ProcessWaitResult | PeerWaitResult | SubagentWaitResult;

export function settledWaitEntry(latest: Wait, result: WaitResult | undefined, observed: WorkerWaitEntry | undefined, resolvedAt: string): Wait {
  return WAIT_KINDS[latest.kind].resolve(latest, result, observed, resolvedAt);
}

export { normalizePrUrl, isSquawkHumanWait, isMonitoringTimer, MONITORING_WAKE_NUDGE, waitResultText, subagentWaitResultText, describeWait, openWaitsFooter } from './run/wait-kinds.ts';
