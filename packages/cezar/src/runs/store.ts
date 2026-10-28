import { workerDeletionProof } from './worker-deletion-proof.ts';
import { listPeerTaskSummaries, parseStoredSummary, type PeerTaskPageOptions } from './run-summary-page.ts';
export { parseStoredSummary } from './run-summary-page.ts';
import { defined } from '../core/defined.ts';
import { autosaveCleanupBlocker, clearAutosaveCleanup } from '../autosave-cleanup.ts';
import { EventEmitter } from 'node:events';
import { workerEvidenceRunIds, workerExecutionSchema, type WorkerExecution } from './worker-execution.ts';
import { isWindowsWorkerEvidence, readWindowsEvidence, removeWindowsEvidence, windowsEvidencePath, writeWindowsEvidence } from './windows-worker-evidence.ts';
import { executionEvidenceAbsent, readPrivateWorkerFile, replacePrivateWorkerFile } from './private-worker-file.ts';
import { agentTmpDirLocations, agentTmpDirMayExist, agentTmpDirOwnershipProven, removeAgentTmpDir } from './agent-tmpdir.ts';
import { removeArtifacts } from '../artifacts/lifecycle.ts';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, readdirSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ciWaitSchema } from '@open-mercato/cezar-contract/ci-wait';
import { workerWaitSchema } from '@open-mercato/cezar-contract/delegation';
import {
  agentInputSchema,
  inboxClaimSchema,
  delegationStateSchema,
  workerCreationReceiptSchema,
  workerCollectedResultSchema,
  workerResultFileSchema,
  workerDestroyRetrySchema,
} from '@open-mercato/cezar-contract/delegation';
import {
  automationIdOf,
  stepStateSchema as contractStepStateSchema,
  queuedMessageSchema,
  continuationMessageSchema,
  toRunSummary,
  runRecordSchema as contractRunRecordSchema,
  runPullRequestSchema,
  mergedPullRequestSchema,
} from '@open-mercato/cezar-contract/runs';
import { previewServerSchema } from '@open-mercato/cezar-contract/preview';
import {
  isUsageLimitHold,
  waitSchema,
  LAST_WAITS_LIMIT,
  TIMER_MAX_SECONDS,
  TIMER_MIN_SECONDS,
  WAIT_LIMIT,
} from '@open-mercato/cezar-contract/waits';
import { engineOwnsRun, isSweepable } from '@open-mercato/cezar-contract/run-predicates';
import type { ArchiveFinishedScope, ArchivedRunsResponse, ArchivePullRequestIdentity, CiWait, PrWaitEntry, ConversationState, AgentInput, InboxClaim, DelegationState, MergedPullRequest, RunPullRequest, RunSummary, Wait, WorkerCollectedResult, WorkerDestroyRetry, WorkerWait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { matchesRunSearch, sqlPrefilterTokens, type AutomationNames } from '@open-mercato/cezar-contract/run-search';
import { storedDelegationStateSchema } from './delegation-state.ts';
import { HistoryCompressor } from './history-compressor.ts';
import { LiveItemSnapshots } from './live-item-snapshots.ts';
import { emptyFacts, stampOf, TranscriptFactsIndex, type TranscriptFacts } from './transcript-facts.ts';
import { hasPlainHistory, historyPaths, readHistoryText, readHistoryTextAsync, removeHistory, restoreHistory } from './history-file.ts';
import { workerExecutionIdentitySchema, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { capacityError, workerCapacity } from '../delegation/capacity.ts';
import { inspectGeneration, isCurrentProcess, recordedProcessLive, processStartToken, type CwdSource, type RecordedProcess, type WorkerProcessRecord } from '../delegation/process-liveness.ts';
import { collectSecretValues, redactDeep, redactSecrets } from '../core/secret-redaction.ts';
// Pure, dependency-free reference helpers — the same sanity bound the marker parser applies.
import { archivePullRequests, pullRequestKey, mergePullRequests } from './pull-requests.ts';
import { extractTaskRefs, isRepoScopedRef, MAX_REF, promptNamesRepo, refUrlRepo } from './task-refs.ts';
// Type-only module (zod + nothing else), so this cannot cycle back into the store.
import { workflowDefSchema } from '../workflows/types.ts';
import { waitInputId } from '../workflows/waits.ts';
import { applyOutcomes, type OutcomeDependencies, type RunOutcome } from './outcome-commit.ts';
import { assertConversationIdFree, type ConversationIdentity } from './conversation-identity.ts';
export { ConversationIdInUseError } from './conversation-identity.ts';

import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import {
  ARCHIVED_ROOT, RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunConflictError, RunDatabase, RunDatabaseBusyError,
  type RunConflictEvidence, type RunDatabaseChanges, type RunDatabaseCommit, type RunFenceClaim, type RunRow, type RunRowInput, type RunWriteFence,
} from './run-database.ts';
import { restoreLostReferencedPullRequest } from './loaded-run-healing.ts';
import { encodeRunRow, isLiveRecord, isLiveStatus } from './run-row.ts';
import { collectRawExtras, encodeRawRecord, type RawExtras } from './raw-record.ts';
import { assertNoLegacyCockpit, assertNoLegacyWriter, backUpLegacyIndex, LEGACY_INDEX_FILE, LegacyWriterError, readLegacyIndex } from './legacy-index.ts';
import { RunStoreOpenError, toRunStoreOpenError } from './store-open-error.ts';
import { claimOwnerLive, closeClaimSession, openClaimSession, type ClaimOwner } from './run-claims.ts';

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/**
 * A runner id as it may appear in a PERSISTED record, normalized to the three
 * ids the rest of cezar speaks (#547).
 *
 * `claude-cli` is the legacy spelling of `claude` — still a member of
 * `AgentBackend` and still accepted by `createRunner`, and accepted in `runs.json`. The enum
 * here once failed to accept it: the loader `safeParse`s the
 * WHOLE array, so one record carrying it would have dropped every run in the
 * file.
 *
 * Parse-and-fold rather than widen: the legacy id is accepted on the way in and
 * collapsed to `claude`, so no consumer, wire type or contract schema ever sees
 * a fourth runner. The narrowing is one-way and permanent (the index is
 * re-serialized from the parsed records), which is what "old run records
 * normalise identically to `claude`" in `core/model-identity.ts` has always
 * claimed. Use ONLY for read-back of stored state — request bodies, settings and
 * workflow step defs stay the three selectable ids (`RunnerId`), because nothing
 * should be able to ASK for the legacy spelling.
 */
const storedRunnerSchema = z
  .enum([...RUNNER_IDS, 'claude-cli'])
  .transform((id) => (id === 'claude-cli' ? ('claude' as const) : id));

const stepStateSchema = contractStepStateSchema.extend({ backend: storedRunnerSchema.optional() });

/** Exported for `./run-index.ts`, the read-only reader of the same records. Nothing else should
 *  parse a stored run — see `reconcileLoadedRun` for why a second parser is a correctness risk. */
export const runRecordSchema = contractRunRecordSchema.extend({
  delegation: storedDelegationStateSchema,
  lastWaitsError: contractRunRecordSchema.shape.lastWaitsError.catch(undefined),
  automaticWakes: contractRunRecordSchema.shape.automaticWakes.catch(undefined),
  waitDeliveryFailures: contractRunRecordSchema.shape.waitDeliveryFailures.catch(undefined),
  runner: storedRunnerSchema.optional(),
  notify: z.boolean().optional().catch(undefined),
  webhook: contractRunRecordSchema.shape.webhook.catch(undefined),
  destroyRetry: contractRunRecordSchema.shape.destroyRetry.catch(undefined),
  stopping: contractRunRecordSchema.shape.stopping.catch(undefined),
  hasPendingPermission: contractRunRecordSchema.shape.hasPendingPermission.catch(undefined),
  autoResumeAt: z.string().datetime().optional().catch(undefined),
  autoResumeAttempts: z.number().int().min(0).optional().catch(undefined),
  pullRequests: z.preprocess((value) => Array.isArray(value)
    ? value.flatMap((entry) => {
        const parsed = runPullRequestSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : undefined, z.array(runPullRequestSchema).optional()),
  worktreeSetup: contractRunRecordSchema.shape.worktreeSetup.catch(undefined),
  archived: z.boolean().default(false),
  workflowDef: workflowDefSchema.optional().catch(undefined),
  steps: z.array(stepStateSchema),
  automation: contractRunRecordSchema.shape.automation.unwrap().extend({
    automationRevision: z.number().int().positive(),
    githubUrl: z.string().url(),
  }).optional(),
  automationTrigger: contractRunRecordSchema.shape.automationTrigger.unwrap().extend({
    automationRevision: z.number().int().positive(),
  }).optional(),
  /** The handoff file's autosave records (hearsay-tools/cezarion#1809); unreadable drops the field. */
  handoffRecords: contractRunRecordSchema.shape.handoffRecords.catch(undefined),
});

/** The keys an older record used for parks. Schema 4 reads the CI and monitoring ones into
 *  `waits`; phase 4b (hearsay-tools/cezarion#1236) reads the pending-question summary into a human
 *  wait. None is written again (spec 2026-10-17-unified-waits, § Compatibility). */
const LEGACY_WAIT_KEYS = ['ciWait', 'lastCiWait', 'lastCiWaitError', 'monitoringWakeAt', 'monitoringWakeCapReached', 'activity', 'hasPendingHumanAsk'] as const;
const UNREADABLE_WAIT = 'Wait unavailable — a saved wait is unreadable; register a new wait.';

/** A stored `waits`/`lastWaits` entry of kind `ci`, the kind `pr` replaced (hearsay-tools/cezarion#1425). */
const isCiKindEntry = (entry: unknown) => !!entry && typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'ci';
function hasCiKindEntries(row: Record<string, unknown>): boolean {
  return (['waits', 'lastWaits'] as const).some((key) => Array.isArray(row[key]) && (row[key] as unknown[]).some(isCiKindEntry));
}

function hasLegacyWaitFields(row: unknown): boolean {
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
 *  was Cezar's own, not the agent's. A value that does not parse is left where it is, for the
 *  delegation schema to quarantine as it always has. */
function agentWorkerWaits(row: Record<string, unknown>): Array<{ key: 'wait' | 'lastWait'; wait: WorkerWait; completion: boolean }> {
  const delegation = row.delegation;
  if (!delegation || typeof delegation !== 'object') return [];
  const { role } = delegation as { role?: unknown };
  if (role !== 'root' && role !== 'worker') return [];
  const waitId = rootCompletion(row)?.waitId;
  const found: Array<{ key: 'wait' | 'lastWait'; wait: WorkerWait; completion: boolean }> = [];
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
  // A pending wait from before reasons were recorded settled on its persisted observations, as
  // `reconcileWorkerWait` infers it: satisfied by them is an outcome, anything else its deadline.
  const satisfied = (ids: readonly string[], reported: readonly string[]) => wait.mode === 'all' ? ids.every((id) => reported.includes(id)) : reported.length > 0;
  const inferred = wait.phase === 'wake-pending' && wait.reason === undefined
    ? (wait.requestIds ? satisfied(wait.requestIds, (wait.requestOutcomes ?? []).map((outcome) => outcome.requestId))
      : satisfied(wait.workerIds, (wait.outcomes ?? []).map((outcome) => outcome.workerId))) ? 'outcome' as const : 'timeout' as const
    : undefined;
  const reason = wait.reason === 'outcome' || wait.reason === 'timeout' ? wait.reason : inferred;
  const observed = [...(wait.outcomes ?? []), ...(wait.requestOutcomes ?? [])].map((outcome) => outcome.observedAt).sort().at(-1);
  const resolvedAt = reason === 'outcome' && observed ? observed : wait.deadline;
  return {
    id: wait.id, kind: 'worker', source: 'agent', via: 'cez-worker-wait', registeredAt, deadline: wait.deadline, timeoutSeconds: 600, turnId: 'upgraded',
    phase: open ? 'open' : reason ? 'resolved' : 'cancelled',
    ...(wait.mode ? { mode: wait.mode } : {}),
    ...(wait.requestIds
      ? { requestIds: wait.requestIds, requestOutcomes: wait.requestOutcomes ?? [] }
      : { workerIds: wait.workerIds, revisions: wait.revisions ?? [], outcomes: wait.outcomes }),
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
/** A live run and its live step move from `from` to `to` together, as every park and resume writes them. */
function setLiveStatus(row: Record<string, unknown>, from: 'running' | 'waiting', to: 'running' | 'waiting'): void {
  row.status = to;
  if (Array.isArray(row.steps)) for (const step of row.steps) {
    if (step && typeof step === 'object' && (step as { status?: unknown }).status === from) (step as { status: string }).status = to;
  }
}
const resumeParked = (row: Record<string, unknown>) => setLiveStatus(row, 'waiting', 'running');

export function upgradeLegacyWaits(row: Record<string, unknown>): void {
  if (!hasLegacyWaitFields(row)) return;
  // Kind `ci` waited for checks and woke on a conflict (hearsay-tools/cezarion#1425).
  for (const key of ['waits', 'lastWaits'] as const) {
    if (Array.isArray(row[key])) row[key] = (row[key] as unknown[]).map((entry) => isCiKindEntry(entry)
      ? { ...(entry as object), kind: 'pr', until: 'checks', wakeOnConflict: true } : entry);
  }
  const opened: Wait[] = [];
  const settled: Wait[] = [];
  let unreadable = false;
  const legacyCi = (value: unknown, previous: boolean) => {
    if (value === undefined) return;
    const parsed = ciWaitSchema.safeParse(value);
    if (!parsed.success) { unreadable = true; return; }
    const entry = ciWaitEntry(parsed.data);
    if (previous && entry.phase !== 'delivered') entry.phase = 'cancelled';
    (entry.phase === 'open' || entry.phase === 'resolved' ? opened : settled).push(entry);
  };
  // The previous wait settled before the current one did, so it goes first.
  legacyCi(row.lastCiWait, true);
  legacyCi(row.ciWait, false);
  const agentWaits = agentWorkerWaits(row);
  if (agentWaits.length) {
    // The wait's own stamps decide every time the entry carries (`workerWaitEntry`), not the clock.
    const now = typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString();
    const inputs = Array.isArray(row.agentInputs) ? row.agentInputs as Array<{ id?: unknown; deliveredAt?: unknown; inboxClaim?: { acknowledgedAt?: unknown } }> : [];
    const current = agentWaits.find((found) => found.key === 'wait');
    // The old engine retired a delivered wake into `lastWait` with the resume: a current wait whose
    // wake a provider took on a `waiting` run is a crash between the two, and resumed. An inbox
    // read starts no provider turn, and a pending question still holds the run, as they did then.
    const interrupted = (key: 'wait' | 'lastWait', input: (typeof inputs)[number] | undefined) => key === 'wait' && row.status === 'waiting' &&
      typeof input?.deliveredAt === 'string' && !input.inboxClaim?.acknowledgedAt && row.hasPendingHumanAsk !== true;
    for (const { key, wait, completion } of agentWaits) {
      // A wait that settles has its copy in `lastWait` too: it is the same wait.
      if (key === 'lastWait' && current?.wait.id === wait.id) continue;
      const input = inputs.find((candidate) => candidate.id === (wait.wakeId ?? wait.id));
      const entry = workerWaitEntry(wait, now);
      // Cezar's completion gate wait is its own: no agent registered it (hearsay-tools/cezarion#1301).
      // It keeps the deadline it always carried, with the 600 s default registration.
      if (entry && completion) Object.assign(entry, { source: 'cezar', via: 'completion', mode: 'all' });
      // The `message` stand-in becomes no entry, but its delivered message may be that crash too.
      if (!entry) { if (interrupted(key, input)) resumeParked(row); continue; }
      const deliveredAt = typeof input?.deliveredAt === 'string' ? input.deliveredAt : undefined;
      if (entry.phase !== 'open' && deliveredAt) {
        Object.assign(entry, { phase: 'delivered', deliveredAt });
        if (interrupted(key, input)) resumeParked(row);
      }
      else if (key === 'lastWait' && entry.phase !== 'cancelled') Object.assign(entry, { phase: 'cancelled', cancelledAt: wait.deadline });
      else if (entry.phase === 'resolved' && input) entry.wakeInputId = input.id as string;
      (entry.phase === 'open' || entry.phase === 'resolved' ? opened : settled).push(entry);
    }
  }
  const live = row.status === 'running' || row.status === 'queued' || row.status === 'waiting';
  if (row.activity === 'monitoring' && live) {
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
    if (row.status === 'running') setLiveStatus(row, 'running', 'waiting');
  }
  const asksHuman = (entry: unknown) => !!entry && typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'human' && (entry as { phase?: unknown }).phase === 'open';
  if (row.hasPendingHumanAsk === true && row.status === 'waiting' &&
    !(Array.isArray(row.waits) && row.waits.some(asksHuman)) && !opened.some(asksHuman)) {
    opened.push({
      id: legacyHumanWaitId(row.id), kind: 'human', source: 'agent', via: 'ask-line',
      registeredAt: typeof row.createdAt === 'string' && z.iso.datetime().safeParse(row.createdAt).success ? row.createdAt : new Date(0).toISOString(),
      phase: 'open', turnId: 'legacy',
    });
  }
  if (opened.length) {
    const current = Array.isArray(row.waits) ? row.waits as Array<{ id?: unknown }> : [];
    if (row.waits !== undefined && !Array.isArray(row.waits)) unreadable = true;
    row.waits = [...current, ...opened.filter((wait) => !current.some((entry) => entry?.id === wait.id))];
  }
  if (settled.length) {
    const current = Array.isArray(row.lastWaits) ? row.lastWaits : [];
    if (row.lastWaits !== undefined && !Array.isArray(row.lastWaits)) unreadable = true;
    row.lastWaits = [...settled, ...current].slice(-LAST_WAITS_LIMIT);
  }
  if (typeof row.lastCiWaitError === 'string' && row.lastWaitsError === undefined) row.lastWaitsError = row.lastCiWaitError;
  if (unreadable) row.lastWaitsError = UNREADABLE_WAIT;
  for (const key of LEGACY_WAIT_KEYS) delete row[key];
  if (agentWaits.length || rootCompletion(row)) {
    const delegation = { ...(row.delegation as Record<string, unknown>) };
    for (const { key } of agentWaits) delete delegation[key];
    delete delegation.completion;
    row.delegation = delegation;
  }
}

/** Read legacy wait fields into the wait list and salvage per entry, identically for live stores
 *  and the read-only workspace index. */
export function parseRunRecords(raw: unknown) {
  if (Array.isArray(raw)) for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    upgradeLegacyWaits(row);
    // One unreadable wait must not evict the run, nor its readable siblings.
    for (const key of ['waits', 'lastWaits'] as const) {
      if (row[key] === undefined) continue;
      const entries: unknown[] = Array.isArray(row[key]) ? row[key] : [];
      const readable = entries.filter((entry) => waitSchema.safeParse(entry).success);
      if (!Array.isArray(row[key]) || readable.length !== entries.length) row.lastWaitsError = UNREADABLE_WAIT;
      if (readable.length) row[key] = readable;
      else delete row[key];
    }
    // One unreadable registration must not evict the run, nor its readable siblings (#781).
    if (row.previewServers !== undefined) {
      if (Array.isArray(row.previewServers)) row.previewServers = row.previewServers.filter((entry: unknown) => previewServerSchema.safeParse(entry).success);
      else delete row.previewServers;
    }
  }
  return z.array(runRecordSchema).safeParse(raw);
}

/** One stored record and what its JSON holds beyond the runtime schema (raw-record.ts), which
 *  the next write of its row puts back. */
export interface DecodedRun {
  run: RunRecord;
  extras: RawExtras | undefined;
  /** The stored JSON still had schema-3 wait fields (`upgradeLegacyWaits`): open rewrites it. */
  upgraded?: true;
}

/** A row as this store last read or wrote it (see `RunStore.base`). */
interface StoredRow {
  revision: number;
  /** The row's insertion order, where it lists among runs created in the same millisecond. */
  seq: number;
  data: string;
  extras?: RawExtras | undefined;
}

/** Just the `StoredRow` part of a `coldBase` entry. */
function storedRow({ revision, seq, data, extras }: StoredRow): StoredRow {
  return { revision, seq, data, extras };
}

/** One stored record (a row's `data`) through `parseRunRecords`' salvage and schema, with what the
 *  schema dropped. Read after the salvage ran: what it removes (an unreadable CI wait, a preview
 *  server entry) the runtime has decided to drop, and keeps dropping on the next write, as it always
 *  has; only what the schema does not know is put back. */
function decodeStoredRecord(raw: unknown): DecodedRun | undefined {
  const upgraded = hasLegacyWaitFields(raw);
  const parsed = parseRunRecords([raw]);
  if (!parsed.success) return undefined;
  const run = parsed.data[0]!;
  return { run, extras: collectRawExtras(raw, run), ...(upgraded ? { upgraded: true as const } : {}) };
}

/** One database row's `data` back into a record and its extras. Undefined when it does not parse:
 *  one unreadable row costs that row only. */
export function decodeRunRow(data: string): DecodedRun | undefined {
  try {
    return decodeStoredRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
}

/** One database row's `data` back into a record, for a reader that never writes it back. */
export function decodeRunRecord(data: string): RunRecord | undefined {
  try {
    const parsed = parseRunRecords([JSON.parse(data)]);
    return parsed.success ? parsed.data[0] : undefined;
  } catch {
    return undefined;
  }
}

export { LEGACY_INDEX_BACKUP_FILE, LEGACY_INDEX_FILE } from './legacy-index.ts';

export type StepState = z.infer<typeof stepStateSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;

/** One persisted event line; `type` mirrors AgentEvent plus engine lifecycle. */
export type RunEvent = import('@open-mercato/cezar-contract').RunEvent;

/** The pauses between open attempts while the database is busy, when `open` may wait (a boot):
 *  about 3.5 s in all, with each attempt's own busy timeout. Long enough for another process to
 *  finish importing a large `runs.json`. */
const OPEN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

/** Block this thread for `ms`. Only `open` does, at boot, when there is nothing else to run. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs (and conversation roots, one family query each) the open-time facts warm-up enumerates
 *  per event-loop turn (hearsay-tools/cezarion#949), so each slice stays a few milliseconds. */
const WARM_IDS_PER_SLICE = 100;

const MAX_RUNS_KEPT = 300;

/** How many archived root runs the run lists carry per project (#864): `GET /run-summaries?archived=recent`
 *  and `GET /workspace/runs-index`. Unarchived runs are never cut; older archived runs page in
 *  through `GET /run-summaries/archived` and the workspace search. */
export const ARCHIVED_WINDOW = 200;

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const ISSUE_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;
// The transcript auto-link is convenience only (the cockpit's own `gh pr create` path sets the
// URL authoritatively). Adopt a PR URL ONLY when the agent actually CREATED one — a task that
// reviews or merely references an existing PR must not get mislabeled with its number (#fake-pr).
const CREATED_PR_RE =
  /\b(?:gh\s+pr\s+create|pull\s*request\s+created|created\s+(?:a\s+)?(?:draft\s+)?(?:pr|pull\s*request)|opened\s+(?:a\s+)?(?:draft\s+)?pull\s*request)\b/i;

/** Referenced-tier working-set cap (spec 2026-07-16-pr-autodiscovery): past
 *  this many distinct PRs the conversation is a survey, not a subject. */
const MAX_PR_CANDIDATES = 8;

/** The repository a project IS, as `resolveRepoHandle` reports it. `null`/absent means "unknown",
 *  which is a real and common state (no `gh`, no remote, a non-git root) — never an error. */
export type RepoHandle = { owner: string; name: string };

/**
 * Every scannable string of one persisted event: the v1 top-level fields plus
 * the protocol-v2 `item.*` content (nested — the reason v2 streams were
 * invisible to the janitor, #407). Reasoning items are skipped: thinking text
 * speculates about PRs the task never touches.
 */
/**
 * Archiving IS resigning from a task, so an archived run can never carry a pending usage-limit
 * resume (spec 2026-08-03-auto-resume-after-usage-limit). The rule lives HERE rather than in the
 * archive route because the bulk "Archive finished" sweep never goes through that route, and a
 * user who archives fifty finished tasks has resigned from all fifty.
 *
 * The engine needs no telling: its timer re-reads the record before it fires and no sweep re-arms
 * an archived run, so a cleared field is the whole cancellation.
 */
function clearPendingAutoResume(run: RunRecord): void {
  // A withdrawn appointment settles the run failed with its kept error (hearsay-tools/cezarion#1236),
  // the state a usage-limited run was in before it waited.
  if (isUsageLimitHold(run)) {
    run.status = 'failed';
    run.finishedAt ??= new Date().toISOString();
  }
  run.autoResumeAt = undefined;
  run.autoResumeAttempts = undefined;
}

/**
 * The write rule (hearsay-tools/cezarion#1496): a resume time is the appointment of a `waiting`
 * run, so every commit takes it off a record that is not `waiting`. A copy, set to `undefined`
 * and never deleted: a caller may stage the held record itself. `autoResumeAttempts` stays, since
 * `MAX_AUTO_RESUMES` counts attempts across resumes.
 */
function withoutStaleResumes(input: ReadonlyMap<string, RunRecord | null>): ReadonlyMap<string, RunRecord | null> {
  let staged: Map<string, RunRecord | null> | undefined;
  for (const [id, run] of input) {
    if (run?.autoResumeAt === undefined || isUsageLimitHold(run)) continue;
    (staged ??= new Map(input)).set(id, { ...run, autoResumeAt: undefined });
  }
  return staged ?? input;
}

/**
 * Archiving is resigning from a task, so it retires the pin too (#935) — a pin on a task the
 * user has filed away is stale by definition, and the archived view collapses into one bucket
 * anyway, so a surviving pin would be invisible state waiting to surprise whoever unarchives.
 *
 * Here rather than in the pin route for the same reason `clearPendingAutoResume` is here: the
 * bulk "Archive finished" sweep never goes through a route, and it has to obey the rule too.
 *
 * Deleted, not set to `false`: absent is what every reader treats as unpinned, and it is the
 * shape a cezar that has never heard of pins already writes.
 */
function clearPin(run: RunRecord): void {
  delete run.pinned;
  delete run.pinnedAt;
}

function eventTextFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const key of ['text', 'result', 'message'] as const) {
    const value = event[key];
    if (typeof value === 'string') fragments.push(value);
  }
  const item = event.item;
  if (item && typeof item === 'object' && (item as Record<string, unknown>).kind !== 'reasoning') {
    const it = item as Record<string, unknown>;
    for (const key of ['text', 'title', 'output'] as const) {
      const value = it[key];
      if (typeof value === 'string') fragments.push(value);
    }
    if (typeof it.input === 'string') {
      fragments.push(it.input);
    } else if (it.input !== undefined) {
      try {
        fragments.push(JSON.stringify(it.input));
      } catch {
        // circular input — skip it
      }
    }
  }
  return fragments;
}

/**
 * Creation claims come from agent prose or cezar-rendered tool titles, never arbitrary tool
 * output/input. The claimed URL may still come from the event’s command result.
 */
function eventCreationClaimFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  const nested = event.item;
  if (event.parentItemId !== undefined || (nested && typeof nested === 'object' &&
    (nested as Record<string, unknown>).parentItemId !== undefined)) return fragments;
  // A `tool-result` event's `result` IS raw command output; on every other event the top-level
  // text is the agent's own.
  if (event.type !== 'tool-result') {
    for (const key of ['text', 'result', 'message'] as const) {
      const value = event[key];
      if (typeof value === 'string') fragments.push(value);
    }
  }
  const item = event.item;
  if (item && typeof item === 'object') {
    const it = item as Record<string, unknown>;
    if (it.kind === 'message' && it.role === 'assistant' && typeof it.text === 'string') {
      fragments.push(it.text);
    }
    if (it.kind === 'tool' && typeof it.title === 'string') fragments.push(it.title);
  }
  return fragments;
}

/** Agent-authored event text, matching the trust boundary used by task markers.
 * Tool titles, inputs, and outputs remain visible to the referenced-URL tier,
 * but must never promote an issue into the shared `issueNumber` field (#538). */
function eventAgentTextFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const key of ['text', 'result'] as const) {
    const value = event[key];
    if (typeof value === 'string') fragments.push(value);
  }
  const item = event.item;
  if (item && typeof item === 'object') {
    const it = item as Record<string, unknown>;
    if (it.kind === 'message' && it.role === 'assistant' && typeof it.text === 'string') {
      fragments.push(it.text);
    }
  }
  return fragments;
}

/**
 * Resolve declarations and prompt-supported candidates without guessing through ambiguity. Apply
 * repository scope to the winner only; filtering candidates first could promote an otherwise
 * ambiguous reference.
 */
function resolveReferencedRef(
  candidates: string[],
  task: string,
  declared?: number,
  handle?: RepoHandle | null,
): string | undefined {
  const resolved = resolveCandidate(candidates, task, declared);
  if (resolved === undefined) return undefined;
  return isRepoScopedRef(resolved, task, handle) ? resolved : undefined;
}

/** Resolve prompt evidence before the repository veto — see `resolveReferencedRef`. */
function resolveCandidate(candidates: string[], task: string, declared?: number): string | undefined {
  if (declared !== undefined) return candidates.find((url) => url.endsWith(`/${declared}`));
  if (candidates.length === 1) return candidates[0];
  // Repository-qualified prompt URLs distinguish equal numbers in different repositories.
  // Extract whole references with the collectors' grammar so /42 cannot match /420.
  const promptUrls = new Set([
    ...task.matchAll(new RegExp(PR_URL_RE.source, 'g')),
    ...task.matchAll(new RegExp(ISSUE_URL_RE.source, 'g')),
  ].map((match) => match[0]));
  const exact = candidates.filter((url) => promptUrls.has(url));
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const named = candidates.filter((url) => {
    const num = url.split('/').pop() ?? '';
    // `\d` boundaries only: they reject `170` inside `4170` yet still match a
    // number written as `#4170`, ` 4170`, or inside a pasted `…/pull/4170`.
    return num !== '' && new RegExp(`(?<!\\d)#?${num}(?!\\d)`).test(task);
  });
  return named.length === 1 ? named[0] : undefined;
}

/** The number a forge URL's last segment names (`…/pull/402` → 402), or undefined. */
function refUrlNumber(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const n = Number(url.split('/').pop());
  return Number.isInteger(n) && n > 0 && n < MAX_REF ? n : undefined;
}

/**
 * Ignore a created-PR declaration when resolving the referenced subject, so a task can retain
 * both its original subject and its new PR.
 */
function referencedPrDeclaration(run: RunRecord): number | undefined {
  const declared = run.markerRefs?.pr;
  if (declared === undefined) return undefined;
  return declared === refUrlNumber(run.pullRequestUrl) ? undefined : declared;
}

/** Prompt attribution survives declarations of follow-up issues. Bare hashes become issues
 * only after an issue signal; explicit PR prompts never acquire an invented issue identity. */
function originatingIssue(run: RunRecord): number | undefined {
  // Only an issue-led subject is stable attribution. Mentions inside comparisons or
  // background instructions remain evidence, but an agent declaration may supersede them.
  const prompt = run.task.trimStart()
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i\s+(?:want|would\s+like)\s+you\s+to\s+)/i, '')
    .replace(/^(?:please\s+)?(?:fix|resolve|address|implement|investigate|review|work(?:\s+on)?)\s+/i, '');
  const subject = /^(?:(?:the\s+)?(?:(?:github|fork|upstream)\s+)?issue\s*|(?:fork|upstream)\s+)?(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|(?:[\w.-]+\/[\w.-]+)?#?\d+)\b/i.exec(prompt);
  if (!subject) return undefined;
  const refs = extractTaskRefs(subject[0]);
  return refs.issueNumber ?? ((run.issueNumber !== undefined || run.markerRefs?.issue !== undefined)
    ? refs.ambiguousNumber : undefined);
}

function referencedIssueDeclaration(run: RunRecord): number | undefined {
  return run.markerRefs?.issue === undefined ? undefined : originatingIssue(run) ?? run.markerRefs.issue;
}

function resolveIssueReference(run: RunRecord, handle?: RepoHandle | null): string | undefined {
  const declared = referencedIssueDeclaration(run);
  const candidates = run.referencedIssueCandidates ?? [];
  // Prompt URLs remain evidence even in legacy records without a candidate working set.
  const promptUrls = [...new Set([...run.task.matchAll(new RegExp(ISSUE_URL_RE.source, 'g'))]
    .map(match => match[0]).filter(url => refUrlNumber(url) === declared))];
  if (promptUrls.length > 1) return undefined;
  if (promptUrls.length === 1) return resolveReferencedRef(promptUrls, run.task, declared, handle);
  // A number cannot choose between two repositories' issues with that same number.
  if (declared !== undefined && new Set(candidates.filter(url => refUrlNumber(url) === declared)).size > 1) {
    return undefined;
  }
  return resolveReferencedRef(candidates, run.task, declared, handle);
}

function restoreOriginatingIssue(run: RunRecord): void {
  const origin = originatingIssue(run);
  if (origin === undefined || run.markerRefs?.issue === undefined) return;
  run.issueNumber = origin;
  delete run.referencedIssueNumberSeeded;
  if (run.referencedIssueCandidates !== undefined || refUrlNumber(run.referencedIssueUrl) !== origin) {
    run.referencedIssueUrl = resolveIssueReference(run);
  }
}

/**
 * The PR URL a creation phrase *introduces*, or undefined. The created URL is
 * the first one at or after the `CREATED_PR_RE` phrase — a PR the same event
 * merely referenced *earlier* (e.g. the issue's own linked `…/pull/1`) must not
 * be mistaken for the one just created (#495). Falls back to the last URL
 * *before* the phrase for `gh` orderings that print the URL first. Selection
 * only — the caller decides whether creation phrasing is present.
 */
function createdPrUrl(haystack: string): string | undefined {
  const phrase = CREATED_PR_RE.exec(haystack);
  if (!phrase) return undefined;
  const after = PR_URL_RE.exec(haystack.slice(phrase.index));
  if (after) return after[0];
  let before: string | undefined;
  for (const m of haystack.slice(0, phrase.index).matchAll(new RegExp(PR_URL_RE.source, 'g'))) {
    before = m[0];
  }
  return before;
}

/** Associate one URL per claim; command outputs remain separate from authored claims. */
function createdPrUrls(claim: string, haystack: string, toolOutput?: string): string[] {
  const phrases = [...claim.matchAll(new RegExp(CREATED_PR_RE.source, 'gi'))];
  if (!phrases.length) return [];
  const urls = phrases.flatMap((phrase, index) => {
    const preceding = claim.slice(index ? phrases[index - 1]!.index! + phrases[index - 1]![0].length : 0, phrase.index);
    const before = [...preceding.matchAll(new RegExp(PR_URL_RE.source, 'g'))].at(-1);
    // URL-first reports put only punctuation/whitespace between the URL and its claim.
    // An earlier URL followed by unrelated prose is still context, not a created resource.
    if (before && /^[\s:—–-]*(?:draft\s+)?$/i.test(preceding.slice(before.index! + before[0].length))) return [before[0]];
    const after = PR_URL_RE.exec(claim.slice(phrase.index, phrases[index + 1]?.index))?.[0];
    return after ? [after] : [];
  });
  if (!urls.length && toolOutput !== undefined) {
    // gh prints one URL per successful command. Never promote more output links than commands.
    const outputs = [...toolOutput.matchAll(new RegExp(PR_URL_RE.source, 'g'))];
    urls.push(...outputs.slice(0, phrases.length).map(match => match[0]));
  }
  if (!urls.length && phrases.length === 1) {
    const url = createdPrUrl(`${claim} ${haystack}`);
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

/**
 * Reconcile one record just read off disk with the fact that whichever process wrote it is gone.
 *
 * Mutates and returns `run`. Extracted from `RunStore.open` so the read-only index reader
 * (`./run-index.ts`) answers the SAME question about a `running` row on disk. Two parsers that
 * disagree here is a visible bug, not an internal one: the cockpit would show a task as running
 * in the ⌘K index and failed the moment you opened it.
 *
 * `keepLive` (#367): leave `queued`/`running`/`waiting` untouched so the caller can recover them
 * (RunManager.recover re-queues queued runs, resumes interrupted ones). Without it — one-shot CLI
 * paths that never recover, and the index reader, which has no manager at all — live-looking runs
 * are marked failed so no ghost stays behind.
 */
export function reconcileLoadedRun(run: RunRecord, opts?: { keepLive?: boolean }): RunRecord {
  settleLoadedStop(run);
  restoreLoadedUsageLimitHold(run);
  failLoadedInterruptedRun(run, opts);
  clearLoadedStaleResume(run);
  restoreLostReferencedPullRequest(run, referencedPrDeclaration, resolveReferencedRef);
  restoreOriginatingIssue(run);
  // Repository scoping follows reconciliation: stores arm a handle asynchronously, while
  // the read-only index applies its cached handle to these fresh records (#97). This ordering
  // also scopes any referenced PR restored above without filtering candidate evidence first.
  return run;
}

function settleLoadedStop(run: RunRecord): void {
  // An accepted Stop is durable intent, never an interrupted run to auto-resume.
  if (run.stopping) {
    run.status = 'cancelled';
    run.finishedAt ??= new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'cancelled';
    }
  }
  run.stopping = undefined;
}

function restoreLoadedUsageLimitHold(run: RunRecord): void {
  // A usage-limited run is waiting for its resume (hearsay-tools/cezarion#1236, phase 4a). Rows a
  // schema-7 cezar wrote kept it failed with the appointment; they read as the waiting run they are.
  if (run.status === 'failed' && run.autoResumeAt !== undefined) {
    run.status = 'waiting';
    run.finishedAt = undefined;
  }
}

function failLoadedInterruptedRun(run: RunRecord, opts?: { keepLive?: boolean }): void {
  // A run that was live when the previous process exited can never finish —
  // surface that instead of a forever-"running" ghost. `review` survives
  // restarts on purpose: the gate is pure data (worktree + branch + record)
  // with no live process, so the diff panel, Send back (resume) and Draft PR
  // all still work.
  // A usage-limit hold runs no process, so no exit interrupted it: its appointment stands.
  if (!opts?.keepLive && engineOwnsRun(run)) {
    run.status = 'failed';
    run.error = 'interrupted — cezar process exited during the run';
    run.finishedAt = run.finishedAt ?? new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'failed';
    }
  }
}

function clearLoadedStaleResume(run: RunRecord): void {
  // Open waits are left alone at every status: RunManager cancels them when a run ends (spec
  // 2026-10-17-unified-waits), and recovery reads the ones a crash left behind.
  // A pending usage-limit resume survives the restart on purpose (the wait can be
  // hours) — `RunManager.recover()` re-arms it from this field. It can only mean
  // anything on a `waiting` run, so anywhere else it is stale bookkeeping.
  if (run.status !== 'waiting') run.autoResumeAt = undefined;
}

/**
 * Settle an adopted dead owner’s live run without starting work. Untouched runs cancel; started
 * runs become interrupted. Stop explicitly cancels its target. Mutates run.
 */
export function settleOrphanedRun(run: RunRecord, opts: { stop?: boolean | undefined } = {}): RunRecord {
  if (opts.stop && (run.status === 'queued' || run.status === 'running' || run.status === 'waiting')) run.stopping = true;
  if (run.status === 'queued' && !run.startedAt && run.workflowDef !== undefined &&
    run.steps.every((step) => step.status === 'pending' && !step.startedAt && !step.sessionId)) {
    run.status = 'cancelled';
    run.finishedAt ??= new Date().toISOString();
  }
  return reconcileLoadedRun(run, { keepLive: false });
}

/**
 * Drop this run's referenced PR/issue if the project's handle proves it foreign and the prompt
 * does not corroborate it (#945). Returns whether anything changed.
 *
 * One-directional by construction: it only ever clears fields, so a record written by an older
 * cezar — or read by one after this ran — is never worse off, and a downgrade sees a record whose
 * format is untouched and whose cleared fields were already optional.
 */
export function rescopeRun(run: RunRecord, handle?: RepoHandle | null): boolean {
  let changed = false;
  if (handle && run.pullRequests) {
    const entries = run.pullRequests.map(entry => {
      if (entry.source !== 'declared' || !entry.url || isRepoScopedRef(entry.url, run.task, handle)) return entry;
      // Revoke an uncorroborated URL, preserving the accepted declaration and its order.
      return { number: entry.number, source: entry.source };
    });
    const next = mergePullRequests(undefined, entries, `https://github.com/${handle.owner}/${handle.name}`);
    if (!isDeepStrictEqual(next, run.pullRequests)) { run.pullRequests = next; changed = true; }
  }
  if (
    run.referencedPullRequestUrl &&
    !isRepoScopedRef(run.referencedPullRequestUrl, run.task, handle)
  ) {
    run.referencedPullRequestUrl = undefined;
    changed = true;
  }
  if (
    run.referencedIssueUrl &&
    !isRepoScopedRef(run.referencedIssueUrl, run.task, handle)
  ) {
    run.referencedIssueUrl = undefined;
    changed = true;
    // Take back the number this janitor seeded from that very URL — the same revoke
    // `trackReferencedIssues` performs when ambiguity clears a resolution. A `prNumber`-style
    // number the prompt, namer or a marker owns is NOT ours to touch, which is exactly what
    // `referencedIssueNumberSeeded` records.
    if (run.referencedIssueNumberSeeded) {
      run.issueNumber = undefined;
      run.referencedIssueNumberSeeded = undefined;
    }
  }
  return changed;
}

/**
 * Every field `RunStore.open` may rewrite while loading a record: what `reconcileLoadedRun`
 * assigns. Compared before and after, it tells open() which rows normalization changed, so it
 * marks those dirty and no others. Edit it together with that function, or a normalized row stays unsaved (the store tests pin each field).
 */
function loadNormalizedFields(run: RunRecord): string {
  return JSON.stringify([
    run.stopping, run.status, run.finishedAt, run.error, run.autoResumeAt,
    run.referencedPullRequestUrl, run.pullRequests,
    run.issueNumber, run.referencedIssueUrl, run.referencedIssueNumberSeeded, run.hasPendingPermission, run.steps.map((step) => step.status),
  ]);
}

/** Test seam (#779): `beforeTransaction` runs once `runs.json` is read and parsed, before the
 *  import asks for the write lock; `beforeCommit` runs inside the import transaction, after every
 *  row is written and before the last check that no older cezar wrote `runs.json` meanwhile. */
let legacyImportHook: { beforeTransaction?: () => void; beforeCommit?: () => void } | undefined;

export function __setLegacyImportHookForTests(hook?: { beforeTransaction?: () => void; beforeCommit?: () => void }): void {
  legacyImportHook = hook;
}

/** `runs.json`'s records as rows, and how many of its entries were left out. Each row's `data` is
 *  the record's own JSON as `runs.json` held it, so nothing this cezar's schema does not know is lost
 *  (raw-record.ts); its summary and columns come from the parsed record, which is what decoding that
 *  JSON gives back. An entry that does not parse is skipped and costs that entry only, as an
 *  unreadable row does once it is in the database. Undefined when the file is not a JSON array. */
function legacyIndexRows(bytes: Buffer): { rows: RunRowInput[]; skipped: number; total: number } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  // A hand-edited index may repeat an id; the last one won when it loaded into a map, so it still does.
  const rows = new Map<string, RunRowInput>();
  let skipped = 0;
  for (const entry of raw as unknown[]) {
    // `parseRunRecords`' salvage rewrites top-level keys: the stored JSON is taken from a copy.
    const stored = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry;
    const parsed = parseRunRecords([entry]);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const run = parsed.data[0]!;
    rows.set(run.id, encodeRunRow(run, JSON.stringify(stored)));
  }
  return { rows: [...rows.values()], skipped, total: raw.length };
}

