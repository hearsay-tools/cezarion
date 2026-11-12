/**
 * Upgrade-on-read of the wait fields an older store wrote (store schemas 3, 6 and 7,
 * spec 2026-10-17-unified-waits). `parseRunRecords` runs it before validation, and the
 * public names stay exported from `store.ts`.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ciWaitSchema } from '@open-mercato/cezar-contract/ci-wait';
import { workerWaitSchema } from '@open-mercato/cezar-contract/delegation';
import { LAST_WAITS_LIMIT, TIMER_MAX_SECONDS, TIMER_MIN_SECONDS } from '@open-mercato/cezar-contract/waits';
import type { CiWait, PrWaitEntry, RunRecord, Wait, WorkerWait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { applyExit } from './run-exits.ts';

/** The keys an older record used for parks. Schema 4 reads the CI and monitoring ones into
 *  `waits`; phase 4b (hearsay-tools/cezarion#1236) reads the pending-question summary into a human
 *  wait. None is written again (spec 2026-10-17-unified-waits, § Compatibility). */
const LEGACY_WAIT_KEYS = ['ciWait', 'lastCiWait', 'lastCiWaitError', 'monitoringWakeAt', 'monitoringWakeCapReached', 'activity', 'hasPendingHumanAsk'] as const;
export const UNREADABLE_WAIT = 'Wait unavailable — a saved wait is unreadable; register a new wait.';

type AgentWaitInput = { id?: unknown; deliveredAt?: unknown; inboxClaim?: { acknowledgedAt?: unknown } };
type AgentWaitFound = { key: 'wait' | 'lastWait'; wait: WorkerWait; completion: boolean };
type WaitLists = { opened: Wait[]; settled: Wait[] };

/** A stored `waits`/`lastWaits` entry of kind `ci`, the kind `pr` replaced (hearsay-tools/cezarion#1425). */
const isCiKindEntry = (entry: unknown) => !!entry && typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'ci';
function hasCiKindEntries(row: Record<string, unknown>): boolean {
  return (['waits', 'lastWaits'] as const).some((key) => Array.isArray(row[key]) && (row[key] as unknown[]).some(isCiKindEntry));
}

export function hasLegacyWaitFields(row: unknown): boolean {
  return !!row && typeof row === 'object' && (LEGACY_WAIT_KEYS.some((key) => key in row) || hasCiKindEntries(row as Record<string, unknown>) || agentWorkerWaits(row as Record<string, unknown>).length > 0 || rootCompletion(row as Record<string, unknown>) !== undefined);
}

/** A root's stored `delegation.completion` (the old completion gate's marker), which schema 7 reads
 *  into the list and drops (hearsay-tools/cezarion#1301). */
function rootCompletion(row: Record<string, unknown>): { waitId?: unknown } | undefined {
  const delegation = row.delegation;
  if (!delegation || typeof delegation !== 'object' || (delegation as { role?: unknown }).role !== 'root') return undefined;
  const { completion } = delegation as { completion?: unknown };
  return completion && typeof completion === 'object' ? completion : undefined;
}

/** The worker waits a record still holds in `delegation` (store schemas 6 and 7,
 *  hearsay-tools/cezarion#1235, #1301), in the order they settled: `lastWait`, then `wait`. The
 *  completion gate's wait, the one `delegation.completion.waitId` names, is flagged `completion`: it
 *  was Squawk's own, not the agent's. A value that does not parse is left where it is, for the
 *  delegation schema to quarantine as it always has. */
function agentWorkerWaits(row: Record<string, unknown>): AgentWaitFound[] {
  const delegation = row.delegation;
  if (!delegation || typeof delegation !== 'object') return [];
  const { role } = delegation as { role?: unknown };
  if (role !== 'root' && role !== 'worker') return [];
  const waitId = rootCompletion(row)?.waitId;
  const found: AgentWaitFound[] = [];
  for (const key of ['lastWait', 'wait'] as const) {
    const parsed = workerWaitSchema.safeParse((delegation as Record<string, unknown>)[key]);
    if (parsed.success) found.push({ key, wait: parsed.data, completion: waitId === parsed.data.id });
  }
  return found;
}

/** A legacy `CiWait` as a wait entry. Its wake input's id was the wait's own (`wakeId`, which
 *  `run.ts` set to the wait id), so the entry keeps that id and delivery still finds the input. */
