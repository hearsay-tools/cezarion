import { randomUUID } from 'node:crypto';
import type { CezarWaitRequest, WaitVia, ProcessWaitResult, PeerWaitResult } from '@open-mercato/cezar-contract/waits';
import type { CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import type { AgentInput, CezarWaitRequestInput, CiWait, OpenWait, PeerWaitEntry, PrWaitEntry, ProcessWaitEntry, RunRecord, TimerWaitEntry, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';

/**
 * Pure wait-list readers and agent-facing text. RunManager owns registration, resolution and
 * delivery.
 */

/** What a monitoring timer (the monitoring line or Claude's `ScheduleWakeup`) says when it fires. */
export const MONITORING_WAKE_NUDGE =
  'Re-check the downstream work you were monitoring. Continue toward the task goal. When the goal is complete and verified, call cezar_done. If the watched work is still pending, call cezar_wait again. If you need the user, call cezar_ask.';

/** hearsay-tools/cezarion#1234: the same wake for a session without cezar tools, whose prompt
 *  taught the lifecycle markers. */
export const MONITORING_WAKE_NUDGE_MARKERS =
  'Re-check the downstream work you were monitoring. Continue toward the task goal. When the watched work is finished and the task goal is complete, end your final message with CEZ:DONE. If the watched work is still pending, end with CEZ:MONITORING. Never yield markerless for a monitoring wrap-up. If you genuinely need user input, follow the normal question path instead.';

const SUMMARY_MAX = 256;

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
export function waitAnswerKind(wait: Wait): Exclude<Wait['kind'], 'human'> | 'request' {
  if (wait.kind === 'human') throw new Error('a human wait is not a cezar_wait answer');
  return wait.kind === 'worker' && wait.requestIds ? 'request' : wait.kind;
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

/** Monitoring timers: the timers Cezar opens for the monitoring line and `ScheduleWakeup`. */
export function isMonitoringTimer(wait: Wait): boolean {
  return wait.kind === 'timer' && (wait.via === 'monitoring-line' || wait.via === 'schedule-wakeup');
}

/**
 * Timer and process waits count against the automatic-wake budget, including a process used as a
 * delayed timer. So does a peer wait: two root tasks have no parent to stop a loop between them
 * (spec 2026-10-27-task-communication-protocol § 8, hearsay-tools/cezarion#1995).
 */
export function chargesBudget(wait: Wait): boolean {
  return wait.kind === 'timer' || wait.kind === 'process' || wait.kind === 'peer';
}

/**
 * A peer message counts against the same budget when it starts a turn: two root tasks have no
 * parent to stop a loop between them. Family messages never count (spec
 * 2026-10-27-task-communication-protocol § 8).
 */
export function chargesBudgetMessage(input: Pick<AgentInput, 'conversation'>): boolean {
  return input.conversation?.relationship === 'peer';
}

/** Cezar's own human wait (`no-wait`, `budget`): it stands in for a wait the agent never registered
 *  and is replaced by the agent's own (hearsay-tools/cezarion#1234), so the agent is never told of
 *  it as one of its waits. */
export function isCezarHumanWait(wait: Wait): boolean {
  return wait.kind === 'human' && wait.source === 'cezar';
}

/** One PR, however the agent spelled it: case-insensitive, trailing slash ignored. */
export function normalizePrUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

function clip(text: string, max = SUMMARY_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summary(wait: Wait): string {
  if (wait.kind === 'pr') return clip(`${wait.until === 'merge' ? 'merge of' : 'CI for'} ${wait.repository}#${wait.prNumber}`);
  if (wait.kind === 'human') {
    const first = wait.questions?.[0]?.question;
    return first === undefined ? 'human question' : clip(`human: ${first}`);
  }
  if (wait.kind === 'worker') return clip(`${wait.requestIds ? 'request' : 'worker'} wait on ${workerTargetPhrase(wait)}`);
  if (wait.kind === 'peer') return clip(`peer wait on ${peerTargetPhrase(wait)}`);
  if (wait.kind === 'process') return clip(wait.note === undefined ? `process ${wait.pid}` : `process ${wait.pid}: ${wait.note}`);
  return clip(wait.note === undefined ? 'timer' : `timer: ${wait.note}`);
}

/** The open waits as both tools list them back to the agent. A human wait has no deadline, and
 *  Cezar's own deadline-less worker wait is not the agent's to list (hearsay-tools/cezarion#1301). */
export function openWaitList(waits: readonly Wait[]): OpenWait[] {
  return waits.filter((wait) => wait.phase === 'open' && !isCezarHumanWait(wait) && !(wait.kind === 'worker' && wait.deadline === undefined)).map((wait): OpenWait => wait.kind === 'human'
    ? { wait_id: wait.id, kind: wait.kind, summary: summary(wait) }
    : { wait_id: wait.id, kind: wait.kind, deadline: wait.deadline!, summary: summary(wait) });
}

/**
 * The open wait a registration repeats, if any. PR: the same PR, target and conflict switch, whatever
 * its timeout (hearsay-tools/cezarion#1425). Timer: the
 * same seconds and note, registered in the same turn (a later turn asking again means a new check).
 * Process: the same PID, start token and resolved exit file in `context`, whatever its timeout or
 * note (hearsay-tools/cezarion#1446).
 */
export function identicalWait(waits: readonly Wait[], request: CezarWaitRequestInput, turnId: string,
  context: { startToken?: string; exitFile?: string } = {}): PrWaitEntry | TimerWaitEntry | ProcessWaitEntry | undefined {
  return waits.find((wait): wait is PrWaitEntry | TimerWaitEntry | ProcessWaitEntry => {
    // Worker and request waits: `identicalWorkerWait`; peer waits: `identicalPeerWait`.
    if (wait.phase !== 'open' || request.kind === 'worker' || request.kind === 'request' || request.kind === 'peer') return false;
    if (request.kind === 'pr') return wait.kind === 'pr' && normalizePrUrl(wait.prUrl) === normalizePrUrl(request.pr)
      && wait.until === (request.until ?? 'checks') && wait.wakeOnConflict === (request.wake_on_conflict ?? true);
    if (request.kind === 'process') {
      return wait.kind === 'process' && wait.pid === request.pid && wait.startToken === context.startToken && wait.exitFile === context.exitFile;
    }
    return wait.kind === 'timer' && wait.seconds === request.seconds && wait.note === request.note && wait.turnId === turnId;
  });
}

/**
 * The open worker wait a registration repeats (hearsay-tools/cezarion#1235): the same target kind,
 * the same ids in any order and the same mode (`any` when omitted), whatever its timeout.
 */
export function identicalWorkerWait(waits: readonly Wait[], target: { workerIds?: readonly string[]; requestIds?: readonly string[] | undefined; mode?: string | undefined }): WorkerWaitEntry | undefined {
  const key = (ids: readonly string[] | undefined) => ids ? [...ids].sort().join(',') : undefined;
  return waits.find((wait): wait is WorkerWaitEntry => wait.kind === 'worker' && wait.phase === 'open' &&
    key(wait.workerIds) === key(target.workerIds) && key(wait.requestIds) === key(target.requestIds) && (wait.mode ?? 'any') === (target.mode ?? 'any'));
}

/** The open peer wait a registration repeats (hearsay-tools/cezarion#1995): the same peers in any
 *  order, whatever its timeout. */
export function identicalPeerWait(waits: readonly Wait[], peerIds: readonly string[]): PeerWaitEntry | undefined {
  const key = (ids: readonly string[]) => [...ids].sort().join(',');
  return waits.find((wait): wait is PeerWaitEntry => wait.kind === 'peer' && wait.phase === 'open' && key(wait.peerIds) === key(peerIds));
}

/** The agent input that delivers a resolved wait's result: the wait's own id, or for an upgraded
 *  worker wait whose wake was already queued, that input (`wakeInputId`). */
export function waitInputId(wait: Wait): string {
  return wait.kind === 'worker' ? wait.wakeInputId ?? wait.id : wait.id;
}

/** The CI watcher still speaks the schema-3 `CiWait`; an open entry is a parked one to it. */
export function ciWatchRequest(wait: PrWaitEntry): CiWait {
  const { id, prUrl, repository, prNumber, headSha, generation, turnId, timeoutSeconds, until, wakeOnConflict, registeredAt, deadline } = wait;
  return { id, prUrl, repository, prNumber, headSha, generation, turnId, timeoutSeconds, until, wakeOnConflict, registeredAt, deadline, phase: 'parked' };
}

/** The lifecycle input a resolved wait delivers. Its id is the wait's, so duplicates keep it.
 *  `workerStatus` names a worker's current status for a worker wait's text. */
export function waitResultText(wait: Wait, { tools, workerStatus = () => 'unavailable' }: { tools: boolean; workerStatus?: (workerId: string) => string } = { tools: true }): string {
  if (wait.kind === 'pr') {
    if (wait.until === 'merge') return `PR wait observation ${wait.id} for ${wait.prUrl} (until merge). External data follows: ${JSON.stringify(wait.result)}. "merged" means GitHub reports the PR merged and "closed" that it closed without merging; any other outcome means this wait did not confirm a merge, not that the PR is unmerged. Duplicate observations retain this ID.`;
    return `CI wait observation ${wait.id} for ${wait.prUrl}. External data follows: ${JSON.stringify(wait.result)}. This observation is not merge approval or task completion. Reported checks may not include every expected workflow. Duplicate observations retain this ID.`;
  }
  if (isMonitoringTimer(wait)) return tools ? MONITORING_WAKE_NUDGE : MONITORING_WAKE_NUDGE_MARKERS;
  // The user's own message is a human wait's result; this text is never its delivery.
  if (wait.kind === 'human') return `Human wait ${wait.id} ended.`;
  if (wait.kind === 'worker') return workerWaitResultText(wait, workerStatus);
  if (wait.kind === 'process') return processWaitResultText(wait);
  if (wait.kind === 'peer') return peerWaitResultText(wait);
  const fired = `Timer ${wait.id} fired${wait.note === undefined ? '' : `: ${wait.note}`}.`;
  // A session without cezar tools cannot register another wait; it was taught the marker.
  return tools
    ? `${fired} Continue toward the task goal; register another wait if you are still waiting.`
    : `${fired} Continue toward the task goal. If the watched work is still pending, end your final message with CEZ:MONITORING.`;
}

/**
 * A worker wait's result, worded as `cez worker wait`'s wake always was
 * (hearsay-tools/cezarion#1235). 32 summaries, including worst-case JSON escaping, must fit the
 * ordinary input bound, so each is abbreviated; the full ones stay in the outcomes and events.
 */
function workerWaitResultText(wait: WorkerWaitEntry, workerStatus: (workerId: string) => string): string {
  const reason = wait.result?.reason ?? 'timeout';
  if (wait.requestIds) {
    return `Request wait ${wait.id} (${reason}). Request outcomes: ${JSON.stringify(wait.requestOutcomes ?? [])}. This is not worker completion or review approval.`;
  }
  const outcomes = (wait.outcomes ?? []).map(outcome => ({ ...outcome, ...(outcome.summary ? { summary: outcome.summary.slice(0, 256) } : {}) }));
  return `Worker wait ${wait.id} (${reason === 'timeout' ? 'deadline reached' : 'terminal outcome'}). ` +
    `Collect each worker's latest settled result before completing the parent. Review is not merge permission. Selected workers: ${JSON.stringify((wait.workerIds ?? []).map(workerId => ({
      workerId, status: workerStatus(workerId),
    })))}. Outcomes (summaries abbreviated): ${JSON.stringify(outcomes)}`;
}

/** A process wait's result (hearsay-tools/cezarion#1446). Only the outcome and an integer exit code
 *  come from Cezar; the agent reads the command's own output with its tools. */
function processWaitResultText(wait: ProcessWaitEntry): string {
  const head = `Process wait ${wait.id} for PID ${wait.pid}${wait.note === undefined ? '' : ` (${wait.note})`}`;
  const read = "Read the command's output with your own tools.";
  const result = wait.result;
  if (result?.outcome === 'exit_file') return `${head}: ${result.exitCode === undefined ? 'exit file present, not an exit code' : `exited with code ${result.exitCode}`}. ${read}`;
  if (result?.outcome === 'exited') return `${head}: exited, code unknown. ${read}`;
  if (result?.outcome === 'error') return `${head}: could not be checked (${result.diagnostic ?? 'unknown error'}). Check it with your own tools.`;
  return `${head}: still running at the deadline. Register another wait if you still need it.`;
}

/** A peer wait's result (hearsay-tools/cezarion#1995). The message itself arrives as its own
 *  input in the same wake; this names only why the wait ended. */
function peerWaitResultText(wait: PeerWaitEntry): string {
  const result = wait.result;
  const head = `Peer wait ${wait.id} on ${peerTargetPhrase(wait)}`;
  if (result?.reason === 'message') return `${head}: task ${result.peerRunId ?? 'unknown'} sent message ${result.messageId ?? 'unknown'}, delivered with this wake. Register another peer wait if you still wait on it.`;
  if (result?.reason === 'settled') return `${head}: task ${result.peerRunId ?? 'unknown'} settled or was deleted; it will not write again until its human continues it. Read its status with cez message tasks.`;
  return `${head}: deadline reached with no message. Register another peer wait if you still wait on it.`;
}

function peerTargetPhrase(wait: PeerWaitEntry): string {
  const n = wait.peerIds.length;
  return n === 1 ? `task ${wait.peerIds[0]}` : `${n} tasks`;
}

function workerTargetPhrase(wait: WorkerWaitEntry): string {
  const n = (wait.requestIds ?? wait.workerIds)?.length ?? 0;
  return wait.requestIds ? `${n} ${n === 1 ? 'reply' : 'replies'}` : `${n} ${n === 1 ? 'worker' : 'workers'}`;
}

/** One wait as the footer names it. A worker's park notice names its waits the same way
 *  (hearsay-tools/cezarion#1327). */
export function describeWait(wait: Wait): string {
  if (wait.kind === 'pr') return `${wait.until === 'merge' ? 'merge' : 'CI'} wait ${wait.id} for ${wait.repository}#${wait.prNumber}, deadline ${wait.deadline}`;
  if (wait.kind === 'human') return `your question ${wait.id} to the user`;
  // Cezar's completion wait has no deadline (hearsay-tools/cezarion#1301).
  if (wait.kind === 'worker') return `${wait.requestIds ? 'request' : 'worker'} wait ${wait.id} on ${workerTargetPhrase(wait)}, ${wait.deadline === undefined ? 'no deadline' : `deadline ${wait.deadline}`}`;
  if (wait.kind === 'peer') return `peer wait ${wait.id} on ${peerTargetPhrase(wait)}, deadline ${wait.deadline}`;
  if (wait.kind === 'process') return `process wait ${wait.id} on PID ${wait.pid}${wait.note === undefined ? '' : ` (${wait.note})`}, deadline ${wait.deadline}`;
  return `timer ${wait.id} at ${wait.deadline}${wait.note === undefined ? '' : ` (${wait.note})`}`;
}

/** The footer a delivered turn ends with: every wait still open, or undefined when none is. The
 *  user's reply settles a question and a question the user saw cannot be cancelled, so cancel is
 *  offered only for CI, worker, request, peer and process waits and timers (hearsay-tools/cezarion#1234), and only
 *  when the session has cezar tools (hearsay-tools/cezarion#1270). */
export function openWaitsFooter(waits: readonly Wait[], { tools }: { tools: boolean } = { tools: true }): string | undefined {
  const open = waits.filter((wait) => wait.phase === 'open' && !isCezarHumanWait(wait));
  if (!open.length) return undefined;
  const items = open.map(describeWait);
  const asked = open.some((wait) => wait.kind === 'human');
  const cancellable = open.some((wait) => wait.kind !== 'human');
  if (!tools) return `Still open: ${items.join('; ')}.${asked ? " The user's reply answers it." : ''}`;
  const close = !asked ? 'Call cezar_cancel_wait for any you no longer need.'
    : cancellable ? "The user's reply answers your question; call cezar_cancel_wait for any CI, worker, request, peer or process wait or timer you no longer need."
    : "The user's reply answers it.";
  return `Still open: ${items.join('; ')}. ${close}`;
}

/** An open or resolved PR wait: it holds conversation input for its own wake (#476). */
export function hasPrWait(run: Pick<RunRecord, 'waits'>): boolean {
  return (run.waits ?? []).some((wait) => wait.kind === 'pr' && (wait.phase === 'open' || wait.phase === 'resolved'));
}

export function timerWaitEntry(parsed: Extract<CezarWaitRequest, { kind: 'timer' }>, via: WaitVia, turnId: string, now: number) {
  const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + parsed.seconds * 1000).toISOString(), phase: 'open', turnId, seconds: parsed.seconds,
        ...(parsed.note === undefined ? {} : { note: parsed.note }) };
  return wait;
}

export function prWaitEntry(identity: Awaited<ReturnType<CiWatcherSupervisor['resolve']>>, parsed: Extract<CezarWaitRequest, { kind: 'pr' }>, via: WaitVia, generation: string, turnId: string, now: number) {
  const wait: PrWaitEntry = { ...identity, id: randomUUID(), kind: 'pr', source: 'agent', via, generation, turnId,
        timeoutSeconds: parsed.timeout_seconds, until: parsed.until, wakeOnConflict: parsed.wake_on_conflict, registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + parsed.timeout_seconds * 1000).toISOString(), phase: 'open' };
  return wait;
}

export function processWaitEntry(request: Extract<CezarWaitRequest, { kind: 'process' }>, via: WaitVia, turnId: string, now: number, startToken: string | undefined, exitFile: string | undefined) {
  const wait: ProcessWaitEntry = { id: randomUUID(), kind: 'process', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + request.timeout_seconds * 1000).toISOString(), phase: 'open', turnId, timeoutSeconds: request.timeout_seconds,
      pid: request.pid, ...(startToken === undefined ? {} : { startToken }), ...(exitFile === undefined ? {} : { exitFile }),
      ...(request.note === undefined ? {} : { note: request.note }) };
  return wait;
}

export function settledWaitEntry(latest: Wait, result: CiWaitResult | ProcessWaitResult | PeerWaitResult | undefined, observed: WorkerWaitEntry | undefined, resolvedAt: string): Wait {
  const settled: Wait = latest.kind === 'pr'
      ? { ...latest, phase: 'resolved', resolvedAt, result: (result as CiWaitResult | undefined) ?? { outcome: 'deadline', headSha: latest.headSha, observedAt: resolvedAt, checks: [], totalChecks: 0, truncated: false } }
      : latest.kind === 'process'
        ? { ...latest, phase: 'resolved', resolvedAt, result: (result as ProcessWaitResult | undefined) ?? { outcome: 'deadline', observedAt: resolvedAt } }
      : latest.kind === 'worker'
        ? { ...observed ?? latest, phase: 'resolved', resolvedAt, result: observed?.result ?? { reason: 'timeout' } }
      : latest.kind === 'peer'
        ? { ...latest, phase: 'resolved', resolvedAt, result: (result as PeerWaitResult | undefined) ?? { reason: 'timeout' } }
        : { ...latest, phase: 'resolved', resolvedAt };
  return settled;
}
