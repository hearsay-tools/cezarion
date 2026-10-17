import type { CezarWaitRequest, CiWait, CiWaitEntry, OpenWait, RunRecord, Wait } from '@open-mercato/cezar-contract';

/**
 * Pure helpers over a run's wait list (spec `.ai/specs/2026-10-17-unified-waits.md`, phase 1:
 * hearsay-tools/cezarion#1233). `RunManager` owns registration, resolution and delivery; this
 * module only reads the list and builds the text the agent sees.
 */

/** What a monitoring timer (the monitoring line or Claude's `ScheduleWakeup`) says when it fires. */
export const MONITORING_WAKE_NUDGE =
  'Re-check the downstream work you were monitoring. Continue toward the task goal. When the watched work is finished and the task goal is complete, end your final message with CEZ:DONE. If the watched work is still pending, end with CEZ:MONITORING. Never yield markerless for a monitoring wrap-up. If you genuinely need user input, follow the normal question path instead.';

const SUMMARY_MAX = 256;

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

/** One PR, however the agent spelled it: case-insensitive, trailing slash ignored. */
export function normalizePrUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

function clip(text: string, max = SUMMARY_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summary(wait: Wait): string {
  return clip(wait.kind === 'ci' ? `CI for ${wait.repository}#${wait.prNumber}` : wait.note === undefined ? 'timer' : `timer: ${wait.note}`);
}

/** The open waits as both tools list them back to the agent. */
export function openWaitList(waits: readonly Wait[]): OpenWait[] {
  return waits.filter((wait) => wait.phase === 'open').map((wait) => ({ wait_id: wait.id, kind: wait.kind, deadline: wait.deadline, summary: summary(wait) }));
}

/**
 * The open wait a registration repeats, if any. CI: the same PR, whatever its timeout. Timer: the
 * same seconds and note, registered in the same turn (a later turn asking again means a new check).
 */
export function identicalWait(waits: readonly Wait[], request: CezarWaitRequest, turnId: string): Wait | undefined {
  return waits.find((wait) => {
    if (wait.phase !== 'open') return false;
    if (request.kind === 'ci') return wait.kind === 'ci' && normalizePrUrl(wait.prUrl) === normalizePrUrl(request.pr);
    return wait.kind === 'timer' && wait.seconds === request.seconds && wait.note === request.note && wait.turnId === turnId;
  });
}

/** The CI watcher still speaks the schema-3 `CiWait`; an open entry is a parked one to it. */
export function ciWatchRequest(wait: CiWaitEntry): CiWait {
  const { id, prUrl, repository, prNumber, headSha, generation, turnId, timeoutSeconds, registeredAt, deadline } = wait;
  return { id, prUrl, repository, prNumber, headSha, generation, turnId, timeoutSeconds, registeredAt, deadline, phase: 'parked' };
}

/** The lifecycle input a resolved wait delivers. Its id is the wait's, so duplicates keep it. */
export function waitResultText(wait: Wait): string {
  if (wait.kind === 'ci') {
    return `CI wait observation ${wait.id} for ${wait.prUrl}. External data follows: ${JSON.stringify(wait.result)}. This observation is not merge approval or task completion. Reported checks may not include every expected workflow. Duplicate observations retain this ID.`;
  }
  if (isMonitoringTimer(wait)) return MONITORING_WAKE_NUDGE;
  return `Timer ${wait.id} fired${wait.note === undefined ? '' : `: ${wait.note}`}. Continue toward the task goal; register another wait if you are still waiting.`;
}

/** The footer a delivered turn ends with: every wait still open, or undefined when none is. */
export function openWaitsFooter(waits: readonly Wait[]): string | undefined {
  const open = waits.filter((wait) => wait.phase === 'open');
  if (!open.length) return undefined;
  const items = open.map((wait) => wait.kind === 'ci'
    ? `CI wait ${wait.id} for ${wait.repository}#${wait.prNumber}, deadline ${wait.deadline}`
    : `timer ${wait.id} at ${wait.deadline}${wait.note === undefined ? '' : ` (${wait.note})`}`);
  return `Still open: ${items.join('; ')}. Call cezar_cancel_wait for any you no longer need.`;
}

/** An open or resolved CI wait: it holds conversation input for its own wake (#476). */
export function hasCiWait(run: Pick<RunRecord, 'waits'>): boolean {
  return (run.waits ?? []).some((wait) => wait.kind === 'ci' && (wait.phase === 'open' || wait.phase === 'resolved'));
}