/**
 * Import legacy rows and the completion marker atomically, once. Recheck live-writer evidence
 * before commit and preserve exact input bytes in a synced backup. Leave runs.json untouched;
 * invalid entries are skipped and reported.
 */
function importLegacyIndex(db: RunDatabase, dataDir: string): void {
  assertNoLegacyCockpit(dataDir);
  const snapshot = readLegacyIndex(join(dataDir, LEGACY_INDEX_FILE));
  const parsed = snapshot ? legacyIndexRows(snapshot.bytes) : undefined;
  const rows = parsed?.rows ?? [];
  const skipped = parsed?.skipped ?? 0;
  const source = !snapshot ? 'none' : parsed ? LEGACY_INDEX_FILE : `${LEGACY_INDEX_FILE} (unparseable)`;
  assertNoLegacyWriter(dataDir, snapshot);
  legacyImportHook?.beforeTransaction?.();
  let backup: string | undefined;
  const commit = db.transaction({
    upserts: rows,
    deletes: [],
    onlyIfMetaAbsent: RUNS_IMPORT_COMPLETE_KEY,
    beforeCommit: () => {
      legacyImportHook?.beforeCommit?.();
      assertNoLegacyWriter(dataDir, snapshot);
      backup = snapshot ? backUpLegacyIndex(dataDir, snapshot) : undefined;
      const read = snapshot ? { bytes: snapshot.bytes.length, sha256: snapshot.sha256, backup } : {};
      return { [RUNS_IMPORT_COMPLETE_KEY]: JSON.stringify({ at: new Date().toISOString(), source, records: rows.length, ...(skipped > 0 ? { skipped } : {}), ...read }) };
    },
  });
  // Told once, by the import that committed: the marker means no later open reads runs.json again.
  if (commit.skipped || backup === undefined) return;
  const kept = `Its exact bytes are kept in ${join(dataDir, backup)}; https://github.com/hearsay-tools/cezarion/blob/main/docs/run-history-recovery.md says how to import it after a repair.`;
  if (!parsed) console.warn(`[cez] ${LEGACY_INDEX_FILE} could not be read; no run was imported, and this project starts with an empty history. ${kept}`);
  else if (skipped > 0) console.warn(`[cez] ${skipped} of ${parsed.total} runs in ${LEGACY_INDEX_FILE} could not be read and were not imported. ${kept}`);
}

/**
 * Finished rows whose stored summary an open-time normalization would still change: a referenced
 * PR an older cezar's created-PR declaration erased, or issue attribution displaced by a
 * follow-up declaration (see `reconcileLoadedRun`). Not live, so not
 * in the `live` column; open decodes these few and keeps the ones it actually repaired.
 */
const LEGACY_REFERENCE_HEAL_SQL =
  "(json_extract(summary, '$.markerRefs.pr') IS NOT NULL AND json_extract(summary, '$.referencedPullRequestUrl') IS NULL)" +
  " OR (NOT EXISTS (SELECT 1 FROM meta WHERE key = 'issue-attribution:' || runs.id AND value = CAST(runs.revision AS TEXT)) AND json_extract(summary, '$.markerRefs.issue') IS NOT NULL)";

/**
 * Rows whose record names the automation that launched it while the stored summary does not
 * (hearsay-tools/cezarion#1332): summaries a cezar wrote before `RunSummary.automationId`
 * existed. Open rewrites each one's summary once, so the sidebar's Automations tab classifies a
 * finished task nobody has opened since the upgrade. `instr` keeps the JSON parse off every
 * other row.
 */
const AUTOMATION_ORIGIN_HEAL_SQL =
  "instr(data, '\"automation') > 0 AND json_extract(summary, '$.automationId') IS NULL" +
  " AND (json_extract(data, '$.automation.automationId') IS NOT NULL OR json_extract(data, '$.automationTrigger.automationId') IS NOT NULL)";

/** Mark-all-read's rule (see `RunStore.markAllRead`) over the columns and the stored summary. */
const MARK_ALL_READ_SQL = "archived = 0 AND status IN ('done', 'failed') AND finished_at IS NOT NULL" +
  " AND (json_extract(summary, '$.seenAt') IS NULL OR json_extract(summary, '$.seenAt') < finished_at)";

/** History retention's candidates among the given ids (a JSON array): finished, without
 *  delegation, and not pinned. */
const RETENTION_CANDIDATES_SQL = "id IN (SELECT value FROM json_each(?)) AND status NOT IN ('queued', 'running', 'waiting')" +
  " AND parent_run_id IS NULL AND json_extract(summary, '$.delegation') IS NULL" +
  " AND json_extract(summary, '$.pinned') IS NOT 1";

/** Rows whose stored summary names a referenced PR or issue: what a repository handle can veto. */
const REFERENCED_SQL =
  "json_extract(summary, '$.referencedPullRequestUrl') IS NOT NULL OR json_extract(summary, '$.referencedIssueUrl') IS NOT NULL";

/** What branch cleanup and git-log attribution read about a run (`RunStore.listBranchOwners`). */
export interface BranchOwner {
  id: string;
  title: string;
  status: RunStatus;
  archived: boolean;
  createdAt: string;
  /** The branch the run owns (see `encodeRunRow`); absent for a run listed for its PR alone. */
  branch?: string;
  baseBranch?: string;
  pullRequestUrl?: string;
}

/** A record as a branch owner, or undefined when it owns no branch and created no PR: the
 *  projection `listBranchOwners` reads off a row's summary and columns, computed from memory. */
export function branchOwnerOf(run: RunRecord): BranchOwner | undefined {
  const branch = encodeRunRow(run).branch;
  if (!branch && run.pullRequestUrl === undefined) return undefined;
  return {
    id: run.id, title: run.title, status: run.status, archived: run.archived, createdAt: run.createdAt,
    ...(branch ? { branch } : {}),
    ...(run.baseBranch === undefined ? {} : { baseBranch: run.baseBranch }),
    ...(run.pullRequestUrl === undefined ? {} : { pullRequestUrl: run.pullRequestUrl }),
  };
}

/** Who may hold a run in memory besides its own record (see `RunStore.pin`). `maintenance` is the
 *  RunManager's publish, worktree-reclaim and branch-cleanup claims, held across their async work. */
export type RunPinHolder = 'active' | 'continue' | 'cleanup' | 'maintenance';

/**
 * Who may change a run, as this store sees it (#779, plan step 3; `RunStore.runOwnership`):
 * - `held`: this store claims its delegation family;
 * - `free`: no live process claims it and nothing in its family is live; a write takes it. A
 *   proven-dead owner's claim on such a family counts for nothing: there is nothing to recover;
 * - `orphaned`: nobody alive owns a family that still has a live run (its owner died, or nobody
 *   claimed it): taking it means adopting it first (`RunStore.adoptFamily` settles it, then the
 *   manager recovers the family);
 * - `foreign`: another process that is alive (or cannot be proven dead) holds it: read-only here;
 * - `quarantined`: a write found it changed under this store; refused until cezar restarts.
 */
export type RunOwnership = 'held' | 'free' | 'orphaned' | 'foreign' | 'quarantined';

/** The one answer every control gives for a run another cezar process owns (`409 { error }`). */
export const RUN_IN_USE_ELSEWHERE = 'run is in use by another cezar process';
/** The answer for a run this process stopped writing after a conflicting write. */
export const RUN_QUARANTINED = 'run changed under this cezar process — restart cezar to reload it';

/** A write this store must not make: another process owns the run, its owner died with work
 *  still live (adopt it first), or a conflict quarantined it. Nothing was changed. */
export class RunWriteRefusedError extends Error {
  constructor(readonly runId: string, readonly ownership: Exclude<RunOwnership, 'held' | 'free'>) {
    super(ownership === 'quarantined' ? `${RUN_QUARANTINED}: ${runId}`
      : ownership === 'orphaned' ? `run ${runId} belongs to a cezar process that exited; take it over before writing it`
        : `${RUN_IN_USE_ELSEWHERE}: ${runId}`);
    this.name = 'RunWriteRefusedError';
  }
}

/** How many times open (or an adoption) tries to take its claims while another connection holds
 *  the write lock, each waiting out the 50 ms busy timeout: recovery cannot start without them. */
const ADOPT_CLAIM_ATTEMPTS = 10;

/** The `run_claims` family of a run: a worker's parent, else the run itself (`parent_run_id ?? id`). */
function familyKey(run: Pick<RunRecord, 'id' | 'delegation'>): string {
  return run.delegation?.role === 'worker' ? run.delegation.parentRunId : run.id;
}

/** The same family, off a stored row's columns. */
function rowFamily(row: Pick<RunRow, 'id' | 'parentRunId'>): string {
  return row.parentRunId ?? row.id;
}

/** Make `target` hold exactly `source`'s fields, keeping the object every holder references. */
function replaceRecord(target: RunRecord, source: RunRecord): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, source);
}

/** Where a run lists: by `createdAt`, then by `seq`, its row's insertion order (see the `runs`
 *  schema). A `RunRow` is one. */
interface ListOrder {
  createdAt: string;
  seq: number;
}

/** An archived root's place in the archived list, with its summary once it is known: a held run's,
 *  or a searched row's. A row ranked by key alone has none, and its page reads it. */
type ArchivedKey = ListOrder & { summary?: RunSummary };

/** Newest first, runs created in the same millisecond in insertion order: the order `runs.db`
 *  lists in, and the order every list had while it was a stable sort of the in-memory map. */
/** Why a `run` event fired, when a delegation checkpoint caused it or nothing durable changed
 *  (`republish`) (in-process only). */
export type CommitSource = 'delegation-checkpoint' | 'delegation-destroy-progress' | 'live-release';

/**
 * A worker's destroy moving between two unfinished phases, and nothing else changing: nothing the
 * family reconcile reads changed, so it may skip that pass (#880). The first request and the
 * `complete` phase still reconcile: one changes delivery eligibility, the other settles requests.
 */
function isDestroyProgress(before: RunRecord['delegation'], after: DelegationState): boolean {
  if (before?.role !== 'worker' || after.role !== 'worker' || !before.destroy || !after.destroy) return false;
  if (before.destroy.phase === 'complete' || after.destroy.phase === 'complete') return false;
  return isDeepStrictEqual({ ...before, destroy: undefined }, { ...after, destroy: undefined });
}

/**
 * Two collected worker results carry the same evidence: equal but for when they were observed and
 * which snapshot file holds them, and, with `ignoreCleanup`, the cleanup phase. A retried destroy
 * that observed nothing new then rewrites and fsyncs nothing (hearsay-tools/cezarion#879).
 */
function sameWorkerResult(a: WorkerCollectedResult, b: WorkerCollectedResult, opts: { ignoreCleanup?: boolean }): boolean {
  const comparable = (value: WorkerCollectedResult) => ({ ...value, observedAt: undefined, ...(opts.ignoreCleanup ? { cleanup: undefined } : {}),
    diff: value.diff.state === 'available' ? { ...value.diff, snapshotId: undefined, path: undefined } : value.diff });
  return isDeepStrictEqual(comparable(a), comparable(b));
}

/** NDJSON transcript text to events; a damaged line is skipped, never fatal. */
function parseEvents(raw: string): RunEvent[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RunEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is RunEvent => e !== null);
}

function newestFirst(a: ListOrder, b: ListOrder): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
}

/** An archived page's cursor: the last row's order, opaque to clients. A held run with no row yet
 *  lists after every row (`seq` is infinite), which JSON cannot carry, so it travels as null. */
function encodeArchivedCursor(key: ListOrder): string {
  return Buffer.from(JSON.stringify({ c: key.createdAt, s: Number.isFinite(key.seq) ? key.seq : null })).toString('base64url');
}