export function ciWaitEntry(wait: CiWait): PrWaitEntry {
  const { wakeId: _wakeId, phase, result, deliveredAt, ...identity } = wait;
  return {
    ...identity, kind: 'pr', source: 'agent', via: 'cezar_wait_for_ci',
    phase: phase === 'registered' || phase === 'parked' ? 'open' : phase === 'wake-pending' ? 'resolved' : phase === 'delivered' ? 'delivered' : 'cancelled',
    ...(result ? { result, resolvedAt: result.observedAt } : {}),
    ...(deliveredAt ? { deliveredAt } : {}),
  };
}

/** A pending legacy wait with no recorded reason settled on its stored observations:
 *  satisfied by them is an outcome, anything else its deadline. */
function inferredLegacyWaitReason(wait: WorkerWait): 'outcome' | 'timeout' | undefined {
  if (wait.phase !== 'wake-pending' || wait.reason !== undefined) return undefined;
  const satisfied = (ids: readonly string[], reported: readonly string[]) => wait.mode === 'all' ? ids.every((id) => reported.includes(id)) : reported.length > 0;
  const reported = wait.requestIds
    ? satisfied(wait.requestIds, (wait.requestOutcomes ?? []).map((outcome) => outcome.requestId))
    : satisfied(wait.workerIds, (wait.outcomes ?? []).map((outcome) => outcome.workerId));
  return reported ? 'outcome' : 'timeout';
}

/** The recorded reason, else the one the observations imply. A `message` stand-in never reaches here. */
function legacyWaitReason(wait: WorkerWait): 'outcome' | 'timeout' | undefined {
  return wait.reason === 'outcome' || wait.reason === 'timeout' ? wait.reason : inferredLegacyWaitReason(wait);
}

/** The ids a legacy worker wait watched, worker ids or request ids, as the entry still stores them. */
function legacyWaitTargets(wait: WorkerWait): Pick<WorkerWaitEntry, 'requestIds' | 'requestOutcomes' | 'workerIds' | 'revisions' | 'outcomes'> {
  return wait.requestIds
    ? { requestIds: wait.requestIds, requestOutcomes: wait.requestOutcomes ?? [] }
    : { workerIds: wait.workerIds, revisions: wait.revisions ?? [], outcomes: wait.outcomes };
}

/**
 * A legacy agent `delegation.wait` as a worker wait entry (store schema 6, hearsay-tools/cezarion#1235),
 * judged from the wait alone: what became of its wake input is `upgradeLegacyWaits`' to apply.
 * `registered`/`parked` → open; `wake-pending` → resolved with its `outcome`/`timeout` reason, or
 * cancelled. Undefined for the `message` stand-in, which was never an agent's wait: a message no
 * longer resolves a wait, and its input still wakes the run on its own.
 *
 * Deterministic, never read from the clock: a row is upgraded on every read until open rewrites
 * it, and two reads must agree. A `WorkerWait` kept no registration time, so `timeoutSeconds` is
 * the 600 default, `registeredAt` is 600 s before the original deadline (kept as it was), and the
 * settled stamps come from the wait itself: `resolvedAt` is the latest observation it holds, else
 * its deadline, and `cancelledAt` is its deadline. `now` is only the fallback for a deadline that
 * does not read, which the wait schema never admits.
 */
export function workerWaitEntry(wait: WorkerWait, now: string): WorkerWaitEntry | undefined {
  if (wait.phase === 'wake-pending' && wait.reason === 'message') return undefined;
  const deadline = Date.parse(wait.deadline);
  const registeredAt = Number.isFinite(deadline) ? new Date(deadline - 600_000).toISOString() : now;
  const open = wait.phase !== 'wake-pending';
  const reason = legacyWaitReason(wait);
  const observed = [...(wait.outcomes ?? []), ...(wait.requestOutcomes ?? [])].map((outcome) => outcome.observedAt).sort().at(-1);
  const resolvedAt = reason === 'outcome' && observed ? observed : wait.deadline;
  return {
    id: wait.id, kind: 'worker', source: 'agent', via: 'cez-worker-wait', registeredAt, deadline: wait.deadline, timeoutSeconds: 600, turnId: 'upgraded',
    phase: open ? 'open' : reason ? 'resolved' : 'cancelled',
    ...(wait.mode ? { mode: wait.mode } : {}),
    ...legacyWaitTargets(wait),
    ...(!open && reason ? { result: { reason }, resolvedAt } : {}),
    ...(!open && !reason ? { cancelledAt: wait.deadline } : {}),
  };
}

/** Whether a record is a root still parked on its workers: an open or resolved worker wait in the
 *  list. Such a root has its pending human question re-read from the transcript before a manager
 *  parks it. Every stored `delegation.wait`, the completion gate's included, is read into the list
 *  on open (store schema 7, hearsay-tools/cezarion#1301), so the list is the only place to look. */
export function holdsWorkerWait(run: Pick<RunRecord, 'delegation' | 'waits'>): boolean {
  if (run.delegation?.role !== 'root') return false;
  return !!run.waits?.some((wait) => wait.kind === 'worker' && (wait.phase === 'open' || wait.phase === 'resolved'));
}

/** A stable id for the timer a legacy monitoring park becomes. The row keeps its legacy JSON
 *  until it is next written, so every read of it must name the same wait. */
function legacyTimerId(runId: unknown, wakeAt: string): string {
  return legacyWaitId(`legacy-monitoring-timer:${String(runId)}:${wakeAt}`);
}

/** The human wait a stored pending-question summary becomes: one per run, the same on every read. */
function legacyHumanWaitId(runId: unknown): string {
  return legacyWaitId(`legacy-pending-ask:${String(runId)}`);
}

/** A name-based (version 5 shaped) UUID, so a row read twice upgrades to the same entry. */
function legacyWaitId(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  const variant = (8 | (Number.parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A live run and its live step move together by `exit`, as every park and resume writes them:
 *  park from running to waiting, resume from waiting to running. The caller has read the row's status. */
function setLiveStatus(row: Record<string, unknown>, exit: 'park' | 'resume'): void {
  const [from, to] = exit === 'park' ? ['running', 'waiting'] : ['waiting', 'running'];
  Object.assign(row, applyExit({ status: row.status, delegation: row.delegation } as Pick<RunRecord, 'status' | 'delegation'>, exit));
  if (Array.isArray(row.steps)) for (const step of row.steps) {
    if (step && typeof step === 'object' && (step as { status?: unknown }).status === from) (step as { status: string }).status = to;
  }
}
const resumeParked = (row: Record<string, unknown>) => setLiveStatus(row, 'resume');

/** Kind `ci` waited for checks and woke on a conflict (hearsay-tools/cezarion#1425). */
function rewriteCiKindWaits(row: Record<string, unknown>): void {
  for (const key of ['waits', 'lastWaits'] as const) {
    if (Array.isArray(row[key])) row[key] = (row[key] as unknown[]).map((entry) => isCiKindEntry(entry)
      ? { ...(entry as object), kind: 'pr', until: 'checks', wakeOnConflict: true } : entry);
  }
}

/** One legacy CI field into the open or settled list. True when the value does not parse. */
function readLegacyCi(row: Record<string, unknown>, key: 'ciWait' | 'lastCiWait', lists: WaitLists): boolean {
  const value = row[key];
  if (value === undefined) return false;
  const parsed = ciWaitSchema.safeParse(value);
  if (!parsed.success) return true;
  const entry = ciWaitEntry(parsed.data);
  if (key === 'lastCiWait' && entry.phase !== 'delivered') entry.phase = 'cancelled';
  (entry.phase === 'open' || entry.phase === 'resolved' ? lists.opened : lists.settled).push(entry);
  return false;
}

/** A wake a provider took on a `waiting` run, between the delivery checkpoint and the resume. An
 *  inbox read starts no provider turn, and a pending question still holds the run. */
function legacyWakeInterrupted(row: Record<string, unknown>, key: 'wait' | 'lastWait', input: AgentWaitInput | undefined): boolean {
  return key === 'wait' && row.status === 'waiting' && typeof input?.deliveredAt === 'string' && !input.inboxClaim?.acknowledgedAt && row.hasPendingHumanAsk !== true;
}

/** Apply one legacy agent wait to the lists, and resume a parked run whose wake was interrupted. */
function settleLegacyAgentWait(row: Record<string, unknown>, found: AgentWaitFound, currentId: unknown, now: string, inputs: AgentWaitInput[], lists: WaitLists): void {
  const { key, wait, completion } = found;
  // A wait that settles has its copy in `lastWait` too: it is the same wait.
  if (key === 'lastWait' && currentId === wait.id) return;
  const input = inputs.find((candidate) => candidate.id === (wait.wakeId ?? wait.id));
  const entry = workerWaitEntry(wait, now);
  // Squawk's completion gate wait is its own: no agent registered it (hearsay-tools/cezarion#1301).
  // It keeps the deadline it always carried, with the 600 s default registration.
  if (entry && completion) Object.assign(entry, { source: 'cezar', via: 'completion', mode: 'all' });
  // The `message` stand-in becomes no entry, but its delivered message may be that crash too.
  if (!entry) { if (legacyWakeInterrupted(row, key, input)) resumeParked(row); return; }
  const deliveredAt = typeof input?.deliveredAt === 'string' ? input.deliveredAt : undefined;
  if (entry.phase !== 'open' && deliveredAt) {
    Object.assign(entry, { phase: 'delivered', deliveredAt });
    if (legacyWakeInterrupted(row, key, input)) resumeParked(row);
  }
  else if (key === 'lastWait' && entry.phase !== 'cancelled') Object.assign(entry, { phase: 'cancelled', cancelledAt: wait.deadline });
  else if (entry.phase === 'resolved' && input) entry.wakeInputId = input.id as string;
  (entry.phase === 'open' || entry.phase === 'resolved' ? lists.opened : lists.settled).push(entry);
}

/** Every stored agent `delegation.wait`/`lastWait` into the lists. */
function readLegacyAgentWaits(row: Record<string, unknown>, lists: WaitLists, agentWaits: AgentWaitFound[]): void {
  if (!agentWaits.length) return;
  // The wait's own stamps decide every time the entry carries (`workerWaitEntry`), not the clock.
  const now = typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString();
  const inputs = Array.isArray(row.agentInputs) ? row.agentInputs as AgentWaitInput[] : [];
  const currentId = agentWaits.find((found) => found.key === 'wait')?.wait.id;
  for (const found of agentWaits) settleLegacyAgentWait(row, found, currentId, now, inputs, lists);
}

/** Live monitoring parks become an open timer when the deadline reads, and a running run parks. */
function readLegacyMonitoring(row: Record<string, unknown>, opened: Wait[]): void {
  const live = row.status === 'running' || row.status === 'queued' || row.status === 'waiting';
  if (row.activity !== 'monitoring' || !live) return;
  const wakeAt = row.monitoringWakeAt;
  // Schema 3 read an unreadable deadline as none (`.catch(undefined)`): no wait.
  if (typeof wakeAt === 'string' && z.iso.datetime().safeParse(wakeAt).success) {
    const now = Date.now();
    const seconds = Math.min(TIMER_MAX_SECONDS, Math.max(TIMER_MIN_SECONDS, Math.round((Date.parse(wakeAt) - now) / 1000)));
    opened.push({
      id: legacyTimerId(row.id, wakeAt), kind: 'timer', source: 'agent', via: 'monitoring-line',
      registeredAt: new Date(now).toISOString(), deadline: wakeAt, phase: 'open', turnId: 'legacy', seconds,
    });
  }
  if (row.status === 'running') setLiveStatus(row, 'park');
}

const asksHuman = (entry: unknown) => !!entry && typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'human' && (entry as { phase?: unknown }).phase === 'open';

/** `hasPendingHumanAsk` on a waiting run with no open human wait: one open human wait. */
function readLegacyHumanAsk(row: Record<string, unknown>, opened: Wait[]): void {
  if (row.hasPendingHumanAsk !== true || row.status !== 'waiting') return;
  if ((Array.isArray(row.waits) && row.waits.some(asksHuman)) || opened.some(asksHuman)) return;
  opened.push({
    id: legacyHumanWaitId(row.id), kind: 'human', source: 'agent', via: 'ask-line',
    registeredAt: typeof row.createdAt === 'string' && z.iso.datetime().safeParse(row.createdAt).success ? row.createdAt : new Date(0).toISOString(),
    phase: 'open', turnId: 'legacy',
  });
}

/** Drop the fields schema 4 reads, and the agent waits schema 6 and 7 read. */
function dropLegacyWaitFields(row: Record<string, unknown>, agentWaits: AgentWaitFound[]): void {
  for (const key of LEGACY_WAIT_KEYS) delete row[key];
  if (!agentWaits.length && !rootCompletion(row)) return;
  const delegation = { ...(row.delegation as Record<string, unknown>) };
  for (const { key } of agentWaits) delete delegation[key];
  delete delegation.completion;
  row.delegation = delegation;
}

/**
 * Upgrade-on-read (store schema 4, spec 2026-10-17-unified-waits): read a schema-3 record's CI and
 * monitoring fields into its wait list, then delete them. Mutates `row`, before validation.
 *
 * - `ciWait`: `registered`/`parked` → an open `pr` checks wait, `wake-pending` → resolved (resolved when
 *   its result was observed), `delivered`/`withdrawn` → `lastWaits` as delivered/cancelled.
 * - `lastCiWait` → `lastWaits`: `delivered` stays delivered, anything else was withdrawn intent and
 *   reads as cancelled. `lastCiWaitError` → `lastWaitsError`.
 * - `activity: 'monitoring'` on a live run: with `monitoringWakeAt`, an open timer due then
 *   (`seconds` is what remains, clamped to a timer's bounds); without one, no wait. Either way a
 *   `running` run parks as `waiting`, its running step with it, as every waiting park writes it.
 *   On a finished run the fields are stale and only dropped.
 * - `hasPendingHumanAsk: true` on a `waiting` run with no open human wait (phase 4b,
 *   hearsay-tools/cezarion#1236): an open `human` wait, `ask-line`, with no `askSeq`. Recovery shows
 *   it (`surfaceHumanWait`), which attaches it to the question still pending in the transcript
 *   instead of raising a second card. Anywhere else the summary is dropped: the human wait it stood
 *   beside since phase 2 already says the same.
 *
 * - `delegation.wait`/`lastWait` registered by the agent (store schema 6, hearsay-tools/cezarion#1235)
 *   → `workerWaitEntry`, then settled by what became of the wake input (`wakeId`, else the wait's own
 *   id): a wait whose input was delivered reads as delivered, a `wake-pending` one whose input is
 *   still queued stays resolved and records it as `wakeInputId`, so it is delivered once, and a
 *   `lastWait` that was never delivered reads as cancelled. The `message` stand-in is dropped. No
 *   input is added or removed: a cancelled receipt's undelivered wake stays queued and is delivered
 *   as an ordinary input. The completion gate's wait (store schema 7, hearsay-tools/cezarion#1301) becomes a
 *   `source: 'cezar'`, `via: 'completion'` entry the same way, and `delegation.completion` is dropped. A current wait
 *   (the stand-in included) whose wake a provider took on a `waiting` run is the old engine's crash
 *   between the delivery checkpoint and the resume: the run reads `running`, so recovery resumes
 *   it. A wake an inbox read acknowledged, or one beside a pending question, resumes nothing.
 *
 * - A `waits`/`lastWaits` entry of kind `ci` (hearsay-tools/cezarion#1425) → kind `pr` with
 *   `until: 'checks'` and `wakeOnConflict: true`, what a `ci` wait did.
 *
 * An unreadable legacy CI wait gets the per-entry salvage `parseRunRecords` gives `waits`: it is
 * dropped, `lastWaitsError` says so, and the status is left alone. A `waiting` run with no open
 * wait reads as Needs you, which a human can resume.
 */
export function upgradeLegacyWaits(row: Record<string, unknown>): void {
  if (!hasLegacyWaitFields(row)) return;
  rewriteCiKindWaits(row);
  const lists: WaitLists = { opened: [], settled: [] };
  // The previous wait settled before the current one did, so it goes first. Both fields are
  // read, and both lists are written: one unreadable side must not skip the other.
  const previousUnreadable = readLegacyCi(row, 'lastCiWait', lists);
  const currentUnreadable = readLegacyCi(row, 'ciWait', lists);
  const agentWaits = agentWorkerWaits(row);
  readLegacyAgentWaits(row, lists, agentWaits);
  readLegacyMonitoring(row, lists.opened);
  readLegacyHumanAsk(row, lists.opened);
  let unreadable = previousUnreadable || currentUnreadable;
  if (lists.opened.length) {
    const current = Array.isArray(row.waits) ? row.waits as Array<{ id?: unknown }> : [];
    if (row.waits !== undefined && !Array.isArray(row.waits)) unreadable = true;
    row.waits = [...current, ...lists.opened.filter((wait) => !current.some((entry) => entry?.id === wait.id))];
  }
  if (lists.settled.length) {
    const current = Array.isArray(row.lastWaits) ? row.lastWaits : [];
    if (row.lastWaits !== undefined && !Array.isArray(row.lastWaits)) unreadable = true;
    row.lastWaits = [...lists.settled, ...current].slice(-LAST_WAITS_LIMIT);
  }
  if (typeof row.lastCiWaitError === 'string' && row.lastWaitsError === undefined) row.lastWaitsError = row.lastCiWaitError;
  if (unreadable) row.lastWaitsError = UNREADABLE_WAIT;
  dropLegacyWaitFields(row, agentWaits);
}