function decodeArchivedCursor(cursor: string): ListOrder | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { c, s } = parsed as { c?: unknown; s?: unknown };
    if (typeof c !== 'string' || !(s === null || (typeof s === 'number' && Number.isInteger(s)))) return undefined;
    return { createdAt: c, seq: s ?? Number.POSITIVE_INFINITY };
  } catch {
    return undefined;
  }
}

/** The items newest first, each by the order beside it. Stable: ties keep their input order. */
function sortNewestFirst<T>(entries: Iterable<readonly [T, ListOrder]>): T[] {
  return [...entries].sort(([, a], [, b]) => newestFirst(a, b)).map(([item]) => item);
}

/** The delegation family a run belongs to, by its root's id: a root is its own, a worker its
 *  parent's. Workers cannot delegate, so a family is one root and its direct workers, never more. */
function familyRootOf(run: Pick<RunRecord, 'id' | 'delegation'>): string | undefined {
  if (run.delegation?.role === 'root') return run.id;
  if (run.delegation?.role === 'worker') return run.delegation.parentRunId;
  return undefined;
}

/** Tests freeze the copies of cold runs, so an in-place write to one throws instead of vanishing. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}


const WORKER_PROCESS_CAP = 32;
const recordedProcessSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().min(1).max(128).optional(),
  pgid: z.number().int().positive().optional() }).strict();
const workerProcessRecordSchema = z.object({ generation: z.string().uuid(), controller: recordedProcessSchema,
  processes: z.array(recordedProcessSchema).max(WORKER_PROCESS_CAP) }).strict();
const startToken = (pid: number) => { const token = processStartToken(pid); return token === undefined ? {} : { startToken: token }; };

/**
 * Run rows in runs.db plus append-only NDJSON events and an in-process event bus. Hold live,
 * pinned, related and unsettled records only. Optimistic writes debounce; durable commits
 * publish after persistence. Family claims fence every write.
 */
export class RunStore extends EventEmitter {
  /** The held set: every record this store keeps in memory, by id. */
  private readonly held = new Map<string, RunRecord>();
  /** Who holds a run beyond its record, by holder, so one holder's unpin never releases another. */
  private readonly pins = new Map<string, Set<RunPinHolder>>();
  /** Staged ids while a durable commit installs and announces them: never evicted mid-commit. */
  private readonly committing = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  /** `null` once the store is closed, and in a `RunStore.unavailable` store (nothing is written,
   *  nothing is evicted). */
  private db: RunDatabase | null = null;
  /** Why `open` failed, in a `RunStore.unavailable` store. */
  private openFailure: RunStoreOpenError | undefined;
  /** Runs whose held record is ahead of its row; the next save or commit writes them. */
  private readonly dirty = new Set<string>();
  /** Runs gone from memory whose rows the next save or commit deletes. */
  private readonly deleted = new Set<string>();
  /** Deleted runs whose history files (events, handoff, images, artifacts) go once the delete of
   *  their row commits: until then a conflict can undo the delete and bring the row back. */
  private readonly historyOwed = new Set<string>();
  /** The repository this project IS (#945), armed after `open()` by `setRepoHandle`. Undefined
   *  until it arrives and `null` when it cannot be known — both mean "unscoped", which is
   *  exactly the pre-#945 behavior. */
  private repoHandle: RepoHandle | null | undefined;
  /** `open()`'s `keepLive`, which a run read later from `runs.db` is reconciled with too. */
  private keepLive = false;
  /** This store's identity in `run_claims`; undefined without a database. */
  private owner: ClaimOwner | undefined;
  /** The families this store claims, with the generation each acquisition got. */
  private readonly claimed = new Map<string, number>();
  /** Families judged free whose claim a busy database kept this store from taking: the next write
   *  of their rows takes it in its own transaction, if it is still as judged (null: absent). */
  private readonly pendingClaims = new Map<string, { session: string; generation: number } | null>();
  /** The revision and `data` of each held row (and pending deletion) as this store last read or
   *  wrote it: what a write is fenced against, and a conflict's "original". No entry: this store
   *  created the row and has not written it yet. `extras` is what that `data` holds beyond the
   *  schema, which the next write of the row puts back (raw-record.ts). */
  private readonly base = new Map<string, StoredRow>();
  /** Rows read cold in the current synchronous turn, so a commit staged from one is fenced against
   *  the version it was computed from. `owned`: its family was already this store's when read.
   *  Cleared at the next microtask: no commit spans a turn. */
  private readonly coldBase = new Map<string, StoredRow & { owned: boolean }>();
  /** The family of each pending deletion, whose claim the deleting write is fenced against. */
  private readonly deletedFamilies = new Map<string, string>();
  /** Rows a conflicting write excluded: this store refuses to write them until it is reopened. */
  private readonly quarantined = new Set<string>();
  /** Rows whose `data` this store tried to decode and could not: left in the database untouched,
   *  and left out of the list rows from then on, as the cold reader leaves them out (run-index.ts). */
  private readonly unreadable = new Set<string>();
  /** Background one-at-a-time compressor for archived transcripts (#818). */
  private readonly compressor: HistoryCompressor;
  /** Transcript facts the delegation paths ask about, so they never re-read a transcript (#880). */
  private readonly facts: TranscriptFactsIndex;
  private readonly liveItems = new LiveItemSnapshots();

  /** Capture both sources on the same synchronous sequence boundary before history IO. */
  liveReadSnapshot(runId: string) {
    return { events: this.liveItems.read(runId), throughSeq: this.seqs.get(runId) ?? Infinity };
  }

  private constructor(private readonly dataDir: string) {
    super();
    this.setMaxListeners(100);
    this.facts = new TranscriptFactsIndex(dataDir);
    this.compressor = new HistoryCompressor(dataDir, (id) => this.isHistoryCompressEligible(id),
      (id, plain, archive) => this.facts.adoptArchive(id, plain, stampOf(archive)));
  }

  /**
   * Open the project's run store. See `reconcileLoadedRun` for what `keepLive` (#367) decides
   * about live-looking rows.
   *
   * Reads `runs.db` once its import is complete. Before that, `runs.json` is imported into it in
   * one transaction (`importLegacyIndex`) and left exactly as it was, for older cezars to read.
   * Either way only the held set is decoded: the live rows (by the indexed `live` column), the
   * few finished rows a normalization still repairs, and the delegation families of the live
   * ones.
   *
   * A store that cannot be opened is never an empty one (#779, plan step 4): `open` throws a
   * `RunStoreOpenError` naming the cause, and nothing is reset, restored or deleted. `retryBusy`
   * waits out a busy database (and a cockpit that may still be importing) with growing pauses,
   * about 3.5 s in all, before it gives up. Open is synchronous, so the wait blocks this thread:
   * only a boot passes it, while nothing else runs yet. Without it a busy database fails after
   * one busy timeout.
   */
  static open(dataDir: string, opts?: { keepLive?: boolean | undefined; retryBusy?: boolean; maintenance?: boolean }): RunStore {
    const path = join(dataDir, RUNS_DB_FILE);
    const delays = opts?.retryBusy ? OPEN_RETRY_DELAYS_MS : [];
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return RunStore.openOnce(dataDir, path, opts?.keepLive === true, opts?.maintenance === true);
      } catch (error) {
        const transient = error instanceof RunDatabaseBusyError || (error instanceof LegacyWriterError && error.reason === 'cockpit');
        if (!transient || attempt >= delays.length) {
          throw toRunStoreOpenError(error, path, attempt > 0 ? { waitedMs: Date.now() - started } : {});
        }
        sleepSync(delays[attempt]!);
      }
    }
  }

  private static openOnce(dataDir: string, path: string, keepLive: boolean, maintenance: boolean): RunStore {
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const store = new RunStore(dataDir);
    store.keepLive = keepLive;
    const db = RunDatabase.open(path);
    try {
      if (db.getMeta(RUNS_IMPORT_COMPLETE_KEY) === undefined) importLegacyIndex(db, dataDir);
      store.db = db;
      store.owner = openClaimSession();
      if (!maintenance) {
        store.loadHeldRows();
        store.warmTranscriptFacts();
      }
    } catch (error) {
      if (store.owner) {
        try { db.releaseClaims(store.owner.session); } catch { /* the session closes below: its claims are provably dead */ }
        closeClaimSession(store.owner.session);
      }
      store.owner = undefined;
      store.db = null;
      store.held.clear();
      store.dirty.clear();
      store.claimed.clear();
      store.base.clear();
      db.close();
      throw error;
    }
    return store;
  }

  /**
   * The store `serve` keeps for its boot project when `open` failed: no database, nothing held,
   * and every attempt to create or save a run refused with `failure`. The cockpit answers every
   * route of that project with `failure`'s message, and boot skips everything that would read
   * its empty run list as "no runs" (orphan pruning, retention, recovery, scratch sweeps). The
   * way out is a restart once the cause is gone.
   */
  static unavailable(dataDir: string, failure: RunStoreOpenError): RunStore {
    const store = new RunStore(dataDir);
    store.openFailure = failure;
    return store;
  }

  /** Why this store has no database, when it is `RunStore.unavailable`'s: its runs are unknown,
   *  not absent. */
  get unavailable(): RunStoreOpenError | undefined {
    return this.openFailure;
  }

  /**
   * Open-time load: the live rows, the finished rows a load normalization repairs, then the
   * delegation families of the live ones. A row that does not parse is skipped and left in the
   * database untouched; one warning says how many.
   *
   * Only rows this store can claim are loaded (#779, plan step 3). A live row whose family another
   * live process claims — `serve`'s parked run, seen by a headless `cez run` — is that process's:
   * it is not loaded, normalized or recovered here, and stays readable through `getRun` and the
   * list rows. A live row nobody alive claims is taken over, as before: this open recovers it
   * (`keepLive`) or settles it as interrupted.
   */
  private loadHeldRows(): void {
    let unreadable = 0;
    const decode = (row: RunRow): DecodedRun | undefined => {
      const decoded = decodeRunRow(row.data);
      if (!decoded) {
        unreadable++;
        this.unreadable.add(row.id);
      }
      return decoded;
    };
    const live = this.db!.listLive();
    const owned = this.claimFamilies(live.map(rowFamily), { allowLive: true, wait: true });
    for (const row of live) {
      if (!owned.has(rowFamily(row))) continue;
      const decoded = decode(row);
      if (decoded) this.adoptLoadedRun(decoded, { keepLive: this.keepLive }, row);
    }
    const heal = this.db!.listWhere(LEGACY_REFERENCE_HEAL_SQL).filter((row) => !this.held.has(row.id));
    const healable = this.claimFamilies(heal.map(rowFamily));
    for (const row of heal) {
      if (!healable.has(rowFamily(row))) continue;
      const decoded = decode(row);
      // Held only when the repair changed it: the next save writes it, then it leaves.
      if (decoded) {
        // Persist verification once even when legacy issue attribution was already correct.
        const needsIssueCheck = decoded.run.markerRefs?.issue !== undefined &&
          this.db!.getMeta(`issue-attribution:${row.id}`) !== String(row.revision);
        this.adoptLoadedRun(decoded, { keepLive: this.keepLive, onlyIfChanged: !needsIssueCheck }, row);
        if (needsIssueCheck) this.dirty.add(row.id);
      }
    }
    const stale = this.db!.listWhere(AUTOMATION_ORIGIN_HEAL_SQL).filter((row) => !this.held.has(row.id));
    const restamp = this.claimFamilies(stale.map(rowFamily));
    for (const row of stale) {
      if (!restamp.has(rowFamily(row))) continue;
      const decoded = decode(row);
      // Nothing in the record changes, only its summary: held dirty, the next save rewrites it.
      if (decoded) {
        this.adoptLoadedRun(decoded, { keepLive: this.keepLive }, row);
        this.dirty.add(row.id);
      }
    }
    for (const rootId of this.anchoredFamilies()) this.holdFamily(rootId, decode);
    this.releaseUnheldClaims();
    if (unreadable > 0) console.warn(`[cez] ${unreadable} run(s) in ${RUNS_DB_FILE} could not be read; they are left in the database untouched.`);
  }

  /** Normalize a record just read from `row` (see `reconcileLoadedRun`) and hold it. Marks the row
   *  dirty only when normalization changed it, so the next save persists exactly the runs open()
   *  rewrote. A row read up from schema-3 wait fields counts as changed: its rewrite drops them
   *  and recomputes its summary and live column (`upgradeLegacyWaits`). The caller has claimed
   *  the row's family. */
  private adoptLoadedRun({ run, extras, upgraded }: DecodedRun, opts: { keepLive?: boolean; onlyIfChanged?: boolean; settle?: boolean; stop?: boolean }, row: RunRow): void {
    const before = loadNormalizedFields(run);
    if (opts.settle) settleOrphanedRun(run, { stop: opts.stop });
    else reconcileLoadedRun(run, opts);
    const changed = upgraded === true || loadNormalizedFields(run) !== before;
    if (opts.onlyIfChanged && !changed) return;
    this.held.set(run.id, run);
    this.base.set(run.id, { revision: row.revision, seq: row.seq, data: row.data, extras });
    if (changed) this.dirty.add(run.id);
  }

  /**
   * Hold one delegation family: its root and the root's direct workers, read through the
   * `parent_run_id` index. No recursion: workers cannot delegate, so a worker's own id never
   * names a family. The caller has claimed it. `settle` settles its live rows instead of keeping
   * them for recovery (`settleOrphanedRun`); `stopId` is the run a Stop settles as cancelled.
   */
  private holdFamily(rootId: string, decode: (row: RunRow) => DecodedRun | undefined = (row) => decodeRunRow(row.data), settle = false, stopId?: string): void {
    const rows = [this.db!.get(rootId), ...this.db!.listByParent(rootId)];
    for (const row of rows) {
      if (!row || this.held.has(row.id) || this.deleted.has(row.id)) continue;
      const decoded = decode(row);
      if (decoded) this.adoptLoadedRun(decoded, { keepLive: this.keepLive, settle, stop: row.id === stopId }, row);
    }
  }

  /**
   * Make sure this store claims each of `families`, taking every one no live process holds, and
   * return the ones it now holds. Liveness is judged here (`claimOwnerLive`), outside the write
   * transaction; `takeClaims` then takes a claim only if it is still exactly what was judged.
   *
   * `allowLive` also takes a family that still has a live row although no live process owns it.
   * Open and `adoptFamily` pass it, because recovery follows both, and so does a write moving a
   * run this store holds into a new family (a worker quarantined to `invalid` becomes its own):
   * an ordinary write must not quietly inherit a dead process's live run and leave it unrecovered.
   * `wait` retries a busy database instead of leaving the claim to the next write: recovery
   * cannot start without it.
   */
  private claimFamilies(families: Iterable<string>, opts: { allowLive?: boolean; wait?: boolean } = {}): Set<string> {
    const owned = new Set<string>();
    const wanted: string[] = [];
    for (const family of new Set(families)) {
      if (this.claimed.has(family) || this.pendingClaims.has(family)) owned.add(family);
      else wanted.push(family);
    }
    if (!this.db || !this.owner || wanted.length === 0) return owned;
    const claims = this.db.getClaims(wanted);
    const take: Array<{ family: string; expect: { session: string; generation: number } | null }> = [];
    for (const family of wanted) {
      const claim = claims.get(family);
      if (claim && claimOwnerLive(claim)) continue;
      if (!opts.allowLive && this.db.familyHasLive(family)) continue;
      take.push({ family, expect: claim ? { session: claim.session, generation: claim.generation } : null });
    }
    if (take.length === 0) return owned;
    let taken: Map<string, number>;
    try {
      taken = this.takeClaims(take, opts.wait ? ADOPT_CLAIM_ATTEMPTS : 1);
    } catch (error) {
      if (!(error instanceof RunDatabaseBusyError)) throw error;
      // Recovery follows an adoption, so it must hold the claim first: those families stay
      // unclaimed and orphaned (a control or the next restart adopts them). A write does not wait:
      // its next transaction takes the claim (`fence`), or meets whoever took it meanwhile.
      if (opts.wait) return owned;
      for (const { family, expect } of take) {
        this.pendingClaims.set(family, expect);
        owned.add(family);
      }
      this.scheduleSave();
      return owned;
    }
    for (const [family, generation] of taken) {
      this.claimed.set(family, generation);
      owned.add(family);
    }
    // A claim taken for a write that then changes nothing still leaves at the next sweep.
    if (taken.size > 0) this.scheduleSave();
    return owned;
  }

  /** `takeClaims`, retried while another connection holds the write lock (each try waits out the
   *  busy timeout), then the busy error. */
  private takeClaims(take: Parameters<RunDatabase['takeClaims']>[1], attempts: number): Map<string, number> {
    for (let attempt = 1; ; attempt++) {
      try {
        return this.db!.takeClaims(this.owner!, take);
      } catch (error) {
        if (!(error instanceof RunDatabaseBusyError) || attempt >= attempts) throw error;
      }
    }
  }

  /** Release the claim of every family with nothing left in memory, once nothing is pending: a
   *  failed save keeps its families claimed until it succeeds. A failed release retries at the
   *  next sweep; `close()` releases the rest. */
  private releaseUnheldClaims(): void {
    if (!this.db || !this.owner || this.dirty.size > 0 || this.deleted.size > 0) return;
    const kept = new Set<string>();
    for (const run of this.held.values()) kept.add(familyKey(run));
    // A claim never taken has nothing to release in the database.
    for (const family of this.pendingClaims.keys()) if (!kept.has(family)) this.pendingClaims.delete(family);
    const released = [...this.claimed.keys()].filter((family) => !kept.has(family));
    if (released.length === 0) return;
    try {
      this.db.releaseClaims(this.owner.session, released);
      for (const family of released) this.claimed.delete(family);
    } catch {
      // Busy or failing: the next sweep tries again.
    }
  }

  /**
   * Who may change this run right now (see `RunOwnership`), or undefined when there is no such
   * run. Read-only: nothing is claimed. Controls ask this first, so a run another process owns is
   * refused with `RUN_IN_USE_ELSEWHERE` and a dead process's run is adopted before it is changed.
   */
  runOwnership(id: string): RunOwnership | undefined {
    if (this.quarantined.has(id)) return 'quarantined';
    const held = this.held.get(id);
    if (!this.db) return held ? 'held' : undefined;
    const family = held ? familyKey(held) : this.deleted.has(id) ? undefined : this.db.familyOf(id);
    if (family === undefined) return undefined;
    if (this.claimed.has(family) || this.pendingClaims.has(family)) return 'held';
    const claim = this.db.getClaim(family);
    if (claim && claimOwnerLive(claim)) return 'foreign';
    // The same rule `claimFamilies` writes by: a dead owner left only settled runs → free.
    return this.db.familyHasLive(family) ? 'orphaned' : 'free';
  }

  /** Why a control on this run must be refused here, or undefined when this store may change it. */
  writeRefusal(id: string): string | undefined {
    const ownership = this.runOwnership(id);
    if (ownership === 'quarantined') return RUN_QUARANTINED;
    return ownership === 'foreign' || ownership === 'orphaned' ? RUN_IN_USE_ELSEWHERE : undefined;
  }

  /**
   * Claim an orphaned family and settle its live rows before a control acts. Stop cancels its
   * target. Return the root id, or undefined for a live owner or missing run; adoption never
   * resumes work.
   */
  adoptFamily(id: string, opts: { stop?: boolean } = {}): string | undefined {
    const family = this.db?.familyOf(id);
    if (family === undefined || !this.claimFamilies([family], { allowLive: true, wait: true }).has(family)) return undefined;
    this.holdFamily(family, undefined, true, opts.stop ? id : undefined);
    return family;
  }

  /** Every run whose family another process owns — alive, or dead with a live run left to
   *  recover (cleanup keeps their scratch: it is theirs, or recovery's once someone adopts them).
   *  A dead owner's claim on a family with nothing live is no claim (see `runOwnership`). */
  listForeignClaimedRunIds(): string[] {
    const db = this.db, owner = this.owner;
    if (!db || !owner) return [];
    const kept = new Set(db.listClaims().filter((claim) => claim.session !== owner.session &&
      (claimOwnerLive(claim) || db.familyHasLive(claim.family))).map((claim) => claim.family));
    return kept.size === 0 ? [] : db.listForeignClaimedIds(owner.session).filter((row) => kept.has(row.family)).map((row) => row.id);
  }

  /**
   * Whether a held run anchors itself (and its family) in memory. Anything else held is a family
   * member or a settled write, and leaves at the next sweep (`evictSettled`).
   *
   * The held set is: every run that is live (`isLiveRecord`), pinned by a RunManager (`pin`),
   * dirty, or inside a durable commit; plus the whole delegation family (root and direct
   * workers) of any such run. Families are held because the RunManager reads a live run's family
   * on every run event — `GET /runs/:id/relationships`, the global `reconcileWorkerWaits` pass
   * (about twenty call sites), completion blockers and conversations — and decoding a cold
   * record costs about 200 µs (JSON.parse plus the schema). Measured on a copy of a real
   * cockpit's `runs.json` (958 runs, 957 of them delegated): a running root with 26 workers
   * paid about 5 ms per family read, and the live families together about 10 ms per global
   * pass, all on the event loop. Holding them costs memory in proportion to active work, not to
   * history.
   */
  private isAnchor(id: string, run: RunRecord): boolean {
    return isLiveRecord(run) || this.pins.has(id) || this.dirty.has(id) || this.committing.has(id);
  }

  /** The family roots with an anchoring member in memory. */
  private anchoredFamilies(): Set<string> {
    const roots = new Set<string>();
    for (const [id, run] of this.held) {
      const root = familyRootOf(run);
      if (root !== undefined && this.isAnchor(id, run)) roots.add(root);
    }
    return roots;
  }

  /** Drop every held run that is neither an anchor nor in an anchored family. A store without a
   *  database keeps everything: memory is the only copy it has. */
  private evictSettled(): void {
    if (!this.db) return;
    const families = this.anchoredFamilies();
    for (const [id, run] of this.held) {
      if (this.isAnchor(id, run)) continue;
      const root = familyRootOf(run);
      if (root !== undefined && families.has(root)) continue;
      this.held.delete(id);
      this.base.delete(id);
    }
    this.releaseUnheldClaims();
  }

  /** A run read from `runs.db`, normalized like a loaded one (`reconcileLoadedRun`, then the
   *  repository scope) but held by nobody. Undefined when absent, deleted or unreadable. */
  private loadCold(id: string): RunRecord | undefined {
    if (!this.db || this.deleted.has(id)) return undefined;
    const row = this.db.get(id);
    return row ? this.decodeCold(row) : undefined;
  }

  private decodeCold(row: RunRow): RunRecord | undefined {
    const decoded = decodeRunRow(row.data);
    if (!decoded) {
      this.unreadable.add(row.id);
      return undefined;
    }
    this.unreadable.delete(row.id);
    const { run, extras } = decoded;
    if (this.coldBase.size === 0) queueMicrotask(() => this.coldBase.clear());
    const family = rowFamily(row);
    this.coldBase.set(row.id, { revision: row.revision, seq: row.seq, data: row.data, extras, owned: this.claimed.has(family) || this.pendingClaims.has(family) });
    reconcileLoadedRun(run, { keepLive: this.keepLive });
    rescopeRun(run, this.repoHandle);
    return run;
  }

  /** Hold a run just decoded from its row: the object every later read and write shares. */
  private holdDecoded(run: RunRecord): RunRecord {
    const read = this.coldBase.get(run.id);
    this.held.set(run.id, run);
    if (read) this.base.set(run.id, storedRow(read));
    return run;
  }

  /**
   * Bring a run into memory and return the held object: the record a write changes in place.
   * It leaves again at the first sweep after its write settles, unless something anchors it.
   * Its family is claimed first, then the row is read, so the version held is the claimed one;
   * undefined while another process owns it (see `claimFamilies`).
   */
  private hold(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const family = this.db && !this.deleted.has(id) ? this.db.familyOf(id) : undefined;
    if (family === undefined || !this.claimFamilies([family]).has(family)) return undefined;
    const run = this.loadCold(id);
    if (!run) return undefined;
    this.holdDecoded(run);
    this.scheduleSave();
    return run;
  }

  /** The record a store write changes in place: held, or loaded to be. Undefined for a run this
   *  store may not write (another process's, or quarantined), so the write changes nothing. */
  private record(id: string): RunRecord | undefined {
    if (this.quarantined.has(id)) return undefined;
    return this.held.get(id) ?? this.hold(id);
  }

  /** The current record for reading: the held object, the held copy of a run whose family is in
   *  memory, or else a fresh copy nobody holds. */
  private peek(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const run = this.loadCold(id);
    return run && this.answerCold(run, false);
  }

  /**
   * A run just read off its row, as reads answer it: held when its family is in memory (a live
   * family's members are read on every run event), else a copy nobody holds — frozen under
   * vitest when it leaves the store (`freeze`).
   */
  private answerCold(run: RunRecord, freeze: boolean): RunRecord {
    const root = familyRootOf(run);
    if (root !== undefined && this.anchoredFamilies().has(root)) return this.holdDecoded(run);
    return freeze && process.env.VITEST ? deepFreeze(run) : run;
  }

  /** `getRun` for a row a query already read: the held object, else decoded from `row`. */
  private fromRow(row: RunRow): RunRecord | undefined {
    const held = this.held.get(row.id);
    if (held) return held;
    if (this.deleted.has(row.id)) return undefined;
    const run = this.decodeCold(row);
    return run && this.answerCold(run, true);
  }

  /** Whether the run exists, held or not, without decoding it. */
  private hasRun(id: string): boolean {
    return this.held.has(id) || (!!this.db && !this.deleted.has(id) && this.db.has(id));
  }

  /**
   * Keep a run in memory for `holder` until `unpin(id, holder)`: a RunManager pins the runs it is
   * executing (`active`) and the run a Continue is admitting (`continue`). A finished run is
   * loaded. Pins are per holder, so releasing one never releases another. Returns the held record.
   */
  pin(id: string, holder: RunPinHolder): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    let holders = this.pins.get(id);
    if (!holders) this.pins.set(id, holders = new Set());
    holders.add(holder);
    return run;
  }

  /** Publish a run's current record again without a write: something read beside the record
   *  changed, such as the run leaving the manager's live registries, which a detail's finish
   *  verdict reads (hearsay-tools/cezarion#1301). */
  republish(id: string): void {
    const run = this.peek(id);
    if (run) this.emit('run', run, 'live-release');
  }

  /** Release `holder`'s pin. The run leaves memory at the next sweep once nothing else holds it. */
  unpin(id: string, holder: RunPinHolder): void {
    const holders = this.pins.get(id);
    if (!holders?.delete(holder)) return;
    if (holders.size === 0) this.pins.delete(id);
    this.sweepIfSettled([id]);
  }

  /**
   * Set discovered repository identity without blocking boot. Recompute conclusions from retained
   * evidence, including cold records; null retains unknown-handle behavior.
   */
  setRepoHandle(handle: RepoHandle | null): void {
    this.repoHandle = handle;
    if (!handle) return; // nothing to prove foreign against
    // `touch` per healed run: the cockpit is already live when the handle lands, so a corrected
    // chip has to reach the open page over SSE, not just the next `runs.json` write.
    let healed = false;
    const own = `${handle.owner}/${handle.name}`.toLowerCase();
    const foreign = (url: string | undefined) => url !== undefined && refUrlRepo(url) !== own;
    const stored = this.db?.listWhere(REFERENCED_SQL).filter((row) => {
      if (this.held.has(row.id) || this.deleted.has(row.id)) return false;
      const summary = parseStoredSummary(row.summary);
      return !summary || foreign(summary.referencedPullRequestUrl) || foreign(summary.referencedIssueUrl);
    }) ?? [];
    for (const run of [...this.held.values()]) {
      if (rescopeRun(run, this.repoHandle)) {
        this.touch(run);
        healed = true;
      }
    }
    // Only rows this store may write: another process's runs heal when their owner arms its handle.
    const writable = this.claimFamilies(stored.map(rowFamily));
    for (const row of stored) {
      if (!writable.has(rowFamily(row))) continue;
      const run = this.decodeCold(row);
      // `decodeCold` already scoped it with the handle just armed; write it when that changed it.
      if (!run || !this.storedScopeDiffers(row, run)) continue;
      this.holdDecoded(run);
      this.touch(run);
      healed = true;
    }
    // Discovery may finish after headless shutdown's final flush. Persist repairs now: the
    // debounced save is unref'd, so it cannot keep the CLI alive once the lookup completes.
    if (healed) this.flush();
  }

  /** Whether the stored summary still names a reference the scoped record no longer has. */
  private storedScopeDiffers(row: RunRow, run: RunRecord): boolean {
    const summary = parseStoredSummary(row.summary);
    return summary?.referencedPullRequestUrl !== run.referencedPullRequestUrl ||
      summary?.referencedIssueUrl !== run.referencedIssueUrl || summary?.issueNumber !== run.issueNumber;
  }

  /**
   * The live set, newest first: runs whose record is live (`isLiveRecord`) or that a RunManager
   * pins. Finished runs are not here — read one by id (`getRun`), by an indexed query
   * (`listWorkersOf`, `findRunByClientRequestId`, `listRunsWithWorktree`,
   * `listBranchOwners`), or as list rows (`listRunSummaries`).
   */
  listRuns(): RunRecord[] {
    return sortNewestFirst([...this.held].filter(([id, run]) => isLiveRecord(run) || this.pins.has(id)).map(([, run]) => [run, this.listOrder(run)]));
  }

  /** Where a held run lists: its row's insertion order, or after every row while this store has
   *  not written it yet. The held set keeps such runs in creation order, and so does every list
   *  that sorts them in held-set order (`sortNewestFirst` is stable). */
  private listOrder(run: RunRecord): ListOrder {
    return { createdAt: run.createdAt, seq: this.base.get(run.id)?.seq ?? Number.POSITIVE_INFINITY };
  }

  /**
   * EVERY run as a full record, newest first — decoded row by row. Only the legacy `GET /runs`
   * (older clients; the cockpit reads `GET /run-summaries`) may call this: it is exactly the
   * whole-history parse #779 exists to remove from everything else.
   */
  listAllRunsForLegacyRoute(): RunRecord[] {
    const runs = new Map<string, readonly [RunRecord, ListOrder]>();
    for (const row of this.db?.listAll() ?? []) {
      if (this.deleted.has(row.id) || this.held.has(row.id)) continue;
      const run = this.decodeCold(row);
      if (run) runs.set(row.id, [run, row]);
    }
    for (const [id, run] of this.held) runs.set(id, [run, this.listOrder(run)]);
    return sortNewestFirst(runs.values());
  }

  /** A bounded page of discoverable peer roots, including the current held overlay. */
  listPeerTaskSummaries(options: PeerTaskPageOptions) {
    return listPeerTaskSummaries({ db: this.db, held: this.held, skipped: this.deleted,
      order: run => this.listOrder(run), cold: id => this.coldSummary(id) }, options);
  }

  /**
   * Every run as its list row, newest first: the stored `summary` column, with each held run's
   * own projection laid over it — a debounced save keeps memory up to 300 ms ahead of the row,
   * and a run created since the last save has no row yet. `usage` is the caller's to attach.
   *
   * With `archivedWindow` (#864), the window the cockpit's lists read: every unarchived run, plus
   * the newest `archivedWindow` archived ROOT runs, and whether older archived roots were left
   * out. Archived workers are never in it (see `RunDatabase.listWindowSummaries`); with `roots`,
   * no worker is — the runs index, whose readers list no workers. A held run
   * lists by its record, so one archived or unarchived since the last save is ranked as it is now.
   *
   * A row this store found unreadable is left out, as the cold reader leaves out a row it had to
   * decode and could not. A finished row nobody has decoded is served from its summary by both,
   * which decodes nothing; reading it is what finds out (`isUnreadable`).
   */
  listRunSummaries(options: { archivedWindow?: number | undefined; roots?: boolean } = {}): { runs: RunSummary[]; truncated: boolean } {
    const { archivedWindow, roots = false } = options;
    // Every skipped row may be an archived root, so ask for that many more: one past the window
    // after skipping is how "older ones were left out" is known without counting them.
    const rows = (archivedWindow === undefined
      ? this.db?.listSummaries()
      : this.db?.listWindowSummaries(archivedWindow + 1 + this.deleted.size + this.unreadable.size + this.held.size, { roots })) ?? [];
    const summaries = new Map<string, readonly [RunSummary, ListOrder]>();
    for (const row of rows) {
      if (this.deleted.has(row.id) || this.held.has(row.id) || this.unreadable.has(row.id)) continue;
      const summary = parseStoredSummary(row.summary) ?? this.coldSummary(row.id);
      if (summary) summaries.set(row.id, [summary, row]);
    }
    for (const [id, run] of this.held) {
      if (archivedWindow !== undefined && (run.archived || roots) && run.delegation?.role === 'worker') continue;
      summaries.set(id, [toRunSummary(run), this.listOrder(run)]);
    }
    const runs = sortNewestFirst(summaries.values());
    if (archivedWindow === undefined) return { runs, truncated: false };
    let archived = 0;
    const kept = runs.filter((run) => !run.archived || ++archived <= archivedWindow);
    return { runs: kept, truncated: archived > archivedWindow };
  }

  /**
   * One page of archived ROOT runs, newest first (#864): `GET /run-summaries/archived`, the
   * archived runs past the window. Held runs list by their record, as in `listRunSummaries`.
   * `before` is the previous page's `nextCursor`; with `q`, only runs `matchesRunQuery` keeps, and
   * `total` counts those. `automationNames` lets `q` match a task by its automation's name, as the
   * list's origin line shows it (hearsay-tools/cezarion#1616). A cursor this store did not write
   * answers `{ error }`.
   *
   * Ranking reads every archived root's key (id, created_at, seq: no record, no summary), so the
   * page and `total` agree with the held overlay; only the page's own rows are read in full.
   */
  listArchivedRuns(options: { before?: string; limit: number; q?: string; automationNames?: AutomationNames }): ArchivedRunsResponse | { error: string } {
    let after: ListOrder | undefined;
    if (options.before !== undefined) {
      after = decodeArchivedCursor(options.before);
      if (!after) return { error: 'before is not a cursor this server wrote' };
    }
    const q = options.q?.trim() ?? '';
    const ranked = this.rankArchivedRows(q, options.automationNames);
    this.overlayHeldArchived(ranked, q, options.automationNames);
    const ordered = [...ranked.entries()].sort(([, a], [, b]) => newestFirst(a, b));
    return this.archivedPage(ordered, after, options.limit);
  }

  /** The archived roots in `runs.db`, each by its key: every one without `q` (no record, no
   *  summary read), and with `q` the searched rows `matchesRunSearch` keeps, which carry the summary
   *  the search read. A deleted, held or unreadable run's row is left out; a held run joins in
   *  `overlayHeldArchived`. */
  private rankArchivedRows(q: string, automationNames: AutomationNames | undefined): Map<string, ArchivedKey> {
    const skipped = (id: string) => this.deleted.has(id) || this.held.has(id) || this.unreadable.has(id);
    const ranked = new Map<string, ArchivedKey>();
    if (q === '') {
      for (const key of this.db?.listKeysWhere(ARCHIVED_ROOT) ?? []) if (!skipped(key.id)) ranked.set(key.id, key);
    } else {
      for (const row of this.db?.searchRootSummaries(sqlPrefilterTokens(q, { automationNames })) ?? []) {
        if (skipped(row.id)) continue;
        const summary = parseStoredSummary(row.summary) ?? this.coldSummary(row.id);
        if (summary?.archived && matchesRunSearch(summary, q, { automationNames })) ranked.set(row.id, { ...row, summary });
      }
    }
    return ranked;
  }

  /** Lay the held archived roots over `ranked`, each by its record: it replaces its stored row
   *  (already left out of `ranked`), and with `q` it must match. A held worker never lists. */
  private overlayHeldArchived(ranked: Map<string, ArchivedKey>, q: string, automationNames: AutomationNames | undefined): void {
    for (const [id, run] of this.held) {
      if (!run.archived || run.delegation?.role === 'worker') continue;
      const summary = toRunSummary(run);
      if (q === '' || matchesRunSearch(summary, q, { automationNames })) ranked.set(id, { ...this.listOrder(run), summary });
    }
  }

  /** The page of `ordered` after the cursor `after`: its summaries, the cursor of the next page,
   *  and `total`, the count of all of `ordered`. */
  private archivedPage(ordered: Array<[string, ArchivedKey]>, after: ListOrder | undefined, limit: number): ArchivedRunsResponse {
    const rest = after ? ordered.filter(([, key]) => newestFirst(key, after) > 0) : ordered;
    const page = rest.slice(0, limit);
    const runs = this.hydrateArchivedPage(page);
    const last = page.at(-1)?.[1];
    return {
      runs,
      nextCursor: last && rest.length > page.length ? encodeArchivedCursor(last) : null,
      total: ordered.length,
    };
  }

  /** The page's summaries: a ranked key's own, else its stored one, read for the rows that have
   *  none in a single query. A row whose stored summary does not fit the contract is projected from
   *  its record; a row that cannot be read at all is left out. */
  private hydrateArchivedPage(page: Array<[string, ArchivedKey]>): RunSummary[] {
    const cold = new Map((this.db?.getSummaries(page.filter(([, key]) => !key.summary).map(([id]) => id)) ?? [])
      .map((row) => [row.id, parseStoredSummary(row.summary) ?? this.coldSummary(row.id)]));
    return page.flatMap(([id, key]) => {
      const summary = key.summary ?? cold.get(id);
      return summary ? [summary] : [];
    });
  }

  /**
   * The ROOT runs, archived or not, that match `query` (`matchesRunSearch`), newest first: at most
   * `limit`, and whether more matched. The owned half of the workspace search (#864); held runs
   * match by their record.
   */
  searchRunSummaries(query: string, limit: number): { runs: RunSummary[]; truncated: boolean } {
    const matched = new Map<string, readonly [RunSummary, ListOrder]>();
    // Rows come newest first, so the newest `limit + 1` row matches are all a page can use; held
    // runs, which may be newer than any row, are ranked in below.
    this.db?.visitRootSummaries(sqlPrefilterTokens(query), (row) => {
      if (this.deleted.has(row.id) || this.held.has(row.id) || this.unreadable.has(row.id)) return true;
      const summary = parseStoredSummary(row.summary) ?? this.coldSummary(row.id);
      if (summary && matchesRunSearch(summary, query)) matched.set(row.id, [summary, row]);
      return matched.size <= limit;
    });
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'worker') continue;
      const summary = toRunSummary(run);
      if (matchesRunSearch(summary, query)) matched.set(id, [summary, this.listOrder(run)]);
    }
    const runs = sortNewestFirst(matched.values());
    return { runs: runs.slice(0, limit), truncated: runs.length > limit };
  }

  /** A row whose stored summary does not fit the contract any more, projected from its record. */
  private coldSummary(id: string): RunSummary | undefined {
    const run = this.loadCold(id);
    return run ? toRunSummary(run) : undefined;
  }

  /**
   * The run, or undefined. A held run is the held object (writes install into it). Any other run
   * is a fresh copy of its row each call, normalized like a loaded record — frozen under vitest —
   * so changing it means a store method, never an assignment.
   */
  getRun(id: string): RunRecord | undefined {
    const held = this.held.get(id);
    if (held) return held;
    const run = this.loadCold(id);
    return run && this.answerCold(run, true);
  }

  /** Whether the run's row is in `runs.db` but its record could not be read here: what tells a
   *  run that cannot open from one that does not exist. Known once something tried to read it. */
  isUnreadable(id: string): boolean {
    return this.unreadable.has(id) && !this.held.has(id) && !this.deleted.has(id);
  }

  /** The ids in memory right now: the held set, for diagnostics and the benchmark's heap pass. */
  heldIds(): string[] {
    return [...this.held.keys()];
  }

  /**
   * The workers a root run owns, newest first, read off its own `receipts` (#659). Every
   * `createOwnedRun` writes the receipt and the worker record in one transaction, and the
   * receipt list is capped at 1,024 creations (#816), so this is a bounded lookup rather than a walk of the whole
   * project index. An ordinary or worker run owns nothing and costs one map read; a receipt
   * whose record has been deleted is skipped, never invented. A parent quarantined to
   * `invalid` has no readable receipts and reports none, which is also what the cockpit
   * assumes for that role.
   */
  listOwnedWorkers(parentId: string): RunRecord[] {
    const parent = this.getRun(parentId);
    if (parent?.delegation?.role !== 'root') return [];
    const workers: RunRecord[] = [];
    for (const receipt of parent.delegation.receipts) {
      const worker = this.getRun(receipt.workerId);
      if (worker?.delegation?.role === 'worker' && worker.delegation.parentRunId === parentId) workers.push(worker);
    }
    return workers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Every worker filed under `parentId` (the `parent_run_id` index plus memory), newest first:
   *  receipts or not, which is what the reconcile and deletion checks ask. */
  listWorkersOf(parentId: string): RunRecord[] {
    const workers = new Map<string, readonly [RunRecord, ListOrder]>();
    for (const run of this.held.values()) {
      if (run.delegation?.role === 'worker' && run.delegation.parentRunId === parentId) workers.set(run.id, [run, this.listOrder(run)]);
    }
    // Ids first: a live family's workers are usually all held, and then no record is read at all.
    const cold = (this.db?.listIdsByParent(parentId) ?? []).filter((id) => !this.held.has(id) && !this.deleted.has(id));
    for (const row of cold.length > 0 ? this.db!.getMany(cold) : []) {
      const run = this.fromRow(row);
      if (run?.delegation?.role === 'worker' && run.delegation.parentRunId === parentId) workers.set(row.id, [run, row]);
    }
    return sortNewestFirst(workers.values());
  }

  /** The id of every worker, held or stored, without decoding any (recovery's worker passes). */
  listWorkerIds(): string[] {
    const ids = new Set(this.db?.listWorkerIds() ?? []);
    for (const id of this.deleted) ids.delete(id);
    for (const run of this.held.values()) if (run.delegation?.role === 'worker') ids.add(run.id);
    return [...ids];
  }

  /** The id of every run whose delegation is quarantined (`invalid`), held or stored: its stored
   *  summary says so, so nothing is decoded (scratch cleanup). */
  listQuarantinedRunIds(): string[] {
    const ids = new Set((this.db?.listKeysWhere("json_extract(summary, '$.delegation.role') = 'invalid'") ?? []).map((key) => key.id));
    for (const id of this.deleted) ids.delete(id);
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'invalid') ids.add(id);
      else ids.delete(id);
    }
    return [...ids];
  }

  /** All retained tasks this automation started, including variants, finished and archived runs.
   * Logs and receipts may compact independently. Read only matching keys in SQLite and overlay
   * held records so a debounced provenance update or deletion is reflected immediately. */
  countAutomationRuns(automationId: string): number {
    const where = "json_extract(data, '$.automation.automationId') = ? OR " +
      "json_extract(data, '$.automationTrigger.automationId') = ?";
    const ids = new Set((this.db?.listKeysWhere(where, [automationId, automationId]) ?? [])
      .map((key) => key.id));
    for (const id of this.deleted) ids.delete(id);
    for (const [id, run] of this.held) {
      if (run.automation?.automationId === automationId || run.automationTrigger?.automationId === automationId) ids.add(id);
      else ids.delete(id);
    }
    return ids.size;
  }

  /** First non-archived task referencing a project issue, including secondary references. */
  findNonArchivedRunByIssue(repo: string, number: number): string | undefined {
    const url = `https://github.com/${repo}/issues/${number}`.toLowerCase();
    const matches = (run: RunRecord) => {
      if (run.archived) return false;
      const urls = [run.referencedIssueUrl, ...(run.referencedIssueCandidates ?? []),
        ...(run.automation?.event.startsWith('issue.') ? [run.automation.githubUrl] : []),
        ...[...run.task.matchAll(new RegExp(ISSUE_URL_RE.source, 'gi'))].map((match) => match[0])]
        .filter((value): value is string => value !== undefined)
        .map((value) => value.replace(/\/+$/, '').toLowerCase())
        .filter((value) => value.endsWith(`/issues/${number}`));
      // The legacy issueNumber is display-only and cannot establish repository identity.
      // Explicit task markers remain project-scoped unless a qualified URL contradicts them.
      return urls.includes(url) || (urls.length === 0 && run.markerRefs?.issue === number);
    };
    for (const run of this.held.values()) if (matches(run)) return run.id;
    // Secondary references are record-only: query them in SQLite rather than hydrating every
    // finished transcript or relying on the slim summary's primary issue number.
    const where = `archived = 0 AND (
      json_extract(data, '$.issueNumber') = ? OR json_extract(data, '$.markerRefs.issue') = ?
      OR lower(rtrim(json_extract(data, '$.referencedIssueUrl'), '/')) = ?
      OR EXISTS (SELECT 1 FROM json_each(data, '$.referencedIssueCandidates') WHERE lower(rtrim(value, '/')) = ?)
      OR (json_extract(data, '$.automation.event') LIKE 'issue.%' AND lower(rtrim(json_extract(data, '$.automation.githubUrl'), '/')) = ?)
      OR instr(lower(json_extract(data, '$.task')), ?) > 0
    )`;
    for (const key of this.db?.listKeysWhere(where, [number, number, url, url, url, url]) ?? []) {
      if (this.held.has(key.id) || this.deleted.has(key.id) || this.unreadable.has(key.id)) continue;
      const run = this.getRun(key.id);
      if (run && matches(run)) return key.id;
    }
    return undefined;
  }

  /**
   * The runs automation receipts launched, by receipt id (`automation.receiptId` or
   * `automationTrigger.receiptId`). Memory answers first; a receipt it does not know costs one
   * pass over `runs.db` that reads the records' JSON in SQLite — only a crash leftover (a
   * receipt still `reserved` at startup) ever asks.
   */
  findRunIdsByAutomationReceipt(receiptIds: readonly string[]): Map<string, string> {
    const wanted = new Set(receiptIds);
    const found = new Map<string, string>();
    const receiptOf = (run: RunRecord) => run.automation?.receiptId ?? run.automationTrigger?.receiptId;
    for (const run of this.held.values()) {
      const receipt = receiptOf(run);
      if (receipt !== undefined && wanted.has(receipt)) found.set(receipt, run.id);
    }
    const missing = [...wanted].filter((receipt) => !found.has(receipt));
    if (missing.length === 0 || !this.db) return found;
    const where = "json_extract(data, '$.automation.receiptId') IN (SELECT value FROM json_each(?))" +
      " OR json_extract(data, '$.automationTrigger.receiptId') IN (SELECT value FROM json_each(?))";
    for (const key of this.db.listKeysWhere(where, [JSON.stringify(missing), JSON.stringify(missing)])) {
      if (this.held.has(key.id) || this.deleted.has(key.id)) continue;
      const run = this.getRun(key.id);
      const receipt = run && receiptOf(run);
      if (receipt !== undefined && wanted.has(receipt) && !found.has(receipt)) found.set(receipt, key.id);
    }
    return found;
  }

  /** The id of every root whose delegation carries a conversation, held or stored: recovery's full
   *  reconcile pass (#661). Only roots' records are read, in SQLite. `naming` keeps the ledgers whose
   *  messages name that run id, filtered there too, so a deleted peer decodes no other root. */
  listConversationRootIds(naming?: string): string[] {
    const where = `json_extract(summary, '$.delegation.role') = 'root' AND json_extract(data, '$.delegation.conversation') IS NOT NULL${naming ? " AND instr(json_extract(data, '$.delegation.conversation.messages'), ?) > 0" : ''}`;
    const ids = new Set((this.db?.listKeysWhere(where, naming ? [naming] : []) ?? []).map((key) => key.id));
    for (const id of this.deleted) ids.delete(id);
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'root' && run.delegation.conversation && (!naming || run.delegation.conversation.messages.some(message => [message.senderRunId, message.recipientRunId].includes(naming)))) ids.add(id);
      else ids.delete(id);
    }
    return [...ids];
  }

  /** The id of every run, held or stored, without decoding any (orphan-worktree sweeps). */
  listRunIds(): string[] {
    const ids = new Set(this.db?.listIds() ?? []);
    for (const id of this.deleted) ids.delete(id);
    for (const id of this.held.keys()) ids.add(id);
    return [...ids];
  }

  /** Runs with a materialized worktree directory (`worktreePath`, not reclaimed), most recently
   *  finished first, then newest first: worktree retention and the worktrees panel. */
  listRunsWithWorktree(): RunRecord[] {
    const runs = this.queryRuns(this.db?.listWithWorktree() ?? [], (run) => run.worktreePath !== undefined && run.worktreeReclaimedAt === undefined);
    const recency = ([run]: readonly [RunRecord, ListOrder]) => run.finishedAt ?? run.createdAt;
    return runs.sort((a, b) => (recency(a) < recency(b) ? 1 : recency(a) > recency(b) ? -1 : newestFirst(a[1], b[1]))).map(([run]) => run);
  }

  /**
   * Every run that owns a branch or names the PR it created, as the few fields branch cleanup and
   * git-log attribution read (issue 08 §B3, §B5; a squash commit is attributed by its PR number):
   * the stored summary plus the `branch` and `base_branch` columns, so a Git-tab request decodes
   * no record. Held runs answer from memory.
   */
  listBranchOwners(): BranchOwner[] {
    const owners = new Map<string, BranchOwner>();
    for (const row of this.db?.listBranchOwners("branch IS NOT NULL OR json_extract(summary, '$.pullRequestUrl') IS NOT NULL") ?? []) {
      if (this.deleted.has(row.id) || this.held.has(row.id)) continue;
      const summary = parseStoredSummary(row.summary);
      owners.set(row.id, {
        id: row.id, createdAt: row.createdAt, status: row.status as RunStatus, archived: row.archived,
        ...(row.branch === null ? {} : { branch: row.branch }),
        ...(row.baseBranch === null ? {} : { baseBranch: row.baseBranch }),
        title: summary?.title ?? row.id,
        ...(summary?.pullRequestUrl === undefined ? {} : { pullRequestUrl: summary.pullRequestUrl }),
      });
    }
    for (const run of this.held.values()) {
      const owner = branchOwnerOf(run);
      if (owner) owners.set(run.id, owner);
    }
    return [...owners.values()];
  }

  /** The rows a column query returned, as records, with memory laid over them: a held run
   *  answers from memory (matching `matches` there, not on its maybe-older row). */
  private queryRuns(rows: readonly RunRow[], matches: (run: RunRecord) => boolean): Array<readonly [RunRecord, ListOrder]> {
    const runs = new Map<string, readonly [RunRecord, ListOrder]>();
    for (const run of this.held.values()) if (matches(run)) runs.set(run.id, [run, this.listOrder(run)]);
    for (const row of rows) {
      if (runs.has(row.id) || this.held.has(row.id) || this.deleted.has(row.id)) continue;
      const run = this.fromRow(row);
      if (run && matches(run)) runs.set(row.id, [run, row]);
    }
    return [...runs.values()];
  }

  /** The run an idempotent start already created (#504), archived or not. A deleted run is gone
   *  with its record, so a retry after deletion honestly creates a fresh one. */
  findRunByClientRequestId(clientRequestId: string): RunRecord | undefined {
    for (const run of this.held.values()) if (run.clientRequestId === clientRequestId) return run;
    const row = this.db?.findByClientRequestId(clientRequestId);
    if (!row || this.held.has(row.id)) return undefined;
    const run = this.getRun(row.id);
    return run?.clientRequestId === clientRequestId ? run : undefined;
  }

  createRun(input: {
    title: string;
    systemPrompt?: string | undefined;
    workflowDef?: z.infer<typeof workflowDefSchema>;
    workflow: string;
    task: string;
    model?: string | undefined;
    /** Reasoning-effort pin (#45). Absent = harness default. */
    effort?: string | undefined;
    runner?: RunnerId | undefined;
    /** Composer's per-task agent account (spec 2026-07-29-agent-profiles). */
    agentProfile?: string | undefined;
    autonomous?: boolean | undefined;
    archiveWhenDone?: boolean | undefined;
    autoMergePr?: boolean | undefined;
    /** Task webhook opt-in (#589), set at creation so the first transition is already covered. */
    notify?: boolean | undefined;
    worktree?: false | undefined;
    groupId?: string;
    variant?: string;
    clientRequestId?: string | undefined;
    clientRequestHash?: string | undefined;
    /** Automation provenance, committed with the row that creates the run (hearsay-tools/cezarion#1465):
     *  a crash before a later write must still let reconciliation find the receipt's task. */
    automation?: RunRecord['automation'];
    automationTrigger?: RunRecord['automationTrigger'];
    steps: Array<Pick<StepState, 'id' | 'name' | 'kind'>>;
  }): RunRecord {
    if (this.openFailure) throw this.openFailure;
    const run = this.buildRun(input, randomUUID());
    // A new family, so nobody else can hold it; claimed before anything (an NDJSON event) is written.
    if (this.db && !this.claimFamilies([run.id]).has(run.id)) throw new RunWriteRefusedError(run.id, 'foreign');
    this.held.set(run.id, run);
    this.pruneOldRuns();
    this.touch(run);
    return run;
  }

  /** Build without publishing: owned creation must commit its receipt and run together. */
  private buildRun(input: Parameters<RunStore['createRun']>[0], id: string): RunRecord {
    const run: RunRecord = {
      id,
      // Scrubbed on the way in, exactly as `updateRun` scrubs it on the way
      // through (#456 review) — a token pasted into the prompt otherwise sat
      // verbatim in `runs.json` from creation. `task` is deliberately NOT
      // scrubbed: it is the user's own prompt and is replayed into `{{task}}`
      // when a queued run is revived after a restart (#367), so redacting it
      // would corrupt the revived run.
      title: this.redactText(input.title),
      workflow: input.workflow,
      task: input.task,
      model: input.model,
      systemPrompt: input.systemPrompt,
      workflowDef: input.workflowDef === undefined ? undefined : workflowDefSchema.parse(input.workflowDef),
      effort: input.effort,
      runner: input.runner,
      agentProfile: input.agentProfile,
      autonomous: input.autonomous,
      archiveWhenDone: input.archiveWhenDone,
      autoMergePr: input.autoMergePr,
      ...(input.notify ? { notify: true } : {}),
      worktree: input.worktree,
      groupId: input.groupId,
      variant: input.variant,
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId, clientRequestHash: input.clientRequestHash }),
      ...(input.automation ? { automation: input.automation } : {}),
      ...(input.automationTrigger ? { automationTrigger: input.automationTrigger } : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
      tokensUsed: 0,
      archived: false,
      steps: input.steps.map((s) => ({
        ...s,
        status: 'pending',
        iterations: 0,
        tokensUsed: 0,
      })),
    };
    // A prompt that pastes a PR or issue URL is already about that item — seed
    // both referenced tiers so queued runs can expose the reference before the
    // first agent event (#407, #554).
    this.trackReferencedPrs(run, input.task);
    this.trackReferencedIssues(run, input.task);
    return run;
  }

  /** Accept the family ledger and its recipient queue in a single durable index replacement. A new
   *  message (`message`, or the delivered input) whose ID is in use writes nothing; `recipientDelegation`
   *  makes a peer recipient with no delegation record a root task in the same write. */
  commitConversation(rootId: string, conversation: ConversationState, delivery?: { recipientRunId: string; input: AgentInput; recipientDelegation?: DelegationState },
    message?: ConversationIdentity): void {
    const root = this.peek(rootId);
    if (root?.delegation?.role !== 'root') throw new Error('missing conversation root');
    assertConversationIdFree(root, message ?? delivery?.input, id => this.peek(id), (runId, id) => this.hasProjection(runId, id));
    const staged = new Map<string, RunRecord>();
    staged.set(rootId, { ...root, delegation: delegationStateSchema.parse({ ...root.delegation, conversation: { ...conversation,
      messages: conversation.messages.map(message => ({ ...message, text: this.redactText(message.text) })),
    } }) });
    if (delivery) {
      const recipient = staged.get(delivery.recipientRunId) ?? this.peek(delivery.recipientRunId);
      if (!recipient) throw new Error('missing conversation recipient');
      const input = agentInputSchema.parse({ ...delivery.input, text: this.redactText(delivery.input.text) });
      const delegation = !recipient.delegation && delivery.recipientDelegation ? { delegation: delegationStateSchema.parse(delivery.recipientDelegation) } : {};
      staged.set(recipient.id, { ...recipient, ...delegation, agentInputs: [...(recipient.agentInputs ?? []), input] });
    }
    this.commitIndex(staged);
  }

  /** Crash recovery (#505): input a harness accepted but was never seen reading goes
   * back to the queue. Returns the requeued IDs. */
  requeueAwaitingReadInputs(id: string): string[] {
    const ids = (this.peek(id)?.agentInputs ?? []).filter(input => input.awaitingRead && input.deliveredAt && !input.consumedAt).map(input => input.id);
    if (ids.length) this.commitOutcome(id, { kind: 'requeued', inputIds: ids });
    return ids;
  }

  /** Delivered, but the harness never confirmed reading it (#505): stop awaiting a read. */
  commitAgentInputsUnconfirmed(id: string, ids: readonly string[]): void {
    const run = this.peek(id);
    if (!run?.agentInputs || !ids.length) return;
    this.commitAgentInputs(id, run.agentInputs.map(input => {
      if (!ids.includes(input.id) || !input.awaitingRead) return input;
      const { awaitingRead: _awaiting, ...unconfirmed } = input;
      return unconfirmed;
    }));
  }

  /** Observable atomic input checkpoint for the queue itself: enqueue, retire, reorder. Delivery
   *  and reads are outcomes (`commitOutcome`). */
  commitAgentInputs(id: string, inputs: readonly AgentInput[]): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing agent input target');
    const agentInputs = inputs.map(input => agentInputSchema.parse(input));
    // Receipts are outcomes (hearsay-tools/cezarion#1805): only `commitOutcome` writes them.
    const stored = new Map((run.agentInputs ?? []).map(input => [input.id, input]));
    if (agentInputs.some(input => input.deliveredAt !== stored.get(input.id)?.deliveredAt || input.consumedAt !== stored.get(input.id)?.consumedAt)) {
      throw new Error('agent input receipts change only through commitOutcome');
    }
    const now = new Date().toISOString();
    for (const input of run.agentInputs ?? []) {
      const claim = input.inboxClaim;
      if (!claim || claim.acknowledgedAt || claim.expiresAt <= now) continue;
      const matching = agentInputs.filter(next => next.id === input.id);
      if (matching.length !== 1 || !isDeepStrictEqual(matching[0]!.inboxClaim, claim)) {
        throw new Error('live inbox receipt changed');
      }
    }
    this.commitIndex(new Map([[id, { ...run, agentInputs }]]));
  }

  /** Reserve only unread conversation inputs in one durable index replacement. */
  claimInboxInputs(runId: string, ids: readonly string[], claim: InboxClaim): void {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    const selected = z.array(z.uuid()).min(1).max(32).refine(values => new Set(values).size === values.length).parse(ids);
    const receipt = inboxClaimSchema.parse({ ...claim, memberIds: selected });
    if (receipt.acknowledgedAt || receipt.expiresAt <= new Date().toISOString()) throw new Error('inbox claim is not live');
    const inputs = run.agentInputs ?? [];
    if (inputs.some(input => input.inboxClaim?.receiptId === receipt.receiptId)) throw new Error('inbox receipt already exists');
    for (const id of selected) {
      const matching = inputs.filter(input => input.id === id);
      if (matching.length !== 1 || matching[0]?.source !== 'agent' || !matching[0].conversation ||
        matching[0].deliveredAt || (matching[0].inboxClaim && matching[0].inboxClaim.expiresAt > new Date().toISOString())) {
        throw new Error('inbox input is not available');
      }
    }
    const selectedIds = new Set(selected);
    this.commitIndex(new Map([[runId, { ...run, agentInputs: inputs.map(input => selectedIds.has(input.id)
      ? agentInputSchema.parse({ ...input, inboxClaim: receipt }) : input) }]]));
  }

  /** A receipt owns every matching input or none; exact ACK retries preserve the first timestamp. */
  ackInboxInputs(runId: string, receiptId: string, generation: string, at: string): 'acknowledged' | 'already-acknowledged' {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.receiptId.parse(receiptId);
    inboxClaimSchema.shape.generation.parse(generation);
    inboxClaimSchema.shape.expiresAt.parse(at);
    const matching = (run.agentInputs ?? []).filter(input => input.inboxClaim?.receiptId === receiptId);
    const receipt = matching[0]?.inboxClaim;
    const memberIds = receipt?.memberIds;
    if (!memberIds || matching.length !== memberIds.length ||
      !memberIds.every(id => matching.some(input => input.id === id)) ||
      matching.some(input => !isDeepStrictEqual(input.inboxClaim, receipt)) ||
      matching.some(input => input.inboxClaim?.generation !== generation ||
      input.source !== 'agent' || !input.conversation)) throw new Error('inbox receipt changed');
    if (matching.every(input => input.inboxClaim?.acknowledgedAt && input.deliveredAt === input.inboxClaim.acknowledgedAt)) {
      return 'already-acknowledged';
    }
    if (matching.some(input => input.deliveredAt || input.inboxClaim?.acknowledgedAt || input.inboxClaim!.expiresAt <= at)) {
      throw new Error('inbox receipt expired or displaced');
    }
    this.commitOutcome(runId, { kind: 'inbox-acknowledged', receiptId, at });
    return 'acknowledged';
  }

  releaseInboxInputs(runId: string, receiptId: string, generation: string): 'released' {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.receiptId.parse(receiptId);
    inboxClaimSchema.shape.generation.parse(generation);
    const matching = (run.agentInputs ?? []).filter(input => input.inboxClaim?.receiptId === receiptId);
    if (!matching.length || matching.some(input => input.inboxClaim?.generation !== generation ||
      input.inboxClaim?.acknowledgedAt || input.deliveredAt)) throw new Error('inbox receipt changed');
    this.commitIndex(new Map([[runId, { ...run, agentInputs: run.agentInputs!.map(input => {
      if (input.inboxClaim?.receiptId !== receiptId) return input;
      const { inboxClaim: _claim, ...unclaimed } = input;
      return agentInputSchema.parse(unclaimed);
    }) }]]));
    return 'released';
  }

  clearExpiredInboxClaims(runId: string, now: string): void {
    const run = this.peek(runId);
    if (!run) throw new Error('missing inbox recipient');
    inboxClaimSchema.shape.expiresAt.parse(now);
    if (!run.agentInputs?.some(input => input.inboxClaim && !input.inboxClaim.acknowledgedAt && input.inboxClaim.expiresAt <= now)) return;
    this.commitIndex(new Map([[runId, { ...run, agentInputs: run.agentInputs.map(input => {
      if (!input.inboxClaim || input.inboxClaim.acknowledgedAt || input.inboxClaim.expiresAt > now) return input;
      const { inboxClaim: _claim, ...unclaimed } = input;
      return agentInputSchema.parse(unclaimed);
    }) }]]));
  }

  /**
   * A wait and its wake input share one atomic index replacement (spec 2026-10-17-unified-waits).
   * Upserts `wait` by id into `waits` and clears `lastWaitsError`; `input` is appended once (an
   * input whose id is already queued stays as it is). Only an open or resolved wait is committed
   * here: settling is an outcome (`commitOutcome`). A new open wait
   * past `WAIT_LIMIT` open ones is refused, so the list stays bounded whatever the caller checked.
   */
  commitWait(id: string, wait: Wait, input?: AgentInput): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing wait target');
    const entry = waitSchema.parse(wait);
    if (entry.phase !== 'open' && entry.phase !== 'resolved') throw new Error('a settled wait is committed through its delivery or cancellation');
    const waits = run.waits ?? [];
    const known = waits.some((row) => row.id === entry.id);
    if (!known && entry.phase === 'open' && waits.filter((row) => row.phase === 'open').length >= WAIT_LIMIT) {
      throw new Error(`open wait limit reached (${WAIT_LIMIT})`);
    }
    const agentInput = input ? agentInputSchema.parse(input) : undefined;
    this.commitIndex(new Map([[id, { ...run, waits: known ? waits.map((row) => row.id === entry.id ? entry : row) : [...waits, entry], lastWaitsError: undefined,
      ...(agentInput ? { agentInputs: run.agentInputs?.some((row) => row.id === agentInput.id)
        ? run.agentInputs : [...(run.agentInputs ?? []), agentInput] } : {}) }]]));
  }

  /** A park that gives up its slot (hearsay-tools/cezarion#1235): the run and its step read
   *  `waiting`, committed at once instead of on the debounced save, so a refused write throws with
   *  nothing changed and the caller keeps the slot. */
  commitParked(id: string, stepId?: string): void {
    const run = this.peek(id);
    if (!run) return;
    this.commitIndex(new Map([[id, { ...run, status: 'waiting', activity: undefined,
      ...(stepId ? { steps: run.steps.map((step) => step.id === stepId ? { ...step, status: 'waiting' as const } : step) } : {}) }]]));
  }

  /** A usage-limit appointment withdrawn, committed at once instead of on the debounced save
   *  (hearsay-tools/cezarion#1236): a crash right after the withdrawal must not find it on disk,
   *  or recovery re-arms work the user cancelled. A run held for its resume settles `failed`. */
  commitAutoResumeWithdrawal(id: string): void {
    const run = this.peek(id);
    if (!run || (run.autoResumeAt === undefined && run.autoResumeAttempts === undefined)) return;
    const held = isUsageLimitHold(run);
    this.commitIndex(new Map([[id, { ...run, autoResumeAt: undefined, autoResumeAttempts: undefined,
      ...(held ? { status: 'failed' as const, finishedAt: new Date().toISOString() } : {}) }]]));
  }

  /** Legacy CI checkpoint over `commitWait`, kept until its callers move (unified waits, Task 4). */
  commitCiWait(id: string, wait: CiWait, input?: AgentInput): void {
    this.commitWait(id, ciWaitEntry(ciWaitSchema.parse(wait)), input);
  }

  /** A human message beside a run's waits (hearsay-tools/cezarion#1235): accepted durably, and
   *  every wait stays. A lifecycle opening becomes
   *  the human's and keeps its wake text, so the message opens the continuation (and answers a
   *  pending question) and the owed results still reach the agent. */
  commitHumanMessageBesideWaits(id: string, acceptedHumanMessage: QueuedMessage): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing queued message target');
    this.commitIndex(new Map([[id, { ...run, queuedMessages: [...(run.queuedMessages ?? []), queuedMessageSchema.parse(acceptedHumanMessage)],
      ...(run.continuationMessage ? { continuationMessage: { ...run.continuationMessage, origin: 'human' as const } } : {}),
    }]]));
  }

  /**
   * The one write of a run outcome (hearsay-tools/cezarion#1805): an input or wait delivered, a wake
   * charged, a wait settled, a question answered, staged by `applyOutcomes` with what it depends on
   * (`deps`) and committed in one transaction, with every pending row. A crash keeps all of it or
   * none. Nothing changes: nothing is written. Needs no live session: it reads the stored record.
   *
   * A refused write throws with nothing changed. `bestEffort` is for a cleanup path, which must
   * never stop on it: it warns and applies the change in memory for the debounced save to retry.
   * A conversation request outcome is the other sanctioned write: `commitConversation`.
   */
  commitOutcome(id: string, outcomes: RunOutcome | readonly RunOutcome[], deps: OutcomeDependencies = {}, opts: { bestEffort?: boolean } = {}): { committed: boolean; answered: string[] } {
    const run = this.peek(id);
    if (!run) return { committed: false, answered: [] };
    const staged = applyOutcomes(run, Array.isArray(outcomes) ? outcomes : [outcomes as RunOutcome], deps);
    if (!staged.changed) return { committed: false, answered: [] };
    try { this.commitIndex(new Map([[id, staged.next]])); }
    catch (error) {
      if (!opts.bestEffort) throw error;
      console.warn(`[cez] outcome checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      const live = this.record(id);
      if (!live) return { committed: false, answered: staged.answered };
      for (const key of Object.keys(live) as Array<keyof RunRecord>) if (!(key in staged.next)) delete live[key];
      Object.assign(live, staged.next);
      this.touch(live);
      return { committed: false, answered: staged.answered };
    }
    return { committed: true, answered: staged.answered };
  }

  /** An acknowledged inactive-root Finish must survive the async diff and restart. */
  commitRootFinishIntent(id: string): void {
    const run = this.peek(id);
    if (run?.status !== 'waiting' || run.delegation?.role !== 'root') throw new Error('root is not waiting');
    if (run.delegation.finishRequestedAt) return;
    this.commitDelegation([{ id, delegation: { ...run.delegation, finishRequestedAt: new Date().toISOString() } }]);
  }

  /** Cancellation supersedes pending Finish in one durable checkpoint. Also
   * repairs cancelled-plus-intent snapshots left by older controllers. */
  commitRootFinishCancellation(id: string): boolean {
    const run = this.peek(id);
    if (run?.delegation?.role !== 'root' || !run.delegation.finishRequestedAt ||
      !['waiting', 'cancelled'].includes(run.status)) return false;
    const { finishRequestedAt: _intent, ...delegation } = run.delegation;
    this.commitIndex(new Map([[id, { ...run, delegation, status: 'cancelled' as const, finishedAt: run.finishedAt ?? new Date().toISOString() }]]));
    return true;
  }

  /** Publish terminal success and completed steps only after their atomic checkpoint.
   * A concurrent explicit cancellation is never overwritten by the async diff. */
  commitRootFinishSuccess(id: string, status: 'done' | 'review'): boolean {
    const run = this.peek(id);
    if (run?.status !== 'waiting' || run.delegation?.role !== 'root' || !run.delegation.finishRequestedAt) return false;
    const { finishRequestedAt: _intent, ...delegation } = run.delegation;
    const finishedAt = new Date().toISOString();
    this.commitIndex(new Map([[id, { ...run, delegation, status, finishedAt, currentStepId: undefined, autoResumeAttempts: undefined,
      activity: undefined,
      steps: run.steps.map(step => step.status === 'waiting' || step.status === 'running'
        ? { ...step, status: 'done' as const, finishedAt: step.finishedAt ?? finishedAt } : step),
    }]]));
    return true;
  }

  /** Persist all authority patches before exposing any of them to the engine or subscribers. */
  commitDelegation(patches: ReadonlyArray<{ id: string; delegation: DelegationState }>): void {
    if (patches.length === 0) return;
    const staged = new Map<string, RunRecord>();
    let destroyProgress = true;
    for (const patch of patches) {
      const run = this.peek(patch.id);
      if (!run || staged.has(patch.id)) throw new Error('missing or duplicate delegation patch target');
      const delegation = delegationStateSchema.parse(patch.delegation);
      if (!isDestroyProgress(run.delegation, delegation)) destroyProgress = false;
      staged.set(patch.id, { ...run, delegation });
    }
    // In-process cause only: consumers can skip metadata replay when delegation
    // is disabled without dropping real status or termination-proof notifications.
    this.commitIndex(staged, destroyProgress ? 'delegation-destroy-progress' : 'delegation-checkpoint');
  }

  /** A pending destroy's automatic retry state, or its removal (hearsay-tools/cezarion#879). Kept on
   * the record beside the strict delegation, so an older cezar strips it rather than quarantining the
   * worker. Destroy progress: nothing the family reconcile reads changes. */
  commitDestroyRetry(id: string, retry: WorkerDestroyRetry | undefined): void {
    const run = this.peek(id);
    if (run?.delegation?.role !== 'worker' || !run.delegation.destroy) throw new Error('missing pending destroy');
    if (!retry && !run.destroyRetry) return;
    // An explicit `undefined`, not an omitted key: commitIndex assigns onto the live record.
    this.commitIndex(new Map([[id, { ...run, destroyRetry: retry ? workerDestroyRetrySchema.parse(retry) : undefined }]]), 'delegation-destroy-progress');
  }

  /** Accepted execution revision is public lifecycle identity, separate from process generations. */
  commitWorkerContinuation(id: string, patch: Partial<Omit<RunRecord, 'id' | 'steps' | 'delegation'>>, step?: Pick<StepState, 'id' | 'name' | 'kind' | 'synthetic'>,
    conversation?: { rootId: string; state: ConversationState; input: AgentInput }): void {
    const run = this.peek(id);
    if (run?.delegation?.role !== 'worker') throw new Error('missing worker continuation target');
    const delegation = delegationStateSchema.parse({ ...run.delegation,
      executionRevision: (run.delegation.executionRevision ?? 0) + 1,
      executionStartSeq: this.transcriptFacts(id).lastSeq,
    });
    const staged = new Map<string, RunRecord>();
    const next: RunRecord = { ...run, ...this.redactPatch(patch), delegation,
      ...(step ? { steps: [...run.steps, { ...step, status: 'pending' as const, iterations: 0, tokensUsed: 0 }] } : {}),
    };
    staged.set(id, next);
    if (Object.prototype.hasOwnProperty.call(patch, 'archived')) this.syncTranscriptForm(id, next.archived);
    if (conversation) {
      const root = this.peek(conversation.rootId);
      if (root?.delegation?.role !== 'root' || run.delegation.parentRunId !== root.id) throw new Error('missing conversation ownership');
      staged.set(root.id, { ...root, delegation: delegationStateSchema.parse({ ...root.delegation, conversation: { ...conversation.state,
        messages: conversation.state.messages.map(message => ({ ...message, text: this.redactText(message.text) })),
      } }) });
      const input = agentInputSchema.parse({ ...conversation.input, text: this.redactText(conversation.input.text) });
      staged.set(id, { ...staged.get(id)!, agentInputs: [...(run.agentInputs ?? []), input] });
    }
    this.commitIndex(staged);
  }

  private workerResultsDir(parentId: string): string {
    z.uuid().parse(parentId);
    const dir = join(this.dataDir, 'runs', `${parentId}-worker-results`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (realpathSync(dir) !== resolve(dir) || !lstatSync(dir).isDirectory()) throw new Error('worker result storage redirected');
    return dir;
  }

  workerResultSnapshotPath(parentId: string, workerId: string, snapshotId: string): string {
    return join(this.dataDir, 'runs', `${z.uuid().parse(parentId)}-worker-results`, `${z.uuid().parse(workerId)}.${z.uuid().parse(snapshotId)}.json`);
  }

  private readWorkerResultFile(parentId: string, workerId: string): z.infer<typeof workerResultFileSchema> | undefined {
    const parent = this.peek(parentId);
    if (parent?.delegation?.role !== 'root' || !parent.delegation.receipts.some(receipt => receipt.workerId === workerId)) return undefined;
    const reference = parent.delegation.results?.find(result => result.workerId === workerId);
    if (!reference) return undefined;
    try {
      const path = join(this.workerResultsDir(parentId), `${z.uuid().parse(workerId)}.${z.uuid().parse(reference.snapshotId)}.json`);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: string;
      try { const info = fstatSync(fd); if (!info.isFile() || info.size > 3_145_728) return undefined; raw = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
      const file = workerResultFileSchema.parse(JSON.parse(raw));
      if (file.result.diff.state === 'available' && file.result.diff.path !== path) return undefined;
      if (file.result.parentRunId !== parentId || file.result.workerId !== workerId || file.result.workspace.ownerRunId !== workerId || file.result.revision !== reference.revision || file.result.observedAt !== reference.observedAt ||
        (file.result.diff.state === 'available' && (file.result.diff.snapshotId !== reference.snapshotId || file.diffSnapshot === undefined))) return undefined;
      return file;
    } catch { return undefined; }
  }

  readWorkerResult(parentId: string, workerId: string): WorkerCollectedResult | undefined {
    return this.readWorkerResultFile(parentId, workerId)?.result;
  }
  readWorkerResultDiff(parentId: string, workerId: string): string | undefined {
    return this.readWorkerResultFile(parentId, workerId)?.diffSnapshot;
  }

  /** Publish a pointer only after its redacted immutable snapshot reaches disk. Failed index writes retain the old evidence.
   * A result whose evidence is already stored returns the stored one and writes nothing; `ignoreCleanup` is for a
   * caller that only needs the payload durable, whatever cleanup phase the stored copy names. */
  commitWorkerResult(parentId: string, value: WorkerCollectedResult, diffSnapshot?: string, opts: { ignoreCleanup?: boolean } = {}): WorkerCollectedResult {
    const result = workerCollectedResultSchema.parse(this.redact({ type: 'worker-result', seq: 0, ts: value.observedAt, result: value }).result);
    const parent = this.peek(parentId);
    const worker = this.peek(result.workerId);
    if (parent?.delegation?.role !== 'root' || result.parentRunId !== parentId ||
      !parent.delegation.receipts.some(receipt => receipt.workerId === result.workerId)) throw new Error('missing result ownership');
    if (worker && (worker.delegation?.role !== 'worker' || worker.delegation.parentRunId !== parentId ||
      worker.delegation.workspace.ownerRunId !== worker.id || (worker.delegation.executionRevision ?? 0) !== result.revision || worker.status !== result.status)) throw new Error('worker result revision changed');
    const old = parent.delegation.results?.find(entry => entry.workerId === result.workerId);
    const stored = old && this.readWorkerResultFile(parentId, result.workerId);
    if (stored && sameWorkerResult(stored.result, result, opts) &&
      stored.diffSnapshot === (diffSnapshot === undefined ? undefined : this.redactText(diffSnapshot))) return stored.result;
    if ((!worker && !this.readWorkerResult(parentId, result.workerId)) || (old && (old.revision > result.revision || (old.revision === result.revision && old.observedAt > result.observedAt)))) throw new Error('worker result is obsolete');
    const snapshotId = result.diff.state === 'available' ? result.diff.snapshotId : randomUUID();
    if (result.diff.state === 'available') result.diff.path = this.workerResultSnapshotPath(parentId, result.workerId, snapshotId);
    if (result.diff.state === 'available' && diffSnapshot === undefined) throw new Error('missing diff snapshot');
    const file = workerResultFileSchema.parse({ result, ...(diffSnapshot === undefined ? {} : { diffSnapshot: this.redactText(diffSnapshot) }) });
    const dir = this.workerResultsDir(parentId);
    const path = join(dir, `${result.workerId}.${snapshotId}.json`);
    if (existsSync(path)) throw new Error('worker result snapshot identity already exists');
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(file)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const reference = { workerId: result.workerId, revision: result.revision, observedAt: result.observedAt, snapshotId,
        lastExecutionOutcome: result.lastExecutionOutcome,
        ...(old ? { previous: old.revision === result.revision ? old.previous : { revision: old.revision, observedAt: old.observedAt, lastExecutionOutcome: old.lastExecutionOutcome } } : {}),
      };
      this.commitDelegation([{ id: parentId, delegation: { ...parent.delegation,
        results: [...(parent.delegation.results ?? []).filter(entry => entry.workerId !== result.workerId), reference],
      } }]);
    } catch (error) { rmSync(temp, { force: true }); if (old?.snapshotId !== snapshotId) rmSync(path, { force: true }); throw error; }
    // Keep the latest payload only; bounded previous outcome metadata lives in the pointer.
    for (const name of readdirSync(dir)) if (name.startsWith(`${result.workerId}.`) && name !== `${result.workerId}.${snapshotId}.json`) {
      try { rmSync(join(dir, name), { force: true }); } catch { /* retry on next collection */ }
    }
    return result;
  }

  /**
   * requestHash is supplied only by the trusted service: hash the ORIGINAL normalized request,
   * before resolving refs. A retry keeps the original worker and pinned SHA even if HEAD moved.
   * workspace.ownerRunId is the trusted service's preallocated worker UUID.
   */
  createOwnedRun(
    input: Parameters<RunStore['createRun']>[0],
    parentId: string,
    requestId: string,
    worker: DelegationState,
    requestHash: string,
    executionIdentity: WorkerExecutionIdentity = { kind: 'internal' },
  ): RunRecord {
    const parent = this.peek(parentId);
    const authority = delegationStateSchema.safeParse(parent?.delegation);
    if (!parent || !authority.success || authority.data.role !== 'root' || authority.data.historyDeletion) {
      throw new Error('invalid delegation parent');
    }
    // Validate retry identity independently of the newly proposed resource.
    const identity = workerCreationReceiptSchema.pick({ requestId: true, requestHash: true })
      .parse({ requestId, requestHash });
    const receipt = authority.data.receipts.find(entry => entry.requestId === identity.requestId);
    if (receipt) {
      if (receipt.requestHash !== identity.requestHash) throw new Error('request ID payload conflict');
      const existing = this.peek(receipt.workerId);
      const metadata = delegationStateSchema.safeParse(existing?.delegation);
      if (!existing || !metadata.success || metadata.data.role !== 'worker' ||
        metadata.data.parentRunId !== parentId || metadata.data.workspace.ownerRunId !== existing.id ||
        existing.id === parentId) throw new Error('invalid request receipt ownership');
      return existing;
    }
    // #816: the same check the spawn policy makes, inside the receipt transaction, so no path
    // writes a receipt past either limit.
    const refusal = capacityError(workerCapacity(parent, id => this.peek(id)));
    if (refusal) throw new Error(refusal);
    const metadata = delegationStateSchema.parse(worker);
    if (metadata.role !== 'worker' || metadata.parentRunId !== parentId ||
      metadata.workspace.ownerRunId === parentId || input.worktree === false) {
      throw new Error('invalid worker ownership');
    }
    const workspace = metadata.workspace;
    if (this.hasRun(workspace.ownerRunId)) throw new Error('worker run ID collision');
    for (const run of this.held.values()) {
      const owned = run.delegation?.role === 'worker' ? run.delegation.workspace : undefined;
      if ((owned && (owned.resourceId === workspace.resourceId || owned.path === workspace.path ||
        owned.branch === workspace.branch)) || run.worktreePath === workspace.path || run.branch === workspace.branch) {
        throw new Error('worker resource ownership collision');
      }
    }
    // Runs not in memory answer through the branch and worktree columns. A worker's planned
    // branch is its `branch` column; its path and resource id derive from its own run id, which
    // the id check above already proved unused.
    if ((this.db?.findResourceHolders({ branch: workspace.branch, worktreePath: workspace.path }) ?? [])
      .some((id) => !this.held.has(id) && !this.deleted.has(id))) throw new Error('worker resource ownership collision');
    const delegation = delegationStateSchema.parse({
      ...authority.data,
      receipts: [...authority.data.receipts, { ...identity, workerId: workspace.ownerRunId }],
    });
    const run = { ...this.buildRun(input, workspace.ownerRunId), delegation: metadata };
    // This transaction precedes materialization. Every launch must rotate this
    // generation to starting before touching the workspace or a session.
    this.writeWorkerIdentity(run.id, workerExecutionIdentitySchema.parse(executionIdentity));
    this.writeWorkerExecution(run.id, { generation: randomUUID(), phase: 'queued' }, true);
    // No pruning here: deleting run history cannot be part of a proposed index transaction.
    this.commitIndex(new Map([[parentId, { ...parent, delegation }], [run.id, run]]));
    return run;
  }

  /**
   * Durably replace or delete staged rows together with pending dirty rows. Persist before
   * changing held objects or notifying subscribers. On failure retain all pending state; flush()
   * remains best-effort.
   */
  private commitIndex(input: ReadonlyMap<string, RunRecord | null>, source?: CommitSource): void {
    const staged = this.prepareCompletionActions(withoutStaleResumes(input));
    if (!this.db) throw this.openFailure ?? new Error('runs database unavailable: nothing can be saved');
    this.assertWritable(staged);
    this.persist(staged);
    // Preserve existing record references, but expose the entire transaction before its first event.
    // A finished run joins the held set for the commit and leaves at the next sweep.
    for (const [id, next] of staged) {
      if (!next) { this.held.delete(id); continue; }
      this.committing.add(id);
      const current = this.held.get(id);
      if (current) {
        for (const key of Object.keys(current) as Array<keyof RunRecord>) {
          if (!(key in next)) delete current[key];
        }
        Object.assign(current, next);
      }
      else this.held.set(id, next);
    }
    try {
      for (const id of staged.keys()) {
        const run = this.held.get(id);
        if (run) this.emit('run', run, source); else this.emit('deleted', id);
      }
    } finally {
      for (const id of staged.keys()) this.committing.delete(id);
      this.sweepIfSettled(staged.keys());
    }
    for (const [id, next] of staged) if (next?.archived) this.compressor.enqueue(id);
  }

  /** Completion and its intent/archive share the same committed rows, including root Finish. */
  private prepareCompletionActions(input: ReadonlyMap<string, RunRecord | null>): Map<string, RunRecord | null> {
    const staged = new Map(input);
    for (const [id, candidate] of input) {
      if (!candidate) continue;
      const previous = this.peek(id);
      let next = candidate;
      const changed = candidate.status === 'done' && !candidate.archived && (
        previous?.status !== 'done' ||
        Boolean(previous.archiveWhenDone) !== Boolean(candidate.archiveWhenDone) ||
        Boolean(previous.autoMergePr) !== Boolean(candidate.autoMergePr));
      if (changed && (candidate.archiveWhenDone || candidate.autoMergePr)) {
        next = { ...candidate, completionAction: { id: randomUUID(), phase: 'pending' } };
        staged.set(id, next);
        if (next.archiveWhenDone && !next.autoMergePr) {
          const blocker = this.completionArchiveBlocker(next);
          next.completionAction = { ...next.completionAction!, phase: blocker ? 'blocked' : 'complete', ...(blocker ? { message: blocker } : {}) };
          if (!blocker) this.stageArchive(staged, next, true);
        }
      } else if (candidate.status !== 'done' || (!candidate.archiveWhenDone && !candidate.autoMergePr)) {
        if (candidate.completionAction) staged.set(id, { ...candidate, completionAction: undefined });
      }
    }
    return staged;
  }

  private completionArchiveBlocker(root: RunRecord): string | undefined {
    const family = [root, ...this.listWorkersOf(root.id)];
    for (const run of family) {
      const facts = this.facts.peek(run.id);
      if (!facts || !['done', 'review', 'failed', 'cancelled'].includes(run.status) || run.waits?.some(wait => wait.phase === 'open') ||
        run.hasPendingPermission || facts.pendingAsk !== undefined)
        return 'Task or worker work still needs attention. Open the task or archive manually.';
      if (run.delegation?.role === 'invalid' || (run.delegation?.role === 'worker' && this.readWorkerExecution(run.id)?.phase !== 'complete'))
        return 'Worker execution has not settled. Open the worker or archive manually.';
    }
    return undefined;
  }

  /** One archive write for manual actions, merge observations, completion, and sweeps.
   * Archiving files history away; it never stops a process or removes a worktree. */
  private stageArchive(staged: Map<string, RunRecord | null>, root: RunRecord, archived: boolean): void {
    const ids = root.delegation?.role === 'worker' ? [root.id] :
      [root.id, ...new Set([...(this.db?.listIdsByParent(root.id) ?? []), ...this.listWorkersOf(root.id).map(run => run.id)])];
    const now = new Date().toISOString();
    for (const id of ids) {
      const member = staged.get(id) ?? this.peek(id);
      if (!member) continue;
      if (!archived) { this.compressor.cancel(id); restoreHistory(this.dataDir, id); }
      const next = { ...member, archiveBlocker: undefined };
      archiveFields(next, archived, now);
      staged.set(id, next);
    }
  }

  /** A bounded persisted queue also covers projects without a live RunManager. */
  listCompletionCandidates(afterSeq = 0, limit = 32): Array<{ id: string; seq: number }> {
    return this.db?.listCompletionCandidates(afterSeq, limit) ?? [];
  }

  canCompleteAction(id: string, token: string): boolean {
    const run = this.record(id);
    return Boolean(run && run.status === 'done' && !run.archived && (run.autoMergePr || run.archiveWhenDone) &&
      run.completionAction?.id === token && run.completionAction.phase !== 'complete' && !this.writeRefusal(id));
  }

  claimCompletionAction(id: string, token: string): boolean {
    if (!this.canCompleteAction(id, token)) return false;
    const run = this.record(id)!;
    this.assertWritable(new Map([[id, run]]));
    // A normal write may defer its claim until the transaction. A remote mutation
    // needs the committed claim now, and must not act on a stale row read before it.
    const claim = this.db?.getClaim(familyKey(run));
    return Boolean(claim && claim.session === this.owner?.session &&
      claim.generation === this.claimed.get(familyKey(run)) &&
      this.db?.get(id)?.revision === this.base.get(id)?.revision);
  }

  completeAction(id: string, token: string, phase: 'blocked' | 'complete', message?: string): boolean {
    const run = this.record(id);
    if (!run || !this.canCompleteAction(id, token)) return false;
    if (run.completionAction?.phase === phase && run.completionAction.message === message) return true;
    const next: RunRecord = { ...run, completionAction: { id: token, phase, ...(message ? { message } : {}) } };
    const staged = new Map<string, RunRecord | null>([[id, next]]);
    if (phase === 'complete' && next.archiveWhenDone) {
      const blocker = this.completionArchiveBlocker(next);
      if (blocker) next.completionAction = { id: token, phase: 'blocked', message: blocker };
      else this.stageArchive(staged, next, true);
    }
    this.commitIndex(staged);
    return true;
  }

  /**
   * Refuse (throwing, with nothing changed) a commit that stages a quarantined run, or a run whose
   * family this store does not claim and cannot take: another process owns it, or a dead process
   * left it live and it has not been adopted.
   */
  private assertWritable(staged: ReadonlyMap<string, RunRecord | null>): void {
    const families = new Map<string, string>();
    const held = new Set<string>();
    for (const [id, next] of staged) {
      if (this.quarantined.has(id)) throw new RunWriteRefusedError(id, 'quarantined');
      const family = next ? familyKey(next) : this.familyOf(id);
      families.set(id, family);
      if (this.held.has(id)) held.add(family);
    }
    // A run this store holds may move to a new family; any other row is claimed as a plain write.
    const owned = new Set([...this.claimFamilies(held, { allowLive: true }),
      ...this.claimFamilies([...families.values()].filter((family) => !held.has(family)))]);
    for (const [id, family] of families) {
      if (!owned.has(family)) throw new RunWriteRefusedError(id, this.runOwnership(id) === 'orphaned' ? 'orphaned' : 'foreign');
    }
  }

  /** The family of a run this store knows: held, else its row; a run nowhere is its own. */
  private familyOf(id: string): string {
    const held = this.held.get(id);
    return held ? familyKey(held) : this.deletedFamilies.get(id) ?? this.db?.familyOf(id) ?? id;
  }

  /** Schedule the sweep that lets any of `ids` leave memory, when one of them now can. */
  private sweepIfSettled(ids: Iterable<string>): void {
    for (const id of ids) {
      const run = this.held.get(id);
      if (run && !this.isAnchor(id, run)) { this.scheduleSave(); return; }
    }
  }

  updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'steps'>>): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    if (Object.prototype.hasOwnProperty.call(patch, 'issueNumber')) {
      delete run.referencedIssueNumberSeeded;
    }
    const normalized = { ...patch };
    if (normalized.pullRequestUrl !== undefined) {
      this.accumulatePullRequests(run, [run.pullRequestUrl, normalized.pullRequestUrl].flatMap((url) => {
        const number = refUrlNumber(url);
        if (number === undefined) return [];
        const parsed = runPullRequestSchema.safeParse({ number, url, source: 'created' });
        return parsed.success ? [parsed.data] : [];
      }));
    }
    // Waits are not cleared here: RunManager cancels them explicitly when a run ends (spec
    // 2026-10-17-unified-waits), so a terminal patch never retires one as a side effect.
    const archived = Object.prototype.hasOwnProperty.call(normalized, 'archived')
      ? Boolean(normalized.archived)
      : undefined;
    if (archived !== undefined) {
      delete normalized.archived;
      delete normalized.archivedAt;
    }
    // Restore before mutating so a throw leaves status and archived unchanged (#818 S3).
    if (archived === false) restoreHistory(this.dataDir, id);
    // Opted-in completion and the handoff's records (the file shows only committed ones) take this
    // transaction. Default-off Finish keeps its best-effort write so a locked database cannot stop cleanup.
    if ((normalized.status === 'done' && (run.archiveWhenDone || run.autoMergePr)) || normalized.handoffRecords !== undefined ||
      normalized.archiveWhenDone !== undefined || normalized.autoMergePr !== undefined) {
      const next = { ...run, ...this.redactPatch(normalized) };
      if (archived !== undefined) archiveFields(next, archived, new Date().toISOString());
      this.commitIndex(new Map([[id, next]]));
      return this.record(id);
    }
    Object.assign(run, this.redactPatch(normalized));
    // The usage-limit resume is the appointment of a `waiting` run (hearsay-tools/cezarion#1236),
    // so a run coming back to life or settling retires it. `commitIndex` applies the same rule to
    // every commit (`withoutStaleResumes`); this debounced path mutates the held record without it.
    if (run.status !== 'waiting') run.autoResumeAt = undefined;
    if (normalized.task !== undefined) this.resolveEditedTaskRefs(run);
    if (archived !== undefined) this.applyArchived(run, archived);
    else this.touch(run);
    return run;
  }

  /** Prompt edits can both revoke and restore a reference. Resolve the retained working sets
   *  before notifying readers, using the same ambiguity, marker and repository rules as events. */
  private resolveEditedTaskRefs(run: RunRecord): void {
    // An edited prompt is trusted evidence, just like the initial prompt. Collect its new
    // URLs without discarding earlier evidence before applying the usual resolution rules.
    if (PR_URL_RE.test(run.task)) this.trackReferencedPrs(run, run.task);
    if (ISSUE_URL_RE.test(run.task)) this.trackReferencedIssues(run, run.task);
    if (run.referencedPrCandidates !== undefined) {
      run.referencedPullRequestUrl = resolveReferencedRef(
        run.referencedPrCandidates, run.task, referencedPrDeclaration(run), this.repoHandle,
      );
    }
    if (run.referencedIssueCandidates !== undefined) {
      run.referencedIssueUrl = resolveIssueReference(run, this.repoHandle);
      const number = refUrlNumber(run.referencedIssueUrl);
      if (run.referencedIssueNumberSeeded) {
        // We may change only the number this janitor owns, including clearing an ambiguous one.
        run.issueNumber = number;
        if (number === undefined) delete run.referencedIssueNumberSeeded;
      } else if (number !== undefined && run.issueNumber === undefined &&
        run.markerRefs?.issue === undefined && ISSUE_URL_RE.test(run.task)) {
        // A new seed still needs trusted prompt evidence; retained tool output alone is insufficient.
        run.issueNumber = number;
        run.referencedIssueNumberSeeded = true;
      }
    }
    // Legacy records may carry a URL without a candidate array. Preserve that evidence when
    // allowed, while still revoking a foreign URL the edited prompt no longer corroborates.
    rescopeRun(run, this.repoHandle);
  }

  /**
   * Scrub the free-text fields of a record patch (#427 review). Redacting only
   * events left a hole: `titleSummary` is derived from the RAW first agent turn
   * and `error` from raw process output, so a token the agent echoed was
   * `[REDACTED]` in the NDJSON yet verbatim in `runs.json` — the file the "no
   * secrets in state files" rule names explicitly. These three are the only
   * patch fields carrying agent/process text; the rest are ids, enums, counters
   * and URLs, and running the scrubber over them would only risk mangling them.
   *
   * `StepState.error` is the step-level counterpart and is scrubbed the same
   * way in `updateStep` — `run.ts` feeds the SAME `err.message` string to both
   * calls, so redacting only the run-level copy left the token verbatim one
   * field away (#456 review).
   */
  private redactPatch(
    patch: Partial<Omit<RunRecord, 'id' | 'steps'>>,
  ): Partial<Omit<RunRecord, 'id' | 'steps'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    const out = { ...patch };
    for (const field of ['title', 'titleSummary', 'error'] as const) {
      const value = out[field];
      if (typeof value === 'string') out[field] = this.redactText(value);
    }
    return out;
  }

  /**
   * Step-level counterpart of `redactPatch` (#456 review). `error` is the only
   * free-text `StepState` field — it is set from raw `err.message` /process
   * output (`run.ts` `finishStep`), and `touch()` fans the whole record out
   * over SSE, so an unscrubbed copy leaked to `runs.json` AND to the browser.
   * The remaining fields are ids, enums, counters and timestamps.
   */
  private redactStepPatch(patch: Partial<Omit<StepState, 'id'>>): Partial<Omit<StepState, 'id'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    if (typeof patch.error !== 'string') return patch;
    return { ...patch, error: this.redactText(patch.error) };
  }

  /** Append a step to an existing run (used by "Continue" — spec 003). */
  addStep(runId: string, step: Pick<StepState, 'id' | 'name' | 'kind' | 'synthetic'>): void {
    const run = this.record(runId);
    if (!run || run.steps.some((s) => s.id === step.id)) return;
    run.steps.push({ ...step, status: 'pending', iterations: 0, tokensUsed: 0 });
    this.touch(run);
  }

  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void {
    const run = this.record(runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;
    Object.assign(step, this.redactStepPatch(patch));
    run.tokensUsed = run.steps.reduce((sum, s) => sum + s.tokensUsed, 0);
    const startedAgentSteps = run.steps.filter((candidate) => candidate.kind === 'agent' && candidate.iterations > 0);
    const directionalComplete =
      startedAgentSteps.length > 0 &&
      startedAgentSteps.every(
        (candidate) =>
          candidate.usageInvocationsStarted !== undefined &&
          candidate.usageInvocationsObserved !== undefined &&
          candidate.usageInvocationsObserved > 0 &&
          candidate.usageInvocationsStarted === candidate.usageInvocationsObserved &&
          candidate.usageTurnsStarted !== undefined &&
          candidate.usageTurnsRecorded !== undefined &&
          candidate.usageTurnsStarted > 0 &&
          candidate.usageTurnsStarted === candidate.usageTurnsRecorded &&
          candidate.inputTokens !== undefined &&
          candidate.outputTokens !== undefined,
      );
    run.inputTokens = directionalComplete
      ? startedAgentSteps.reduce((sum, candidate) => sum + (candidate.inputTokens ?? 0), 0)
      : undefined;
    run.outputTokens = directionalComplete
      ? startedAgentSteps.reduce((sum, candidate) => sum + (candidate.outputTokens ?? 0), 0)
      : undefined;
    const cost = run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    run.costUsd = run.steps.some((step) => step.costUsd !== undefined) ? cost : undefined;
    this.touch(run);
  }

  listArchiveOnMergeCandidates(afterSeq = 0, limit = 32): Array<{ id: string; seq: number }> {
    return this.db?.listArchiveOnMergeCandidates(afterSeq, limit) ?? [];
  }

  /** Use unnormalized persisted evidence: cold reads must not turn interrupted work into safety. */
  private archiveFamily(id: string, isActive: (id: string) => boolean): RunRecord[] | undefined {
    const ids = [id, ...new Set([...(this.db?.listIdsByParent(id) ?? []), ...this.listWorkersOf(id).map(run => run.id)])];
    if (ids.length > 1025) return undefined;
    const family: RunRecord[] = [];
    const block = (message: string, runId = id) => { this.setArchiveBlocker(id, { message, runId }); return undefined; };
    for (const memberId of ids) {
      const row = this.db?.get(memberId);
      const raw: unknown = row ? JSON.parse(row.data) : this.held.get(memberId);
      const decoded = decodeRunRow(JSON.stringify(raw));
      if (!decoded) return block('Task history is unavailable. Open the task or archive it manually.', memberId);
      // Do not let the runtime schema's per-entry salvage hide malformed PR authority.
      if (raw && typeof raw === 'object' && 'pullRequests' in raw &&
        (!Array.isArray(raw.pullRequests) || raw.pullRequests.some(entry => !runPullRequestSchema.safeParse(entry).success))) return block('PR associations are invalid. Check the task PRs or archive manually.', memberId);
      const run = this.held.get(memberId) ?? decoded.run;
      if (row && !this.held.has(memberId)) this.decodeCold(row); // records the synchronous write fence
      if (this.deleted.has(memberId) || this.quarantined.has(memberId) || this.writeRefusal(memberId))
        return block('Task history is owned elsewhere or cannot be changed. Retry after its owner stops.', memberId);
      if (this.pins.has(memberId) || isActive(memberId) || isLiveRecord(run) || row?.live ||
        !['review', 'done', 'failed', 'cancelled'].includes(run.status))
        return block('Task work is still active. Wait for it to finish or archive manually.', memberId);
      if (run.waits?.some(wait => wait.kind === 'human' && wait.phase === 'open') || run.hasPendingPermission)
        return block('Task needs an answer or permission. Open it to respond, or archive manually.', memberId);
      if (run.delegation?.role === 'invalid') return block('Worker ownership is invalid. Inspect the task or archive manually.', memberId);
      const facts = this.facts.peek(memberId);
      if (!facts || facts.pendingAsk !== undefined) return block('Task has an unanswered question or unread history. Open it to respond, or archive manually.', memberId);
      if (run.delegation?.role === 'worker' && this.readWorkerExecution(memberId)?.phase !== 'complete')
        return block('Worker execution has not settled. Open the worker or archive manually.', memberId);
      // Process and scratch cleanup evidence protects deletion, not reversible filing.
      family.push(run);
    }
    if (family[0]?.delegation?.role === 'worker' || family[0]?.archived) return undefined;
    return family;
  }

  /** Blockers are feedback, never archive authority or cleanup permission. */
  setArchiveBlocker(id: string, blocker: RunRecord['archiveBlocker']): void {
    const run = this.record(id);
    if (!run || run.archived || isDeepStrictEqual(run.archiveBlocker, blocker)) return;
    this.commitIndex(new Map([[id, { ...run, archiveBlocker: blocker }]]));
  }

  archiveMergeBlocker(snapshot: ArchiveOnMergeSnapshot, missing: ArchivePullRequestIdentity, repoBase?: string): void {
    const url = `https://github.com/${missing.owner}/${missing.repo}/pull/${missing.number}`;
    const family = [snapshot.rootId, ...(this.db?.listIdsByParent(snapshot.rootId) ?? [])].flatMap(id => {
      const run = this.peek(id); return run ? [run] : [];
    });
    const member = family.find(run => archivePullRequests([run], repoBase)?.some(pr => pullRequestKey(pr) === pullRequestKey(missing)));
    this.setArchiveBlocker(snapshot.rootId, { message: `PR ${missing.owner}/${missing.repo}#${missing.number} is not confirmed merged. Check the PR association or archive manually.`,
      runId: member?.id ?? snapshot.rootId, pullRequestUrl: url });
  }

  hasArchiveOnMergeAssociations(id: string): boolean {
    return this.db?.archiveFamilyHasPullRequests(id) ?? false;
  }

  async prepareArchiveOnMerge(id: string): Promise<void> {
    const ids = [id, ...(this.db?.listIdsByParent(id) ?? [])];
    if (ids.length > 1025) return;
    for (const memberId of ids) await this.facts.ready(memberId);
  }

  archiveOnMergeSnapshot(id: string, repoBase?: string, isActive: (id: string) => boolean = () => false): ArchiveOnMergeSnapshot | undefined {
    const family = this.archiveFamily(id, isActive);
    if (!family) return undefined;
    return this.archiveSnapshot(family, repoBase);
  }

  private archiveSnapshot(family: RunRecord[], repoBase?: string): ArchiveOnMergeSnapshot | undefined {
    const pullRequests = archivePullRequests(family, repoBase);
    if (!pullRequests) {
      this.setArchiveBlocker(family[0]!.id, { message: 'PR associations cannot be resolved. Check task and worker PRs, or archive manually.' });
      return undefined;
    }
    const fingerprint = archiveDigest(pullRequests);
    if (family[0]!.autoArchive?.fingerprint === fingerprint) return undefined;
    return { rootId: family[0]!.id, fingerprint, pullRequests, token: archiveDigest(family.map(({ archiveBlocker: _blocker, ...run }) => run)) };
  }

  /** No await between final revalidation and the fenced, all-or-nothing cascade. */
  archiveAfterMerge(snapshot: ArchiveOnMergeSnapshot, observations: readonly MergedPullRequest[], repoBase?: string,
    isActive: (id: string) => boolean = () => false): boolean {
    const family = this.archiveFamily(snapshot.rootId, isActive);
    if (!family) return false;
    const current = this.archiveSnapshot(family, repoBase);
    if (!current || current.token !== snapshot.token || current.fingerprint !== snapshot.fingerprint) return false;
    const parsed = observations.map(observation => mergedPullRequestSchema.safeParse(observation));
    if (parsed.some(result => !result.success)) return false;
    const merged = parsed.flatMap(result => result.success ? [result.data] : []);
    const byKey = new Map(merged.map(pr => [pullRequestKey(pr), pr]));
    if (byKey.size !== current.pullRequests.length || current.pullRequests.some(pr => !byKey.has(pullRequestKey(pr)))) return false;
    const restoredAt = Math.max(0, ...family.map(run => run.manualUnarchivedAt ? Date.parse(run.manualUnarchivedAt) : 0));
    if (restoredAt && merged.every(pr => Date.parse(pr.mergedAt) <= restoredAt)) return false;
    const now = new Date().toISOString();
    if (merged.some(pr => Date.parse(pr.mergedAt) > Date.parse(now))) return false;
    const staged = new Map<string, RunRecord | null>();
    this.stageArchive(staged, family[0]!, true);
    staged.get(snapshot.rootId)!.autoArchive = { reason: 'pull-requests-merged', archivedAt: now, fingerprint: current.fingerprint, pullRequests: merged };
    this.commitIndex(staged);
    for (const id of staged.keys()) this.compressor.enqueue(id);
    return true;
  }

  setArchived(id: string, archived: boolean): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    this.applyArchivedCascade(run, archived);
    return run;
  }

  /** Parent + owned workers; returns how many records flipped `archived`. */
  private applyArchivedCascade(run: RunRecord, archived: boolean): number {
    const staged = new Map<string, RunRecord | null>();
    this.stageArchive(staged, run, archived);
    let changed = 0;
    for (const [id, next] of staged) {
      if (next && this.peek(id)?.archived !== archived) changed++;
      if (next) next.completionAction = undefined; // an explicit filing/restoration retires pending work
    }
    this.commitIndex(staged);
    return changed;
  }

  private applyArchived(run: RunRecord, archived: boolean): boolean {
    const changed = run.archived !== archived;
    // Transcript first: a restore throw aborts with the record unchanged (#818 S3).
    this.syncTranscriptForm(run.id, archived);
    archiveFields(run, archived, new Date().toISOString());
    this.touch(run);
    return changed;
  }

  /** Transcript form follows `archived`: enqueue compression, or restore the plain file now. */
  private syncTranscriptForm(id: string, archived: boolean): void {
    if (archived) this.compressor.enqueue(id);
    else {
      this.compressor.cancel(id);
      restoreHistory(this.dataDir, id);
    }
  }

  /**
   * Whether this store may compress `id`'s transcript: the run exists, is archived, is not in a
   * live status (queued/running/waiting), and this process holds the family's claim in `claimed`
   * (not merely `pendingClaims`). Two processes never both write a run (#779, #818 B1).
   */
  private isHistoryCompressEligible(id: string): boolean {
    if (this.deleted.has(id)) return false;
    try {
      const run = this.held.get(id) ?? this.peek(id);
      if (!run || run.archived !== true || isLiveStatus(run.status)) return false;
      return this.holdsCompressClaim(id);
    } catch {
      return false;
    }
  }

  /** Take the family claim if free and require it to be in `this.claimed`, not only pending. */
  private holdsCompressClaim(id: string): boolean {
    const family = this.familyOf(id);
    return this.claimFamilies([family]).has(family) && this.claimed.has(family);
  }

  /** Startup sweep: enqueue every archived non-live run that still has a plain transcript. */
  compressArchivedHistory(): void {
    try {
      const ids = new Set<string>();
      for (const key of this.db?.listKeysWhere('archived = 1 AND live = 0') ?? []) {
        if (!this.deleted.has(key.id)) ids.add(key.id);
      }
      for (const run of this.held.values()) {
        if (run.archived && !isLiveStatus(run.status) && !this.deleted.has(run.id)) ids.add(run.id);
      }
      for (const id of ids) {
        try {
          const { plain } = historyPaths(this.dataDir, id);
          // Claim only ids with work: a plain file to compress, including both-present leftovers.
          if (!existsSync(plain)) continue;
          if (!this.holdsCompressClaim(id)) continue;
          if (hasPlainHistory(this.dataDir, id)) this.compressor.enqueue(id);
        } catch {
          // Best effort: one id must not stop the sweep or boot (#818 S2).
        }
      }
    } catch {
      // listKeysWhere / open-time fs: never throw out of boot.
    }
  }

  /** Resolves when the transcript compressor is idle (tests, shutdown). */
  historyIdle(): Promise<void> {
    return this.compressor.idle();
  }

  /** Pin one run to the top of this project's task list, or unpin it (#935). Mirrors
   *  `setArchived`: sets the fields, then persists + broadcasts via `touch`, so the updated
   *  record rides the existing `run` SSE with no new event. Idempotent — re-pinning a pinned
   *  run just re-stamps `pinnedAt`.
   *
   *  Every active status is pinnable. Archived requests clear stale metadata instead, so a
   *  late click racing archive cannot leave a hidden pin that reappears on unarchive. */
  setPinned(id: string, pinned: boolean): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    if (pinned && !run.archived) {
      run.pinned = true;
      run.pinnedAt = new Date().toISOString();
    } else {
      clearPin(run);
    }
    this.touch(run);
    return run;
  }

  /** Bulk-archive finished runs (#780). `isSweepable` decides which; `archived` counts every
   *  record that flipped (cascaded workers included), `ids` lists the top-level runs picked and
   *  `pinnedIds` the subset that carried a pin before `clearPin` dropped it. */
  archiveFinished(scope?: ArchiveFinishedScope, automation?: boolean): { archived: number; ids: string[]; pinnedIds: string[] } {
    let archived = 0;
    // Snapshot first: cascade may archive still-live workers, mutating the held set, and the pin
    // has to be read before `applyArchived` clears it. Runs not in memory are picked off their
    // stored summary, which carries every field `isSweepable` reads.
    const picked: Array<readonly [Parameters<typeof isSweepable>[0] & { id: string }, ListOrder]> =
      [...this.held.values()].filter((run) => isSweepable({ ...run, automationId: automationIdOf(run) }, scope, automation))
        .map((run) => [run, this.listOrder(run)]);
    for (const row of this.db?.listWhere("archived = 0 AND status IN ('done', 'failed', 'cancelled') AND parent_run_id IS NULL") ?? []) {
      if (this.held.has(row.id) || this.deleted.has(row.id)) continue;
      const summary = parseStoredSummary(row.summary);
      if (summary && isSweepable(summary, scope, automation)) picked.push([summary, row]);
    }
    // Another process's runs are not this store's to archive (#779, plan step 3): they stay out.
    // A sweepable run is never a worker (`isSweepable`), so each is its own family.
    const writable = this.claimFamilies(picked.map(([run]) => run.id));
    const mine = sortNewestFirst(picked.filter(([run]) => writable.has(run.id)));
    const ids = mine.map((run) => run.id);
    const pinnedIds = mine.filter((run) => run.pinned).map((run) => run.id);
    for (const id of ids) {
      // Re-check: a prior cascade may already have archived this id.
      const run = this.record(id);
      if (!run || run.archived) continue;
      archived += this.applyArchivedCascade(run, true);
    }
    return { archived, ids, pinnedIds };
  }

  /** Mark one run as read (#unread-done-items): stamp the read receipt now. Mirrors
   *  `setArchived` — sets the field then persists + broadcasts via `touch`, so the
   *  updated record rides the existing `run` SSE with no new event. Idempotent by
   *  design: opening an already-read thread just re-stamps a later `seenAt`. */
  setRead(id: string): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    run.seenAt = new Date().toISOString();
    this.touch(run);
    return run;
  }

  /** Mark one run as UNread (#775): drop the read receipt so the run rejoins the unread
   *  list. The inverse of `setRead` and, like it, `touch`es so the updated record rides the
   *  existing `run` SSE.
   *
   *  Deleting the field rather than adding a "manually unread" flag is the whole point:
   *  absent `seenAt` is ALREADY what every reader treats as unread (`isUnread` in the
   *  cockpit's read-state.ts, and `markAllRead`'s clause-for-clause copy of it below), so
   *  clearing needs no new state and writes a shape any older cezar already parses.
   *
   *  Deliberately unconditional: clearing a receipt is always a legal write, so this
   *  succeeds for an already-unread run (idempotent) and for statuses that can never wear
   *  the marker. WHETHER the action means anything for a given run is UI policy, and lives
   *  in the cockpit's `runActionFlags` — the same split the rest of the store keeps. */
  setUnread(id: string): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    delete run.seenAt;
    this.touch(run);
    return run;
  }

  /**
   * Stamp unread finished runs in bulk and return the count. Keep the rule aligned with cockpit
   * isUnread: done/failed, finished since seen, not archived; cancelled and usage-limit waiting
   * runs are excluded. `automation` narrows it to one origin, as in `archiveFinished`
   * (hearsay-tools/cezarion#1616); absent stamps both.
   */
  markAllRead(automation?: boolean): number {
    const now = new Date().toISOString();
    let count = 0;
    // Runs not in memory are picked by the same rule over their stored summary, then re-checked
    // on the record before they are stamped.
    const candidates = [...this.held.values()];
    const stored = (this.db?.listWhere(MARK_ALL_READ_SQL) ?? []).filter((row) => !this.held.has(row.id) && !this.deleted.has(row.id));
    // One claim transaction for them all; another process's runs are skipped (`record` refuses).
    this.claimFamilies(stored.map(rowFamily));
    for (const row of stored) {
      const run = this.record(row.id);
      if (run) candidates.push(run);
    }
    for (const run of candidates) {
      const unread =
        !run.archived &&
        (run.status === 'done' || run.status === 'failed') &&
        run.finishedAt !== undefined &&
        (run.seenAt === undefined || run.seenAt < run.finishedAt);
      if (!unread) continue;
      if (automation !== undefined && (automationIdOf(run) !== undefined) !== automation) continue;
      run.seenAt = now;
      this.touch(run);
      count++;
    }
    return count;
  }

  appendEvent(runId: string, event: { type: string; stepId?: string | undefined; [key: string]: unknown }): RunEvent {
    const run = this.record(runId);
    if (!run) {
      const ownership = this.runOwnership(runId);
      if (ownership === 'foreign' || ownership === 'orphaned' || ownership === 'quarantined') throw new RunWriteRefusedError(runId, ownership);
      throw new Error(`unknown run: ${runId}`);
    }
    const seq = this.nextSeq(runId);
    // Scrub credentials before the event touches disk or the live wire (#427):
    // tool-result output is persisted verbatim and served back over the API, so
    // a secret in an agent's command output would otherwise land in `.ai/cezar/`.
    const full: RunEvent & { stepId?: string } = this.redact(defined({ ...event, seq, ts: new Date().toISOString() }));
    // Sync append keeps event order without a write queue; local NDJSON
    // appends at agent-event rates are effectively free.
    if (!hasPlainHistory(this.dataDir, runId)) restoreHistory(this.dataDir, runId);
    const line = `${JSON.stringify(full)}\n`;
    appendFileSync(this.eventsPath(runId), line, 'utf8');
    this.facts.append(runId, full, Buffer.byteLength(line));
    this.maybeEnqueueHistoryCompress(run);
    this.liveItems.observe(runId, full, false);
    this.emit('event', { runId, event: full });

    // The janitor trick: agents print the PR URL after `gh pr create` — the
    // first one spotted in the transcript becomes the run's PR link. Scans v1
    // fields AND nested v2 `item.*` content (#407). A URL without the created
    // phrasing still feeds the referenced tier (the PR the task is about) —
    // and the phrasing itself is only believed from a source that can speak
    // FOR this run (`eventCreationClaimFragments`), never from quoted output.
    const haystack = eventTextFragments(full).join(' ');
    const agentHaystack = eventAgentTextFragments(full).join(' ');
    // The creation CLAIM is read from a narrower source than the URL is
    // (`eventCreationClaimFragments`), which is why the two are searched
    // together rather than the haystack alone: the phrase must land in the
    // trusted prefix, and the link may come from anywhere after it.
    const claim = eventCreationClaimFragments(full).join(' ');
    if (haystack.length > 0) {
      let changed = false;
      // One associated URL per trusted creation claim; replayed v1/v2 reports merge by identity.
      const item = full.item as Record<string, unknown> | undefined;
      const toolOutput = item?.kind === 'tool' && typeof item.output === 'string' ? item.output : undefined;
      const created = createdPrUrls(claim, haystack, toolOutput);
      for (const url of created) {
        const number = refUrlNumber(url);
        const parsed = runPullRequestSchema.safeParse({ number, url, source: 'created' });
        if (!parsed.success) continue;
        changed = this.accumulatePullRequests(run, [parsed.data]) || changed;
        if (!run.pullRequestUrl) { run.pullRequestUrl = url; changed = true; }
      }
      if (created.length > 0) {
        const resolved = resolveReferencedRef(
          run.referencedPrCandidates ?? [], run.task, referencedPrDeclaration(run), this.repoHandle,
        );
        if (resolved !== run.referencedPullRequestUrl) {
          run.referencedPullRequestUrl = resolved;
          changed = true;
        }
      } else if (!run.pullRequestUrl && PR_URL_RE.test(haystack) && this.trackReferencedPrs(run, haystack)) {
        changed = true;
      }
      // Issue links feed their own referenced tier regardless of PR state —
      // a task that created a PR can still be ABOUT an issue
      // (spec 2026-07-21-report-ref-discovery).
      if (
        ISSUE_URL_RE.test(haystack) &&
        this.trackReferencedIssues(run, haystack, agentHaystack)
      ) {
        changed = true;
      }
      if (changed) this.touch(run);
    }
    return full;
  }

  /**
   * Fold every PR URL in `haystack` into the run's referenced-tier working
   * set and re-resolve `referencedPullRequestUrl` (spec
   * 2026-07-16-pr-autodiscovery). Mutates the record in place — the caller
   * owns persistence/fan-out — and reports whether anything changed.
   */
  private trackReferencedPrs(run: RunRecord, haystack: string): boolean {
    const seen = new Set(run.referencedPrCandidates ?? []);
    const before = seen.size;
    for (const match of haystack.matchAll(new RegExp(PR_URL_RE.source, 'g'))) {
      if (seen.size >= MAX_PR_CANDIDATES) break;
      seen.add(match[0]);
    }
    if (seen.size === before) return false;
    run.referencedPrCandidates = [...seen];
    run.referencedPullRequestUrl = resolveReferencedRef(
      run.referencedPrCandidates,
      run.task,
      referencedPrDeclaration(run),
      this.repoHandle,
    );
    return true;
  }

  /**
   * The issue-side mirror of `trackReferencedPrs` (spec
   * 2026-07-21-report-ref-discovery): fold every issue URL in `haystack` into
   * the working set and re-resolve `referencedIssueUrl`. An unambiguous
   * resolution also seeds `issueNumber` when nothing owns that field yet —
   * marker and namer both outrank this janitor and overwrite it freely.
   */
  private trackReferencedIssues(
    run: RunRecord,
    haystack: string,
    seedHaystack = haystack,
  ): boolean {
    const seen = new Set(run.referencedIssueCandidates ?? []);
    const before = seen.size;
    for (const match of haystack.matchAll(new RegExp(ISSUE_URL_RE.source, 'g'))) {
      if (seen.size >= MAX_PR_CANDIDATES) break;
      seen.add(match[0]);
    }
    const candidatesChanged = seen.size !== before;
    if (candidatesChanged) run.referencedIssueCandidates = [...seen];
    const prev = run.referencedIssueUrl;
    run.referencedIssueUrl = resolveIssueReference(run, this.repoHandle);
    let numberChanged = false;
    if (run.markerRefs?.issue === undefined && ISSUE_URL_RE.test(seedHaystack)) {
      if (run.referencedIssueUrl && run.issueNumber === undefined) {
        const n = Number(run.referencedIssueUrl.split('/').pop());
        if (Number.isInteger(n) && n > 0) {
          run.issueNumber = n;
          run.referencedIssueNumberSeeded = true;
          numberChanged = true;
        }
      } else if (!run.referencedIssueUrl && prev && run.referencedIssueNumberSeeded) {
        // Ambiguity revoked the resolution — take back the number this janitor
        // seeded from it. No chip beats a wrong chip.
        delete run.issueNumber;
        delete run.referencedIssueNumberSeeded;
        numberChanged = true;
      }
    }
    return candidatesChanged || run.referencedIssueUrl !== prev || numberChanged;
  }

  /**
   * Apply agent-declared reference markers (spec 2026-07-18-task-ref-markers).
   * Marker values are authoritative for the display tier: they overwrite the
   * regex/namer numbers unless the prompt identifies the originating issue, and a declared PR re-resolves the referenced URL
   * against the candidate working set — including down to `undefined` when no
   * candidate matches (a wrong chip is worse than no chip). The created tier
   * (`pullRequestUrl`) is deliberately untouched.
   *
   * One declaration is NOT a statement about the referenced tier: the number of the PR this run
   * itself created. See `referencedPrDeclaration` — the marker contract asks the agent to
   * re-declare after it opens a PR, and taking that literally cost the task the PR it was about.
   */
  applyMarkerRefs(runId: string, refs: { pr?: number | undefined; prs?: readonly number[] | undefined; issue?: number | undefined }): RunRecord | undefined {
    const run = this.record(runId);
    if (!run || (refs.pr === undefined && refs.issue === undefined)) return run;
    const numbers = [...new Set([...(run.markerRefs?.pr === undefined ? [] : [run.markerRefs.pr]),
      ...(refs.prs ?? (refs.pr === undefined ? [] : [refs.pr]))])];
    if (numbers.length) this.accumulatePullRequests(run, numbers.flatMap((number) => {
      const matches = (run.referencedPrCandidates ?? []).filter((url) => refUrlNumber(url) === number &&
        (this.repoHandle ? isRepoScopedRef(url, run.task, this.repoHandle) : promptNamesRepo(url, run.task)));
      const url = matches.length === 1 ? matches[0] : matches.length === 0 && this.repoHandle
        ? `https://github.com/${this.repoHandle.owner}/${this.repoHandle.name}/pull/${number}` : undefined;
      const parsed = runPullRequestSchema.safeParse({ number, ...(url ? { url } : {}), source: 'declared' });
      return parsed.success ? [parsed.data] : [];
    }));
    run.markerRefs = {
      ...run.markerRefs,
      ...(refs.pr !== undefined ? { pr: refs.pr } : {}),
      ...(refs.issue !== undefined ? { issue: refs.issue } : {}),
    };
    // `prNumber` is the about-PR as well (it is what paints a numeric-only chip), so a
    // re-declaration naming the created PR only FILLS it — it never overwrites the number the
    // task came in with, which is still the PR this task is about.
    if (refs.pr !== undefined && (run.prNumber === undefined || refs.pr !== refUrlNumber(run.pullRequestUrl))) {
      run.prNumber = refs.pr;
    }
    if (refs.issue !== undefined) {
      run.issueNumber = originatingIssue(run) ?? refs.issue;
      delete run.referencedIssueNumberSeeded;
    }
    if (run.markerRefs.pr !== undefined) {
      run.referencedPullRequestUrl = resolveReferencedRef(
        run.referencedPrCandidates ?? [],
        run.task,
        referencedPrDeclaration(run),
        this.repoHandle,
      );
    }
    if (run.markerRefs.issue !== undefined) {
      run.referencedIssueUrl = resolveIssueReference(run, this.repoHandle);
    }
    this.touch(run);
    return run;
  }

  /** Authoritative creation keeps the first scalar for publishing, plus every created identity. */
  recordCreatedPr(runId: string, url: string): RunRecord | undefined {
    const run = this.record(runId);
    const parsed = runPullRequestSchema.safeParse({ number: refUrlNumber(url), url, source: 'created' });
    if (!run || !parsed.success) return run;
    let changed = this.accumulatePullRequests(run, [parsed.data]);
    if (!run.pullRequestUrl) { run.pullRequestUrl = url; changed = true; }
    if (changed) this.touch(run);
    return run;
  }

  private accumulatePullRequests(run: RunRecord, entries: readonly RunPullRequest[]): boolean {
    const next = mergePullRequests(run.pullRequests, entries, this.repoHandle
      ? `https://github.com/${this.repoHandle.owner}/${this.repoHandle.name}` : undefined);
    if (isDeepStrictEqual(next, run.pullRequests)) return false;
    run.pullRequests = next;
    return true;
  }

  /**
   * Fan an event out to live subscribers WITHOUT writing it to the NDJSON
   * file — the channel for coalesced `item.delta` flushes (protocol-v2
   * performance guardrail: raw deltas never hit disk; replay = the persisted
   * snapshots). Stamped with `seq`/`ts` like persisted lines so the live
   * wire keeps one ordering axis. Finite polling coalesces active item content
   * into bounded in-memory snapshots on that clock; disk replay still has gaps
   * (dedup compares with `>`).
   */
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const full: RunEvent = this.redact({ ...event, seq: this.nextSeq(runId), ts: new Date().toISOString() });
    this.liveItems.observe(runId, full, true);
    this.emit('event', { runId, event: full });
    return full;
  }

  /** Lazily-collected concrete secret values from the host env (#427). */
  private secretValues: readonly string[] | null = null;
  /** Controller-issued tokens never persist, including when host-secret redaction is disabled. */
  private readonly sessionSecrets = new Set<string>();
  registerSessionSecret(value: string): void { this.sessionSecrets.add(value); }
  containsSessionSecret(value: string): boolean { return [...this.sessionSecrets].some(secret => value.includes(secret)); }

  /**
   * Scrub known credential values / token shapes from an event before it is
   * persisted or fanned out. On by default; `CEZ_REDACT_SECRETS=0` opts out.
   */
  private redact<T extends RunEvent>(event: T): T {
    const safe = this.sessionSecrets.size ? redactDeep(event, [...this.sessionSecrets]) : event;
    if (process.env.CEZ_REDACT_SECRETS === '0') return safe;
    return redactDeep(safe, this.hostSecrets());
  }

  /** Best-effort scrub of one free-text string bound for `runs.json`. Honors
   *  the `CEZ_REDACT_SECRETS=0` opt-out itself so every caller inherits it. */
  redactText(text: string): string {
    const safe = this.sessionSecrets.size ? redactSecrets(text, [...this.sessionSecrets]) : text;
    if (process.env.CEZ_REDACT_SECRETS === '0') return safe;
    return redactSecrets(safe, this.hostSecrets());
  }

  private hostSecrets(): readonly string[] {
    if (this.secretValues === null) this.secretValues = collectSecretValues();
    return this.secretValues;
  }

  /** The run's indexed transcript facts (#880): a read-only view, never a transcript read once
   *  the run's index is loaded. An unreadable transcript answers as empty, as readEvents does. */
  transcriptFacts(runId: string): Readonly<TranscriptFacts> {
    return this.facts.get(runId) ?? emptyFacts();
  }

  /** The run's transcript facts when they are known: undefined when the transcript exists but its
   *  facts are not current or cannot be read, so a caller can tell "no ask" from "no evidence". */
  knownTranscriptFacts(runId: string): Readonly<TranscriptFacts> | undefined {
    return this.facts.peek(runId);
  }

  hasProjection(runId: string, projectionId: string): boolean {
    return this.transcriptFacts(runId).projectionIds.includes(projectionId);
  }

  private factsWarming: Promise<void> = Promise.resolve();

  /** Indexed family enumeration, including members not yet flushed to SQLite. */
  listFamilyRunIds(rootId: string): string[] {
    const ids = new Set([rootId, ...(this.db?.listIdsByParent(rootId) ?? [])]);
    for (const [id, run] of this.held) {
      if (familyRootOf(run) === rootId) ids.add(id);
      else if (id !== rootId) ids.delete(id);
    }
    for (const id of this.deleted) ids.delete(id);
    return [...ids];
  }

  private recoveryFactIds(familyRootId?: string): string[] {
    if (familyRootId !== undefined) return this.listFamilyRunIds(familyRootId);
    const ids = new Set<string>();
    for (const [id, run] of this.held) {
      if (!isLiveRecord(run)) continue;
      const root = familyRootOf(run);
      for (const member of root === undefined ? [id] : this.listFamilyRunIds(root)) ids.add(member);
    }
    return [...ids];
  }

  /** Readiness owns no run snapshot across an await: refresh only the currently held owner. */
  async prepareTranscriptFacts(runIds: Iterable<string>): Promise<void> {
    for (const id of new Set(runIds)) {
      // Exact sidecars resolve immediately too: recovery must yield to timers/I/O between IDs.
      await new Promise<void>(resolve => setImmediate(resolve));
      await this.facts.ready(id);
    }
  }

  prepareRecoveryFacts(familyRootId?: string): Promise<void> {
    return this.prepareTranscriptFacts(this.recoveryFactIds(familyRootId));
  }

  /** Register IDs only here; the index yields between cache reads and off-loop rebuilds. */
  private warmTranscriptFacts(): void {
    this.factsWarming = Promise.resolve().then(async () => {
      if (!this.db) return;
      const ids = new Set(this.recoveryFactIds());
      // hearsay-tools/cezarion#949: this microtask ends open()'s synchronous slice, and on a
      // large history the JSON scan for conversation roots plus one family query per root cost
      // as much again. Past one slice's worth of runs, yield before the scan and between root
      // batches; a small store (every unit test) still registers in this one microtask.
      const large = this.listRunIds().length > WARM_IDS_PER_SLICE;
      const turn = async (): Promise<boolean> => {
        await new Promise<void>(resolve => setImmediate(resolve));
        return this.db !== null;
      };
      if (large && !await turn()) return;
      const roots = this.listConversationRootIds();
      for (let i = 0; i < roots.length; i++) {
        if (large && i > 0 && i % WARM_IDS_PER_SLICE === 0 && !await turn()) return;
        for (const id of this.listFamilyRunIds(roots[i]!)) ids.add(id);
      }
      if (large && !await turn()) return;
      // Re-list after the yields: a run deleted meanwhile must not be registered again.
      const present = this.listRunIds();
      if (large) {
        const live = new Set(present);
        for (const id of ids) if (!live.has(id)) ids.delete(id);
      }
      for (const id of present) ids.add(id);
      await this.facts.warm(ids);
    }).catch(() => undefined);
  }

  /** Resolves when the open-time warm-up is done (tests). */
  factsWarmIdle(): Promise<void> {
    return this.factsWarming;
  }

  /** `readEvents` off the event loop (async read and async brotli), for collection paths. */
  async readEventsAsync(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await readHistoryTextAsync(this.dataDir, runId);
      return raw === undefined ? [] : parseEvents(raw);
    } catch {
      return [];
    }
  }

  readEvents(runId: string): RunEvent[] {
    try {
      const raw = readHistoryText(this.dataDir, runId);
      if (raw === undefined) return [];
      return parseEvents(raw);
    } catch {
      return [];
    }
  }

  /** Private process-generation evidence; never part of run JSON or SSE. */
  private identityPath(id: string): string {
    if (isWindowsWorkerEvidence) return windowsEvidencePath(this.dataDir, id, 'identity');
    return this.executionPath(id).replace(/\.execution\.json$/, '.identity.json');
  }

  readWorkerIdentity(id: string): WorkerExecutionIdentity | undefined {
    try {
      if (isWindowsWorkerEvidence) {
        const content = readWindowsEvidence(this.dataDir, id, 'identity', 16384);
        return content === undefined ? undefined : workerExecutionIdentitySchema.parse(JSON.parse(content));
      }
      return workerExecutionIdentitySchema.parse(JSON.parse(readPrivateWorkerFile(this.identityPath(id), 16384)));
    } catch { return undefined; }
  }

  private writeWorkerIdentity(id: string, identity: WorkerExecutionIdentity): void {
    if (isWindowsWorkerEvidence) { writeWindowsEvidence(this.dataDir, id, 'identity', JSON.stringify(identity), true); return; }
    // Immutable acceptance evidence. An orphan from failed index publication cannot be adopted.
    const fd = openSync(this.identityPath(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(identity)); fsyncSync(fd); } finally { closeSync(fd); }
  }

  private executionPath(id: string): string {
    z.string().uuid().parse(id);
    const dir = join(this.dataDir, 'runs');
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir)) throw new Error('Unsafe execution directory');
    if (isWindowsWorkerEvidence) return windowsEvidencePath(this.dataDir, id, 'execution');
    return join(dir, `${id}.execution.json`);
  }

  readWorkerExecution(id: string): WorkerExecution | undefined {
    try {
      if (isWindowsWorkerEvidence) {
        const content = readWindowsEvidence(this.dataDir, id, 'execution', 16384);
        return content === undefined ? undefined : workerExecutionSchema.parse(JSON.parse(content));
      }
      return workerExecutionSchema.parse(JSON.parse(readPrivateWorkerFile(this.executionPath(id), 16384)));
    } catch { return undefined; }
  }

  private writeWorkerExecution(id: string, proof: WorkerExecution, fresh = false): void {
    if (isWindowsWorkerEvidence) { writeWindowsEvidence(this.dataDir, id, 'execution', JSON.stringify(proof), fresh); return; }
    replacePrivateWorkerFile(this.executionPath(id), JSON.stringify(proof), fresh);
  }

  /** Complete execution is not permission to reuse/delete persistent resources (#738).
   * Synchronous, fresh and generation/resource fenced; callers hold admission off across awaits. */
  workerResourcesSafe(id: string, generation: string, resourceId: string, admittingQueued = false): boolean {
    return this.workerResourceHolders(id, generation, resourceId, { admittingQueued }) === 'safe';
  }

  /** `workerResourcesSafe` with the refusal's live PIDs (empty when no PID explains it). */
  workerResourceHolders(id: string, generation: string, resourceId: string,
    opts: { admittingQueued?: boolean; cwds?: CwdSource | undefined } = {}): 'safe' | number[] {
    if (autosaveCleanupBlocker(this.dataDir, id)) return [];
    const run = this.peek(id);
    const proof = this.readWorkerExecution(id);
    if (run?.delegation?.role !== 'worker' || run.delegation.workspace.ownerRunId !== id ||
      run.delegation.workspace.resourceId !== resourceId || proof?.generation !== generation ||
      (proof.phase !== 'complete' && !(opts.admittingQueued && proof.phase === 'queued'))) return [];
    const record = this.readWorkerProcesses(id, generation);
    if (record === 'unknown' || !agentTmpDirOwnershipProven(this.dataDir, id)) return [];
    const paths = [run.delegation.workspace.path, ...agentTmpDirLocations(this.dataDir, id)];
    // Nothing can be deleted/reused at an absent path. This lets explicit history deletion
    // retire completed cleanup despite ambient denial, while recorded survivors/unknown evidence
    // still block. Only ENOENT proves absence; existsSync would also hide access errors.
    const absent = paths.every(path => {
      try { lstatSync(path); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    });
    if (absent) return record === 'absent' ||
      ((!recordedProcessLive(record.controller) || isCurrentProcess(record.controller)) && !record.processes.some(recordedProcessLive)) ? 'safe' : [];
    const probe = inspectGeneration({ ...(record === 'absent' ? {} : { record }), paths, cwds: opts.cwds });
    return probe.liveness === 'gone' ? 'safe' : probe.controller !== undefined ? [probe.controller] : probe.pids;
  }

  /** Upgrade a legacy completed checkpoint while terminal task ownership is still known.
   * No holder scan here: settlement and scheduling must never wait on cleanup proof. */
  retainWorkerScratchCleanup(id: string): void {
    const run = this.peek(id), proof = this.readWorkerExecution(id);
    if (run?.delegation?.role !== 'worker' || ['queued', 'running', 'waiting'].includes(run.status) || proof?.phase !== 'complete') return;
    const { resourceId, path } = run.delegation.workspace;
    if (proof.scratchCleanup?.resourceId === resourceId && proof.scratchCleanup.path === path) return;
    this.writeWorkerExecution(id, { ...proof, scratchCleanup: { resourceId, path } });
  }

  /** Cleanup can outlive its index row, but never its generation or terminal task intent.
   * `cwds` is the scratch reprobe tick's shared `/proc` snapshot (hearsay-tools/cezarion#879). */
  workerScratchResourcesSafe(id: string, generation: string, resourceId: string, cwds?: CwdSource): boolean {
    if (autosaveCleanupBlocker(this.dataDir, id)) return false;
    const run = this.peek(id), proof = this.readWorkerExecution(id);
    if (proof?.phase !== 'complete' || proof.generation !== generation || proof.scratchCleanup?.resourceId !== resourceId ||
      (run && ['queued', 'running', 'waiting'].includes(run.status))) return false;
    if (run?.delegation?.role === 'worker') return run.delegation.workspace.path === proof.scratchCleanup.path &&
      this.workerResourceHolders(id, generation, resourceId, { cwds }) === 'safe';
    // A valid different role contradicts the retained intent. Quarantined/missing metadata
    // supplies no new authority; only the private terminal checkpoint authorizes scratch.
    if (run && run.delegation?.role !== 'invalid') return false;
    const record = this.readWorkerProcesses(id, generation);
    if (record === 'unknown' || !agentTmpDirOwnershipProven(this.dataDir, id)) return false;
    return inspectGeneration({ ...(record === 'absent' ? {} : { record }),
      paths: [proof.scratchCleanup.path, ...agentTmpDirLocations(this.dataDir, id)], cwds }).liveness === 'gone';
  }

  commitWorkerExecutionStart(id: string): string {
    const run = this.peek(id);
    if (run?.delegation?.role !== 'worker' || run.delegation.destroy) throw new Error('Worker cannot start');
    const prior = this.readWorkerExecution(id);
    if (prior?.abandoned) throw new Error('Worker execution was abandoned; spawn a new worker instead of resuming it');
    if (!prior || (prior.phase !== 'queued' && prior.phase !== 'complete')) {
      throw new Error('Worker execution checkpoint does not prove safe admission');
    }
    if (!this.workerResourcesSafe(id, prior.generation, run.delegation.workspace.resourceId, true)) {
      throw new Error('Worker resources may still be held by a process; reuse is not proven safe');
    }
    const generation = randomUUID();
    // #469: the controller is durable before `starting`, so a crash leaves a provable generation.
    this.writeWorkerProcesses(id, { generation, controller: { pid: process.pid, ...startToken(process.pid) }, processes: [] });
    this.writeWorkerExecution(id, { generation, phase: 'starting' });
    return generation;
  }

  /** Private process record (#469): which processes a generation spawned, never part of run JSON or SSE. */
  private processesPath(id: string): string {
    if (isWindowsWorkerEvidence) return windowsEvidencePath(this.dataDir, id, 'processes');
    return this.executionPath(id).replace(/\.execution\.json$/, '.processes.json');
  }

  /** Tri-state: only ENOENT is `absent` (legacy, scan-only). A present record that is unreadable,
   * wrongly permissioned, malformed or of another generation is `unknown`: never finalized or reaped. */
  readWorkerProcesses(id: string, generation: string): WorkerProcessRecord | 'absent' | 'unknown' {
    try {
      if (isWindowsWorkerEvidence) {
        const content = readWindowsEvidence(this.dataDir, id, 'processes', 8192);
        if (content === undefined) return 'absent';
        const record = workerProcessRecordSchema.parse(JSON.parse(content));
        return record.generation === generation ? record : 'unknown';
      }
      const record = workerProcessRecordSchema.parse(JSON.parse(readPrivateWorkerFile(this.processesPath(id), 8192)));
      return record.generation === generation ? record : 'unknown';
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'; }
  }

  private writeWorkerProcesses(id: string, record: WorkerProcessRecord): void {
    if (isWindowsWorkerEvidence) { writeWindowsEvidence(this.dataDir, id, 'processes', JSON.stringify(workerProcessRecordSchema.parse(record))); return; }
    replacePrivateWorkerFile(this.processesPath(id), JSON.stringify(workerProcessRecordSchema.parse(record)));
  }

  /** Bound to the current generation. Past the cap the record never drops an entry: the
   * working-directory scan is the remaining evidence. */
  appendWorkerProcess(id: string, generation: string, pid: number, pgid?: number): boolean {
    const record = this.readWorkerProcesses(id, generation);
    if (typeof record === 'string' || this.readWorkerExecution(id)?.generation !== generation) return false;
    const entry: RecordedProcess = { pid, ...startToken(pid), ...(pgid === undefined ? {} : { pgid }) };
    if (record.processes.some(known => known.pid === entry.pid && known.startToken === entry.startToken)) return true;
    if (record.processes.length >= WORKER_PROCESS_CAP) return false;
    this.writeWorkerProcesses(id, { ...record, processes: [...record.processes, entry] });
    return true;
  }

  commitWorkerExecutionComplete(id: string, generation: string): boolean {
    const proof = this.readWorkerExecution(id);
    if (!proof || proof.generation !== generation) return false;
    if (proof.phase === 'queued' && this.peek(id)?.status !== 'cancelled') return false;
    try {
      const run = this.peek(id);
      if (run?.delegation?.role !== 'worker') return false;
      this.commitIndex(new Map([[id, run]]));
      if (this.readWorkerExecution(id)?.generation !== generation) return false;
      this.writeWorkerExecution(id, { generation, phase: 'complete',
        // Nothing abandons an execution any more (hearsay-tools/cezarion#889); keep a checkpoint that already was.
        ...(proof.abandoned ? { abandoned: true as const } : {}),
        ...(proof.phase === 'queued' || proof.neverMaterialized ? { neverMaterialized: true as const } : {}),
        ...(!['queued', 'running', 'waiting'].includes(run.status) ? { scratchCleanup: {
          resourceId: run.delegation.workspace.resourceId, path: run.delegation.workspace.path } } : {}) });
      // The earlier index event cannot attest exit: subscribers must observe the
      // durable private proof before a terminal worker can satisfy a lifecycle wait.
      this.emit('run', this.peek(id)!);
      return true;
    } catch { return false; }
  }

  /** Cancellation must hit disk before queued no-start evidence authorizes cleanup. */
  commitWorkerCancellation(id: string): void {
    const run = this.peek(id);
    if (run?.delegation?.role !== 'worker') throw new Error('Worker not found');
    this.commitIndex(new Map([[id, { ...run, status: 'cancelled' as const, finishedAt: new Date().toISOString() }]]));
  }

  /** Complete replacement evidence can stand in for absent child history, never for a present execution. */
  readDeletedWorkerResult(parentId: string, workerId: string): WorkerCollectedResult | undefined {
    if (this.hasRun(workerId)) return undefined;
    const parent = this.peek(parentId);
    if (parent?.delegation?.role !== 'root' || parent.delegation.historyDeletion) return undefined;
    const deletion = parent.delegation.receipts.find(receipt => receipt.workerId === workerId)?.deletion;
    if (deletion?.phase !== 'complete') return undefined;
    const result = this.readWorkerResult(parentId, workerId);
    return result?.settled && ['review', 'done', 'failed', 'cancelled'].includes(result.status) &&
      result.cleanup === 'complete' && result.revision === deletion.revision &&
      result.workspace.resourceId === deletion.resourceId ? result : undefined;
  }

  /** A deleted child's receipt replaces the private proof only after the deletion checkpoint. */
  private workerDeletionEvidence(id: string): boolean {
    const child = this.peek(id);
    if (child?.delegation?.role !== 'worker' || child.delegation.workspace.ownerRunId !== id ||
      child.delegation.destroy?.phase !== 'complete' || child.delegation.destroy.remaining.length ||
      !['review', 'done', 'failed', 'cancelled'].includes(child.status)) return false;
    return this.workerDeletionResult(id, child as RunRecord & { delegation: Extract<DelegationState, { role: 'worker' }> });
  }

  private workerDeletionResult(id: string, child: RunRecord & { delegation: Extract<DelegationState, { role: 'worker' }> }): boolean {
    const parent = this.peek(child.delegation.parentRunId);
    if (parent?.delegation?.role !== 'root' || parent.delegation.historyDeletion) return false;
    const receipt = parent.delegation.receipts.find(entry => entry.workerId === id);
    const result = this.readWorkerResult(parent.id, id);
    if (!receipt || !result?.settled || result.cleanup !== 'complete' || result.status !== child.status ||
      result.revision !== (child.delegation.executionRevision ?? 0)) return false;
    const { state: _state, ...workspace } = result.workspace;
    if (JSON.stringify(workspace) !== JSON.stringify(child.delegation.workspace)) return false;
    return workerDeletionProof(receipt.deletion, result.revision, workspace.resourceId, {
      readProof: () => this.readWorkerExecution(id), resourcesSafe: generation => this.workerResourcesSafe(id, generation, workspace.resourceId),
      scratchMayExist: () => agentTmpDirMayExist(this.dataDir, id), executionAbsent: () => executionEvidenceAbsent(this.dataDir, id, this.executionPath(id)),
    });
  }

  canDeleteRun(id: string): boolean {
    if (autosaveCleanupBlocker(this.dataDir, id)) return false;
    const run = this.peek(id);
    if (run?.delegation?.role === 'invalid') return false;
    if (run?.delegation?.role === 'worker') return this.workerDeletionEvidence(id);
    const privateWorkers = workerEvidenceRunIds(this.dataDir);
    if (!privateWorkers || privateWorkers.includes(id)) return false;
    if (run?.delegation?.role === 'root') {
      if (run.delegation.finishRequestedAt && ['queued', 'running', 'waiting'].includes(run.status)) return false;
      // Keep the parent's receipt and result ownership until each child history is explicitly removed.
      if (this.listWorkersOf(id).length > 0) return false;
      return run.delegation.receipts.every(receipt => {
        if (this.hasRun(receipt.workerId) || receipt.deletion?.phase !== 'complete') return false;
        // A pending parent deletion already validated the results before removing their bytes.
        if (run.delegation?.role === 'root' && run.delegation.historyDeletion === 'pending') return true;
        return this.readDeletedWorkerResult(id, receipt.workerId) !== undefined;
      });
    }
    return this.listWorkersOf(id).length === 0;
  }

  /** Delegated history deletion is synchronous and checkpointed; any failed byte/index removal remains retryable. */
  private deleteDelegatedRun(id: string): boolean {
    const run = this.peek(id)!;
    try {
      if (run.delegation?.role === 'worker') {
        const parent = this.peek(run.delegation.parentRunId)!;
        if (parent.delegation?.role !== 'root') return false;
        const receipt = parent.delegation.receipts.find(entry => entry.workerId === id)!;
        const result = this.readWorkerResult(parent.id, id)!;
        const deletion = receipt.deletion ?? { phase: 'pending' as const, revision: result.revision,
          resourceId: run.delegation.workspace.resourceId, generation: this.readWorkerExecution(id)!.generation };
        this.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation,
          receipts: parent.delegation.receipts.map(entry => entry.workerId === id ? { ...entry, deletion } : entry),
        } }]);
        // Do not advertise artifact bytes as retained while interrupted deletion is in progress.
        this.commitWorkerResult(parent.id, { ...result, observedAt: new Date().toISOString(),
          diff: result.diff.state === 'available' ? { ...result.diff, snapshotId: randomUUID() } : result.diff,
          artifacts: result.artifacts.state === 'available' ? { ...result.artifacts,
            items: result.artifacts.items.map(item => ({ state: 'unavailable' as const, reason: 'unreadable' as const,
              detail: 'History deletion is in progress', id: item.id, path: item.path })),
          } : result.artifacts,
        }, this.readWorkerResultDiff(parent.id, id));
        this.removeRunHistoryBytes(id);
        // Delete scratch while its generation evidence still exists; failed removal keeps it.
        removeAgentTmpDir(this.dataDir, id);
        if (agentTmpDirMayExist(this.dataDir, id)) return false;
        // Private process/account evidence is now replaced by the exact parent receipt.
        if (isWindowsWorkerEvidence) {
          removeWindowsEvidence(this.dataDir, id, 'identity');
          removeWindowsEvidence(this.dataDir, id, 'processes');
          removeWindowsEvidence(this.dataDir, id, 'execution');
        } else {
          rmSync(this.identityPath(id), { force: true });
          rmSync(this.processesPath(id), { force: true });
          rmSync(this.executionPath(id), { force: true });
        }
        const retained = this.readWorkerResult(parent.id, id)!;
        this.commitWorkerResult(parent.id, { ...retained, observedAt: new Date().toISOString(),
          diff: retained.diff.state === 'available' ? { ...retained.diff, snapshotId: randomUUID() } : retained.diff,
          artifacts: retained.artifacts.state === 'available' ? { ...retained.artifacts,
            items: retained.artifacts.items.map(item => ({ state: 'deleted' as const, reason: 'missing' as const, id: item.id, path: item.path })),
          } : retained.artifacts,
        }, this.readWorkerResultDiff(parent.id, id));
        this.commitIndex(new Map<string, RunRecord | null>([[parent.id, { ...parent, delegation: { ...parent.delegation,
          receipts: parent.delegation.receipts.map(entry => entry.workerId === id ? { ...entry, deletion: { ...deletion, phase: 'complete' as const } } : entry),
        } }], [id, null]]));
      } else if (run.delegation?.role === 'root') {
        this.commitDelegation([{ id, delegation: { ...run.delegation, historyDeletion: 'pending' } }]);
        this.removeRunHistoryBytes(id);
        rmSync(join(this.dataDir, 'runs', `${id}-worker-results`), { recursive: true, force: true });
        this.commitIndex(new Map([[id, null]]));
      } else return false;
      removeAgentTmpDir(this.dataDir, id);
      this.seqs.delete(id);
      return true;
    } catch { return false; }
  }

  private removeRunHistoryBytes(id: string): void {
    // Fixed owned paths only: never follow context descriptors supplied in persisted metadata.
    z.uuid().parse(id);
    const dir = join(this.dataDir, 'runs');
    if (realpathSync(dir) !== resolve(dir)) throw new Error('History storage redirected');
    this.facts.forget(id);
    removeHistory(this.dataDir, id);
    rmSync(this.handoffPath(id), { force: true });
    rmSync(this.imagesDir(id), { recursive: true, force: true });
    removeArtifacts(this.dataDir, id);
    clearAutosaveCleanup(this.dataDir, id);
  }

  deleteRun(id: string): boolean {
    if (!this.canDeleteRun(id)) return false;
    const run = this.peek(id);
    if (run && this.db && (this.quarantined.has(id) || !this.claimFamilies([familyKey(run)]).size)) return false;
    if (run?.delegation?.role === 'worker' || run?.delegation?.role === 'root') return this.deleteDelegatedRun(id);
    if (run) clearAutosaveCleanup(this.dataDir, id);
    const existed = run !== undefined;
    this.held.delete(id);
    if (existed) {
      this.markDeleted(id, familyKey(run));
      removeAgentTmpDir(this.dataDir, id);
      this.seqs.delete(id);
      this.scheduleSave();
      this.emit('deleted', id);
    }
    return existed;
  }

  /** Write the pending rows out now (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  // ---- internals -----------------------------------------------------------

  private seqs = new Map<string, number>();

  private nextSeq(runId: string): number {
    const next = (this.seqs.get(runId) ?? this.rehydrateSeq(runId)) + 1;
    this.seqs.set(runId, next);
    return next;
  }

  /** After a restart the in-memory counter is empty while the run's NDJSON file
   *  keeps the history. Restarting from 1 would collide with the seqs a client
   *  already replayed — its `seq > maxSeq` dedup then silently drops every
   *  resumed event, even across a reload (the frozen-transcript symptom class
   *  of #424). One file read on the first post-restart append per run. */
  private rehydrateSeq(runId: string): number {
    return this.transcriptFacts(runId).lastSeq;
  }

  private eventsPath(runId: string): string {
    return historyPaths(this.dataDir, runId).plain;
  }

  /** Same location `handoffPath()` in handoff.ts produces — inlined to keep
   *  the store free of upward imports. */
  private handoffPath(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}.handoff.md`);
  }

  /** Agent screenshots persisted by the run manager (see persistImage). */
  private imagesDir(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}-images`);
  }

  private touch(run: RunRecord): void {
    this.dirty.add(run.id);
    this.scheduleSave();
    this.emit('run', run);
    this.maybeEnqueueHistoryCompress(run);
  }

  /** Form follows archived: a terminal archived run with a plain transcript is queued again. */
  private maybeEnqueueHistoryCompress(run: RunRecord): void {
    if (run.archived && !isLiveStatus(run.status) && hasPlainHistory(this.dataDir, run.id)) {
      this.compressor.enqueue(run.id);
    }
  }

  /** The held record is gone; the next save or commit deletes its row, fenced by `family`'s claim
   *  and by the revision this store last saw (kept in `base` until the delete is written). */
  private markDeleted(id: string, family: string): void {
    this.liveItems.forget(id);
    const read = this.coldBase.get(id);
    if (!this.base.has(id) && read) this.base.set(id, storedRow(read));
    this.dirty.delete(id);
    this.deleted.add(id);
    this.deletedFamilies.set(id, family);
    this.historyOwed.add(id);
  }

  /** A deleted run's history files, once the delete of its row has committed. Best effort, as
   *  deletion always was. */
  private removeOwedHistory(id: string): void {
    if (!this.historyOwed.delete(id)) return;
    try {
      this.facts.forget(id);
      removeHistory(this.dataDir, id);
      rmSync(this.handoffPath(id), { force: true });
      rmSync(this.imagesDir(id), { recursive: true, force: true });
      removeArtifacts(this.dataDir, id);
    } catch { /* best effort */ }
  }

  /**
   * Count-based history retention: of the runs past the newest `MAX_RUNS_KEPT` unarchived ones,
   * archive each finished run without delegation that is not pinned and whose family this store
   * can claim. Ranked over the row keys (the `created_at` index, no record decoded) with memory
   * laid over them, since a run created or archived since the last save has no row yet; the rows
   * past the cut are then filtered in `runs.db`, so only real candidates decode. Archived runs
   * are never deleted by retention — only an explicit delete, worker destruction, or history
   * deletion removes a run.
   */
  private pruneOldRuns(): void {
    const ranked = new Map<string, ListOrder & { id: string }>();
    for (const key of this.db?.listKeysWhere('archived = ?', [0]) ?? []) {
      if (!this.held.has(key.id) && !this.deleted.has(key.id)) ranked.set(key.id, key);
    }
    for (const run of this.held.values()) if (!run.archived) ranked.set(run.id, { id: run.id, ...this.listOrder(run) });
    const overflow = [...ranked.values()].sort(newestFirst).slice(MAX_RUNS_KEPT).map((key) => key.id);
    if (overflow.length === 0) return;
    const stale = overflow.flatMap((id) => {
      const run = this.held.get(id);
      // Retention must not archive a live task between turns, a pinned run, or a delegation
      // family whose history is promised until explicit deletion.
      return run && !isLiveStatus(run.status) && !run.delegation && !run.pinned ? [id] : [];
    });
    const cold = overflow.filter((id) => !this.held.has(id));
    if (cold.length > 0) {
      // Another process's runs are its own to keep or archive (#779, plan step 3).
      const rows = this.db!.listWhere(RETENTION_CANDIDATES_SQL, [JSON.stringify(cold)]);
      const writable = this.claimFamilies(rows.map(rowFamily));
      for (const row of rows) if (writable.has(rowFamily(row))) stale.push(row.id);
    }
    for (const id of stale) {
      const run = this.record(id);
      if (!run || run.archived) continue;
      this.applyArchived(run, true);
      removeAgentTmpDir(this.dataDir, id);
    }
  }

  /** Debounced so token-usage updates don't rewrite a row per event. Nothing to schedule without
   *  a database: a `RunStore.unavailable` store, or a closed one, writes nothing. */
  private scheduleSave(): void {
    if (this.saveTimer || !this.db) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
    this.saveTimer.unref?.();
  }

  /** The single database write, so a test can fail it the way a full disk would. */
  private writeIndex(changes: RunDatabaseChanges): RunDatabaseCommit {
    return this.db!.transaction(changes);
  }

  /**
   * Write `staged` plus everything still pending — dirty rows from memory, deletions — in one
   * transaction, then clear the pending marks. Throws with nothing cleared when it fails.
   * Never copies or sorts the whole store: the cost is the rows that changed.
   *
   * Fenced (#779, plan step 3): the transaction commits only if every family it writes still
   * carries this store's claim and every row is at the revision this store last saw. Otherwise
   * nothing is written and `handleConflicts` deals with the rows that changed under it.
   */
  private persist(staged: ReadonlyMap<string, RunRecord | null>): void {
    const upserts: RunRowInput[] = [];
    const deletes: string[] = [];
    const families = new Map<string, string>();
    const extras = new Map<string, RawExtras | undefined>();
    const encode = (run: RunRecord) => {
      const encoded = encodeRawRecord(run, (this.base.get(run.id) ?? this.coldBase.get(run.id))?.extras);
      extras.set(run.id, encoded.extras);
      const projected = { ...run };
      restoreOriginatingIssue(projected);
      upserts.push({ ...encodeRunRow(run, encoded.data),
        issueAttributionCurrent: isDeepStrictEqual(projected, run) });
    };
    for (const [id, next] of staged) {
      if (next) encode(next);
      else deletes.push(id);
      families.set(id, next ? familyKey(next) : this.familyOf(id));
    }
    for (const id of this.dirty) {
      const run = this.held.get(id);
      if (!run || staged.has(id)) continue;
      encode(run);
      families.set(id, familyKey(run));
    }
    for (const id of this.deleted) {
      if (staged.has(id)) continue;
      deletes.push(id);
      families.set(id, this.familyOf(id));
    }
    // A row's insertion order (`seq`) is the order this write inserts it in, and it is where the
    // run lists among runs created in the same millisecond. Insert new runs in creation order (the
    // held set's, then staged runs not held yet), whether staged or dirty brought them here.
    if (upserts.filter((row) => !this.base.has(row.id)).length > 1) {
      const created = new Map<string, number>();
      for (const id of [...this.held.keys(), ...staged.keys()]) if (!created.has(id)) created.set(id, created.size);
      upserts.sort((a, b) => created.get(a.id)! - created.get(b.id)!);
    }
    // A held run whose write moved it into a new family (a worker quarantined to `invalid`) takes
    // that family's claim first; one it cannot take fails the fence below as claim-lost.
    const moved = [...new Set(families.values())].filter((family) => !this.claimed.has(family) && !this.pendingClaims.has(family));
    if (moved.length > 0) this.claimFamilies(moved, { allowLive: true });
    let commit: RunDatabaseCommit;
    try {
      commit = this.writeIndex({ upserts, deletes, ...(this.owner ? { fence: this.fence(families) } : {}) });
    } catch (error) {
      if (error instanceof RunConflictError) this.handleConflicts(error, staged);
      throw error;
    }
    for (const [family, generation] of commit.claims) {
      this.claimed.set(family, generation);
      this.pendingClaims.delete(family);
    }
    for (const row of upserts) {
      this.base.set(row.id, { revision: commit.revisions.get(row.id)!, seq: commit.seqs.get(row.id)!, data: row.data, extras: extras.get(row.id) });
    }
    for (const id of deletes) {
      this.liveItems.forget(id);
      this.base.delete(id);
      this.deletedFamilies.delete(id);
      this.removeOwedHistory(id);
    }
    this.dirty.clear();
    this.deleted.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** What a write of these rows (id → family) must still find: this store's claims, at the
   *  generations it took them, and each row at the revision it last saw (none for a new row). */
  private fence(families: ReadonlyMap<string, string>): RunWriteFence {
    const claims = new Map<string, RunFenceClaim>();
    const rows = new Map<string, { revision: number | null; family: string }>();
    for (const [id, family] of families) {
      const pending = this.pendingClaims.get(family);
      // Generations start at 1, so an unclaimed family's 0 fails the fence as claim-lost.
      claims.set(family, pending !== undefined ? { take: pending } : { generation: this.claimed.get(family) ?? 0 });
      rows.set(id, { revision: (this.base.get(id) ?? this.coldBase.get(id))?.revision ?? null, family });
    }
    return { owner: this.owner!, claims, rows };
  }

  /**
   * Handle a fenced-write conflict. Save unexpected conflict evidence before clearing pending
   * state or quarantining the row. If evidence persistence fails, retain pending writes. Other
   * rows remain writable; stale unclaimed reads only fail their write.
   */
  private handleConflicts(error: RunConflictError, staged: ReadonlyMap<string, RunRecord | null>): void {
    const unexpected = error.conflicts.filter((conflict) =>
      this.held.has(conflict.id) || this.deleted.has(conflict.id) || this.coldBase.get(conflict.id)?.owned === true);
    if (unexpected.length === 0 || !this.db || !this.owner) return;
    const evidence: RunConflictEvidence[] = unexpected.map((conflict) => {
      const seen = this.base.get(conflict.id) ?? this.coldBase.get(conflict.id);
      const local = staged.has(conflict.id) ? staged.get(conflict.id)! : this.deleted.has(conflict.id) ? null : this.held.get(conflict.id) ?? null;
      return {
        runId: conflict.id, reason: conflict.reason,
        baseRevision: seen?.revision ?? null, baseData: seen?.data ?? null,
        localData: local === null ? null : JSON.stringify(local), localDeleted: local === null,
        currentRevision: conflict.current?.revision ?? null, currentData: conflict.current?.data ?? null,
      };
    });
    let seqs: number[];
    try {
      seqs = this.db.recordConflicts(this.owner.session, evidence);
    } catch (evidenceError) {
      const message = evidenceError instanceof Error ? evidenceError.message : String(evidenceError);
      console.error(`[cez] ${RUNS_DB_FILE}: could not record the conflicting write on ${unexpected.map((c) => c.id).join(', ')}; it stays pending: ${message}`);
      return;
    }
    unexpected.forEach((conflict, index) => {
      const family = this.familyOf(conflict.id);
      this.liveItems.forget(conflict.id);
      this.quarantined.add(conflict.id);
      this.dirty.delete(conflict.id);
      this.deleted.delete(conflict.id);
      this.deletedFamilies.delete(conflict.id);
      // The delete did not happen, so the history stays with the row.
      this.historyOwed.delete(conflict.id);
      if (conflict.reason === 'claim-lost') {
        this.claimed.delete(family);
        this.pendingClaims.delete(family);
      }
      const decoded = conflict.current ? decodeRunRow(conflict.current.data) : undefined;
      const current = decoded?.run;
      const held = this.held.get(conflict.id);
      if (current && conflict.current) {
        // The other writer's record as it stands, normalized only as a live owner's run would be.
        reconcileLoadedRun(current, { keepLive: true });
        rescopeRun(current, this.repoHandle);
        if (held) replaceRecord(held, current);
        this.base.set(conflict.id, { revision: conflict.current.revision, seq: conflict.current.seq, data: conflict.current.data, extras: decoded!.extras });
        this.emit('run', held ?? current);
      } else {
        this.held.delete(conflict.id);
        this.base.delete(conflict.id);
        this.emit('deleted', conflict.id);
      }
      console.error(`[cez] run ${conflict.id} was changed by another writer (${conflict.reason}); this process will not write it again until cezar restarts. Evidence: ${join(this.dataDir, RUNS_DB_FILE)}, table run_conflicts, seq ${seqs[index]}.`);
    });
    this.scheduleSave();
  }

  /** Write what is pending, then (unless closing) let every run whose write settled leave memory. */
  private saveNow(evict = true): void {
    if (!this.db) return;
    // A second attempt only after a conflict excluded its rows: the unrelated rest goes out at once.
    for (let attempt = 0; attempt < 2 && (this.dirty.size > 0 || this.deleted.size > 0); attempt++) {
      const quarantined = this.quarantined.size;
      try {
        this.persist(new Map());
      } catch (err) {
        if (err instanceof RunConflictError && this.quarantined.size > quarantined) continue;
        // A pending save may outlive its directory; never recreate it or hide live-directory
        // failures. The rows stay pending (and held), so the next save or commit retries them.
        if (existsSync(this.dataDir)) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[cez] failed to save ${RUNS_DB_FILE}: ${message}`);
        }
        break;
      }
    }
    if (evict) this.evictSettled();
  }

  /**
   * Write what is pending and release the database (store disposal, process shutdown).
   * Idempotent. A closed store keeps answering reads for what it holds — the final save evicts
   * nothing — but cannot read `runs.db` any more, so a run that had already left memory reads as
   * absent. It saves nothing more, and a durable commit on it throws.
   */
  close(): void {
    this.liveItems.clear();
    // Demand-bound feeds stop before storage disappears during project removal/shutdown.
    this.emit('closed');
    this.compressor.stop();
    this.facts.stop();
    this.facts.flush();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow(false);
    if (this.db && this.owner) {
      // Every claim goes with the store. Should the release fail, the claims stay until this
      // process exits; from then on they are provably dead and the next opener takes them.
      try { this.db.releaseClaims(this.owner.session); } catch { /* see above */ }
    }
    this.claimed.clear();
    this.pendingClaims.clear();
    if (this.owner) closeClaimSession(this.owner.session);
    this.db?.close();
    this.db = null;
  }
}

export interface ArchiveOnMergeSnapshot {
  rootId: string;
  fingerprint: string;
  pullRequests: ArchivePullRequestIdentity[];
  token: string;
}
function archiveDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function archiveFields(run: RunRecord, archived: boolean, now: string): void {
  run.archived = archived;
  run.archivedAt = archived ? now : undefined;
  if (archived) { clearPendingAutoResume(run); clearPin(run); }
  else run.manualUnarchivedAt = now;
}
