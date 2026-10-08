import { EventEmitter } from 'node:events';
import { workerEvidenceRunIds, workerExecutionSchema, type WorkerExecution } from './worker-execution.ts';
import { agentTmpDirLocations, agentTmpDirMayExist, agentTmpDirOwnershipProven, removeAgentTmpDir } from './agent-tmpdir.ts';
import { removeArtifacts } from '../artifacts/lifecycle.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, readdirSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ciWaitSchema, agentInputSchema, inboxClaimSchema, delegationStateSchema, workerCreationReceiptSchema, workerCollectedResultSchema, workerResultFileSchema,
  continuationMessageSchema, previewServerSchema, toRunSummary, workerDestroyRetrySchema,
  runRecordSchema as contractRunRecordSchema,
} from '@open-mercato/cezar-contract';
import type { ArchiveFinishedScope, ArchivedRunsResponse, CiWait, ConversationState, AgentInput, InboxClaim, DelegationState, RunSummary, WorkerCollectedResult, WorkerDestroyRetry } from '@open-mercato/cezar-contract';
import { matchesRunQuery, sqlPrefilterTokens } from './run-search.ts';
import { storedDelegationStateSchema } from './delegation-state.ts';
import { HistoryCompressor } from './history-compressor.ts';
import { emptyFacts, stampOf, TranscriptFactsIndex, type TranscriptFacts } from './transcript-facts.ts';
import { hasPlainHistory, historyPaths, readHistoryText, readHistoryTextAsync, removeHistory, restoreHistory } from './history-file.ts';
import { workerExecutionIdentitySchema, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { reconcileWorkerWait } from '../delegation/wait.ts';
import { capacityError, workerCapacity } from '../delegation/capacity.ts';
import { inspectGeneration, isCurrentProcess, recordedProcessLive, processStartToken, type CwdSource, type RecordedProcess, type WorkerProcessRecord } from '../delegation/process-liveness.ts';
import { collectSecretValues, redactDeep, redactSecrets } from '../core/secret-redaction.ts';
// Pure, dependency-free reference helpers — the same sanity bound the marker parser applies.
import { MAX_REF } from './task-refs.ts';
// Type-only module (zod + nothing else), so this cannot cycle back into the store.
import { workflowDefSchema } from '../workflows/types.ts';

import { RUNNER_IDS } from '../core/agent-runner.ts';
import {
  ARCHIVED_ROOT, RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunConflictError, RunDatabase, RunDatabaseBusyError,
  type RunConflictEvidence, type RunDatabaseChanges, type RunDatabaseCommit, type RunFenceClaim, type RunRow, type RunRowInput, type RunWriteFence,
} from './run-database.ts';
import { encodeRunRow, isLiveRecord, isLiveStatus } from './run-row.ts';
import { collectRawExtras, encodeRawRecord, type RawExtras } from './raw-record.ts';
import { assertNoLegacyCockpit, assertNoLegacyWriter, backUpLegacyIndex, LEGACY_INDEX_FILE, LegacyWriterError, readLegacyIndex } from './legacy-index.ts';
import { RunStoreOpenError, toRunStoreOpenError } from './store-open-error.ts';
import { claimOwnerLive, closeClaimSession, openClaimSession, type ClaimOwner } from './run-claims.ts';

import type { RunnerId } from '../core/agent-runner.ts';

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
/**
 * A sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490):
 * the agent ended its turn still working on its own downstream work (a sub-agent
 * or a monitored command) and declared it with the `CEZ:MONITORING` marker — so
 * the cockpit shows a non-attention "monitoring" label instead of "needs you".
 * Only ever set while `status === 'running'`; cleared on resume/terminal.
 */
export type RunActivity = 'monitoring';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

const usageCounterSchema = z.number().finite().nonnegative();

/**
 * A runner id as it may appear in a PERSISTED record, normalized to the three
 * ids the rest of cezar speaks (#547).
 *
 * `claude-cli` is the legacy spelling of `claude` — still a member of
 * `AgentBackend` and still accepted by `createRunner`, and named by
 * `BACKWARD_COMPATIBILITY.md` §3 as an id `runs.json` keeps parseable. The enum
 * here did not accept it, so that promise was false: the loader `safeParse`s the
 * WHOLE array, so one record carrying it would have dropped every run in the
 * file — the exact failure mode §3 exists to warn about.
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

const stepStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'check']),
  status: z.enum(['pending', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled', 'skipped']),
  iterations: z.number(),
  /** Durable count of onFail retry loops consumed by this check. */
  retriesUsed: z.number().int().nonnegative().optional(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
  usageInvocationsStarted: usageCounterSchema.optional(),
  usageInvocationsObserved: usageCounterSchema.optional(),
  usageTurnsStarted: usageCounterSchema.optional(),
  usageTurnsRecorded: usageCounterSchema.optional(),
  usageInvocationEpoch: usageCounterSchema.optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Latest backend-owned session id, used for same-backend Continue. */
  sessionId: z.string().optional(),
  sessionTransport: z.enum(['cursor-acp', 'cursor-print']).optional(),
  /** Backend that owns `sessionId`. Optional so pre-affinity runs.json files still parse;
   *  `storedRunnerSchema` so a legacy `claude-cli` folds to `claude` instead of failing (#547). */
  backend: storedRunnerSchema.optional(),
  /** Agent profile (account) this step actually spawned under — `default`, or a stored profile
   *  id (spec 2026-07-29-agent-profiles). Recorded rather than re-derived because a session id
   *  only means something inside the config dir that created it: `sessionId` and `profileId` are
   *  a PAIR. Without it, changing the project's account would silently make Continue resume
   *  against the wrong account's session store. Absent = the discovered default. */
  profileId: z.string().optional(),
  /** Dollar cost reported by the claude CLI for this step's turns. */
  costUsd: z.number().optional(),
  /** Explicit provenance for engine-generated continuation steps. */
  synthetic: z.literal('continuation').optional(),
});

/** One prompt message stacked onto a run while it waits for a free agent slot
 *  (#472). Folded into `{{task}}` at dequeue by `hydrateQueuedInput`; never
 *  delivered as its own turn — a follow-up turn would reach only the first step
 *  of a chain and would race the opening turn. */
const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** `/api/v1/runs/:id/images/…` URLs — the base64 never enters `runs.json`. */
  images: z.array(z.string()).optional(),
  createdAt: z.string(),
});

/** Exported for `./run-index.ts`, the read-only reader of the same records. Nothing else should
 *  parse a stored run — see `reconcileLoadedRun` for why a second parser is a correctness risk. */
export const runRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Display title (#389): the auto-derived summary of the first agent turn,
   *  or the user's inline edit (`PATCH /api/runs/:id` sets it together with
   *  `title` so edits always win). The UI shows `titleSummary ?? title`. */
  titleSummary: z.string().optional(),
  /** `git diff --shortstat` of the worktree vs its base, refreshed on every
   *  turn-end (#389) — what the quick list / table shows without a git call.
   *  `repointed` (#751) is optional and only ever written as `true`: it marks the
   *  runs whose numbers were narrowed to uncommitted work because the agent had
   *  checked another branch out into the worktree. Optional is load-bearing here —
   *  `runs.json` is `safeParse`d as one array, so a required addition would
   *  silently drop every pre-existing run. */
  diffStat: z
    .object({
      adds: z.number(),
      dels: z.number(),
      files: z.number(),
      repointed: z.boolean().optional(),
    })
    .optional(),
  workflow: z.string(),
  task: z.string(),
  /** Prompt messages stacked onto this run while it was queued (#472). Optional:
   *  `undefined` on every pre-#472 record reads as an empty stack. Like `task`,
   *  `text` is the user's own prompt and is replayed into `{{task}}`, so it is
   *  deliberately NOT in `redactPatch`'s field list — scrubbing it would corrupt
   *  the run the same way scrubbing `task` would. */
  queuedMessages: z.array(queuedMessageSchema).optional(),
  /** Durable Continue opening message; id is its synthetic step id. No base64 in the index. */
  continuationMessage: continuationMessageSchema.optional(),
  /** A malformed explicit ASK must never be collected as worker success. */
  invalidAsk: z.boolean().optional(),
  delegation: storedDelegationStateSchema,
  /** Non-human input must retain attribution through restart, separately from human answers. */
  agentInputs: z.array(agentInputSchema).optional(),
  ciWait: ciWaitSchema.optional(),
  lastCiWait: ciWaitSchema.optional(),
  /** Retained recovery observation when previous CI metadata cannot be trusted. */
  lastCiWaitError: z.string().max(256).optional(),
  /** Dev servers the agent registered with `cezar_preview_serve` (#781). Optional so old files parse. */
  previewServers: z.array(previewServerSchema).optional(),
  /** URLs of images attached to the initial task prompt, for the thread's first bubble
   *  (#image-display) — persisted like agent screenshots, served from `/images/`. */
  taskImages: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Reasoning-effort pin (#45). Canonical `low`/`medium`/`high`/`xhigh`/`max`.
   *  Absent = harness default. Additive: pre-#45 records omit it and still parse. */
  effort: z.string().max(32).optional(),
  /** Canonical provider/model identity (#405) — the normalised `provider/model`
   *  (e.g. `anthropic/claude-opus-4-8`) the run actually used, resolved from the
   *  free-text `model` against the chosen runner. Additive and optional: pre-#405
   *  records carry only `model`, and it stays the human/hand-edit surface; this
   *  is the parseable identity cost attribution and reproducible replay key off.
   *
   *  Read in production by the session header's agent badge (#546), which shows it
   *  whenever it says something `model` does not — so this is no longer a
   *  write-only field whose next reader has to guess whether it is load-bearing. */
  modelIdentity: z.string().optional(),
  /** Agent backend this run used — drives "open in CLI" resume command. `storedRunnerSchema`
   *  so a legacy `claude-cli` record folds to `claude` instead of failing the whole index (#547). */
  runner: storedRunnerSchema.optional(),
  /** Per-task agent-account override from the composer (spec 2026-07-29-agent-profiles), applying
   *  to steps that run on `runner`. Steps on a DIFFERENT backend still resolve from the project's
   *  own selection — an override for Claude says nothing about which Codex account a mixed
   *  workflow's codex step should use. Absent = follow the project. */
  agentProfile: z.string().optional(),
  /** Echo of the extra system prompt this run actually used (R2): the
   *  `POST /api/runs` override, or the `config.json` default it fell back to.
   *  Deliberately NOT the full composed prompt — skill bodies and the handoff
   *  contract are derivable from the persisted workflow and would bloat the
   *  index. Resolved at execute time (a queued run picks up config edits). */
  systemPrompt: z.string().optional(),
  /** Per-task follow-up inbox contract (spec 007, #444). Missing on old runs
   *  means enabled — the historical behavior. */
  generateFollowups: z.boolean().optional(),
  /** Effective autonomous mode (#489), set at creation from StartRunInput.autonomous.
   *  This records the resolved launch mode, not whether a user clicked a checkbox:
   *  the composer may select it through a skill or workspace default (#458).
   *  Used by the autonomous nudge and terminal review policy. Continue/recovery
   *  preserve it; absent on legacy records means non-autonomous. */
  autonomous: z.boolean().optional(),
  /** Task webhook opt-in (#589). Absent = off; `POST /runs/:id/notify` flips it at any time. */
  notify: z.boolean().optional().catch(undefined),
  /** The last task-webhook delivery's outcome (#589), written by `runs/webhook.ts`. */
  webhook: contractRunRecordSchema.shape.webhook.catch(undefined),
  /** Optional provenance for tasks launched by a project GitHub automation. */
  automation: z
    .object({
      automationId: z.string(),
      automationRevision: z.number().int().positive(),
      receiptId: z.string(),
      event: z.string(),
      githubUrl: z.string().url(),
    })
    .optional(),
  /** Provenance for a task a scheduled automation launched. Its own key so a pre-schedule cezar
   *  strips it instead of failing the whole index on a missing `githubUrl`. */
  automationTrigger: z
    .object({
      automationId: z.string(),
      automationRevision: z.number().int().positive(),
      receiptId: z.string(),
      trigger: z.enum(['schedule', 'catch-up', 'manual']),
      occurrenceAt: z.string(),
    })
    .optional(),
  /** A pending worker destroy's automatic retry state (hearsay-tools/cezarion#879); a malformed one is dropped, never the run. */
  destroyRetry: contractRunRecordSchema.shape.destroyRetry.catch(undefined),
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  stopping: contractRunRecordSchema.shape.stopping.catch(undefined),
  /** Sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490):
   *  `monitoring` while the agent is still working on its own downstream work.
   *  Optional/absent on old runs; cleared when the run resumes or ends. */
  activity: z.enum(['monitoring']).optional(),
  hasPendingHumanAsk: contractRunRecordSchema.shape.hasPendingHumanAsk.catch(undefined),
  /** Exact server-computed deadline for the next automatic monitoring check. */
  monitoringWakeAt: z.string().datetime().optional().catch(undefined),
  /** True only for the live epoch that exhausted all automatic monitoring checks. */
  monitoringWakeCapReached: z.boolean().optional(),
  /**
   * Exact deadline at which a run stopped by a provider USAGE LIMIT resumes itself
   * (spec 2026-08-03-auto-resume-after-usage-limit) — the reset instant the provider named plus a
   * short grace. Present only while such a resume is pending: the run is `failed`, the timer is
   * armed, and the cockpit says so. Deliberately survives a restart (`RunStore.open` keeps it) —
   * it is what lets `recover()` re-arm a wait that may be hours long.
   */
  autoResumeAt: z.string().datetime().optional().catch(undefined),
  /** Consecutive automatic resumes since the last human turn — the safety cap's counter.
   *  Persisted so a restart cannot reset a loop back to zero. */
  autoResumeAttempts: z.number().int().min(0).optional().catch(undefined),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
  costUsd: z.number().optional(),
  /** First GitHub PR URL spotted in the transcript (the janitor trick). */
  pullRequestUrl: z.string().optional(),
  /** The PR this task is ABOUT (#407, spec 2026-07-16-pr-autodiscovery):
   *  auto-discovered from conversation references for tasks that work on an
   *  existing PR (review/continue/merge). Display-only tier — `pullRequestUrl`
   *  (the PR this task CREATED) always wins, and action gates ignore this. */
  referencedPullRequestUrl: z.string().optional(),
  /** The PR/issue number this task is ABOUT (spec 2026-07-17-task-auto-naming):
   *  regex-extracted from the task prompt, upgradable by the namer's
   *  cross-checked output. Display tier — never gates actions. */
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  /** Provenance for an `issueNumber` seeded by referenced-issue discovery.
   *  Persisted so ambiguity can revoke only the janitor's own value, including
   *  after a restart. Any prompt, namer, or marker write clears this flag. */
  referencedIssueNumberSeeded: z.boolean().optional(),
  /** Who owns the display title: `user` (PATCH rename — never auto-overwritten),
   *  `marker` (agent-declared via `CEZ:TITLE`, spec 2026-07-18-task-ref-markers —
   *  beats the namer, silences live refresh) or `auto` (namer-owned — a later
   *  namer result may replace it). Missing on old runs = legacy behavior (auto
   *  fills only an unset titleSummary). Precedence: user > marker > auto. */
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  /** References the agent itself declared via `CEZ:PR=` / `CEZ:ISSUE=` markers
   *  (spec 2026-07-18-task-ref-markers). Presence of a kind makes it
   *  authoritative: the namer may no longer write that kind, and a declared PR
   *  owns the referenced tier's resolution. */
  markerRefs: z.object({ pr: z.number().optional(), issue: z.number().optional() }).optional(),
  /** Distinct PR URLs spotted so far — the referenced tier's working set,
   *  persisted so a resumed run keeps disambiguating against the full history
   *  instead of re-adopting the next URL as "the only one". Capped. */
  referencedPrCandidates: z.array(z.string()).optional(),
  /** The issue this task is ABOUT (spec 2026-07-21-report-ref-discovery):
   *  auto-discovered from `github.com/…/issues/N` links in the conversation,
   *  mirroring the referenced-PR tier. Display-only; never gates actions. */
  referencedIssueUrl: z.string().optional(),
  /** Distinct issue URLs spotted so far — the referenced-issue working set,
   *  persisted like `referencedPrCandidates`. Capped. */
  referencedIssueCandidates: z.array(z.string()).optional(),
  /** Explicit execution policy. `false` means the run intentionally uses the repo root;
   *  absent on older runs and for the default isolated-worktree mode. */
  worktree: z.literal(false).optional(),
  /** Task worktree (spec 006) — absent for in-place runs and after explicit cleanup. */
  worktreePath: z.string().optional(),
  /** The task's own branch (`cez/<id8>`), created off `baseBranch`. */
  branch: z.string().optional(),
  /** Stable baseline for session git views: a worktree's fork ref, or an in-place run's starting commit. */
  baseBranch: z.string().optional(),
  /** Set when count-based retention (#483) reclaimed this run's worktree
   *  *directory* (the `cez/<id8>` branch is kept). Presence means "materialized
   *  dir gone, recoverable via `git worktree add`"; it excludes the run from the
   *  retention budget until the dir is re-materialized (resume clears it). */
  worktreeReclaimedAt: z.string().optional(),
  /** Worktree setup (#917). An unreadable value drops the field, never the run. */
  worktreeSetup: contractRunRecordSchema.shape.worktreeSetup.catch(undefined),
  /** Parallel variants (spec 010): tasks sharing a groupId are one group. */
  groupId: z.string().optional(),
  /** Variant letter within the group — 'A' | 'B' | 'C' (kept as a string). */
  variant: z.string().optional(),
  /** Idempotent start (#504): the caller's request id and the hash of the start payload it
   *  named (`src/runs/client-request.ts`). Absent on every run started without one. */
  clientRequestId: z.string().optional(),
  clientRequestHash: z.string().optional(),
  /** Peak resident memory (bytes) / process count observed across the run's
   *  agent process trees (#348) — written when a session's telemetry ends.
   *  Optional: old runs.json files and `ps`-less platforms have neither. */
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  archived: z.boolean().default(false),
  archivedAt: z.string().optional(),
  /** Pinned to the top of this project's task list (#935): plain per-task state, the
   *  same class as `archived` and `seenAt`. Optional with NO default, unlike `archived`:
   *  absent is what every runs.json written before this carries and it already means
   *  "not pinned", so nothing needs filling in on parse and an unpin can simply delete
   *  the key rather than persist a `false` older cezars never wrote. */
  pinned: z.boolean().optional(),
  pinnedAt: z.string().optional(),
  /** Read receipt (#unread-done-items): the ISO time the cockpit last opened this
   *  run's thread. A finished run reads as "unread" until it has been seen since it
   *  finished — see `isUnread()` in the cockpit's `lib/read-state.ts`. Absent on old
   *  runs, on every run not yet opened, and on one `setUnread` put back to unread
   *  (#775) — the unread rule treats all three alike. */
  seenAt: z.string().optional(),
  currentStepId: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(stepStateSchema),
  /** Full workflow definition, persisted so a `queued` run can be re-enqueued
   *  after a restart (#367) — including ad-hoc "(planned)" chains that exist
   *  nowhere else.
   *
   *  Typed, not `z.record(z.string(), z.unknown())`: this key goes out over the
   *  wire on every run route, and `unknown` is wider than anything the server
   *  can serialize — which made the route's own type (hono's `JSONValue`, whose
   *  index signature admits `object | symbol | undefined`) impossible for the
   *  contract to describe. `.catch(undefined)` keeps an older or hand-edited
   *  entry from failing the whole index parse: a def that no longer fits simply
   *  drops, and `reviveWorkflow` falls back to the catalog by name.
   *
   *  That drop is PERMANENT, not per-boot — the index is re-serialized from the
   *  parsed records (`saveNow`), so the next save writes runs.json back without
   *  it. Harmless for a catalog workflow, which re-resolves by name; fatal for
   *  the ad-hoc "(planned)" chain this field exists to preserve, which has no
   *  catalog entry to fall back to. Nothing written since #367 fails the schema
   *  (`name`, `source` and `steps` have been on every persisted def), so tighten
   *  `workflowStepSchema` only with that in mind: a narrowing here silently eats
   *  queued runs rather than degrading them. */
  workflowDef: workflowDefSchema.optional().catch(undefined),
});

/** Salvage CI state identically for live stores and the read-only workspace index. */
export function parseRunRecords(raw: unknown) {
  if (Array.isArray(raw)) for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    if (row.ciWait !== undefined && !ciWaitSchema.safeParse(row.ciWait).success) {
      delete row.ciWait;
      if (['running', 'queued', 'waiting'].includes(row.status)) {
        row.status = 'failed'; delete row.activity;
        row.error = 'CI wait state is unreadable; continue the task to register a new wait.';
      }
    }
    if (row.lastCiWait !== undefined && !ciWaitSchema.safeParse(row.lastCiWait).success) {
      delete row.lastCiWait;
      row.lastCiWaitError = 'CI wait unavailable — saved observation is unreadable; register a new wait.';
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
}

/** A row as this store last read or wrote it (see `RunStore.base`). */
interface StoredRow {
  revision: number;
  /** The row's insertion order, where it lists among runs created in the same millisecond. */
  seq: number;
  data: string;
  extras?: RawExtras;
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
  const parsed = parseRunRecords([raw]);
  if (!parsed.success) return undefined;
  const run = parsed.data[0]!;
  return { run, extras: collectRawExtras(raw, run) };
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
export interface RunEvent {
  seq: number;
  ts: string;
  stepId?: string;
  type: string;
  [key: string]: unknown;
}

/** The pauses between open attempts while the database is busy, when `open` may wait (a boot):
 *  about 3.5 s in all, with each attempt's own busy timeout. Long enough for another process to
 *  finish importing a large `runs.json`. */
const OPEN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

/** Block this thread for `ms`. Only `open` does, at boot, when there is nothing else to run. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

/** `https://github.com/open-mercato/cezar/pull/402` → `open-mercato/cezar`, lowercased.
 *  Undefined for anything that is not a `<host>/<owner>/<repo>/<kind>/<n>` forge URL. */
function refUrlRepo(url: string): string | undefined {
  const parts = url.split('/');
  const owner = parts[parts.length - 4];
  const name = parts[parts.length - 3];
  return owner && name ? `${owner}/${name}`.toLowerCase() : undefined;
}

/**
 * May the referenced tier ADOPT this URL as the task's subject? (#945)
 *
 * The tier was text-scoped but never repo-scoped: `PR_URL_RE` matches any
 * `github.com/<owner>/<repo>/pull/N`, so a research task that cites one upstream PR handed the
 * resolver exactly one candidate and it became the task's identity — an `oko` task wearing
 * `supabase/cli#6056`. Nothing compared the URL's repository with the project's own.
 *
 * A foreign URL is adoptable only when the TASK PROMPT corroborates it: the prompt names that
 * `owner/repo`, which a pasted URL does inherently. That is the trust boundary this module already
 * uses elsewhere — the prompt and the agent's own turn text are trusted, scraped tool output is
 * not — and it is what keeps the legitimate cross-repo case working (#819:
 * `om-auto-fix-pr https://github.com/open-mercato/open-mercato/pull/1977` started from cezar).
 *
 * Unknown handle → today's behavior exactly (`AGENTS.md` zero config: degrade, never fail). An
 * unparseable URL is left alone for the same reason — the guard only ever removes an association
 * it can PROVE is foreign.
 *
 * Note what this does not touch: `referenced*Candidates` keep recording every URL as evidence.
 * The fix changes what is *promoted*, never what is *collected* (the #526 rule).
 */
function isRepoScopedRef(url: string, task: string, handle?: RepoHandle | null): boolean {
  if (!handle) return true;
  const repo = refUrlRepo(url);
  if (!repo) return true;
  if (repo === `${handle.owner}/${handle.name}`.toLowerCase()) return true;
  // Match whole owner/repository segments: naming acme/service2 must not corroborate
  // acme/service. Slashes remain valid boundaries for full URLs and their /pull or /issues path.
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9_.-])${escapedRepo}(?![a-z0-9_.-])`, 'i').test(task);
}

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
  run.autoResumeAt = undefined;
  run.autoResumeAttempts = undefined;
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
 * Where a CREATION CLAIM may come from — the trust boundary the created tier was missing.
 *
 * `CREATED_PR_RE` used to be matched against everything an event carried, tool OUTPUT included,
 * so a transcript that merely QUOTES a `gh pr create` line handed the run a PR it never opened.
 * Not hypothetical: the task that fixed the reference chips printed another run's stored events
 * while investigating them, and cezar read `"title": "Ran gh pr create --repo …"` out of that
 * dump and adopted a PR from a DIFFERENT repository as its own — permanently, because the first
 * created URL wins and the real `gh pr create` that followed was never looked at.
 *
 * So the claim must come from the agent's own words, or from the tool title cezar itself renders
 * from the command it saw run. Tool output and tool input are the transcript of the world, not a
 * statement about this run. The URL is still read from the whole event — `gh` prints it in the
 * output — because it is the CLAIM that needs a trustworthy source, not the link.
 */
function eventCreationClaimFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
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
 * The referenced tier's resolution rule, shared by the PR and issue janitors:
 * a marker-declared number (spec 2026-07-18-task-ref-markers) owns the answer
 * outright — only a candidate URL ending in that number resolves, and a
 * contradiction clears the chip. Without a declaration: one distinct URL is
 * the subject; among several, prefer the exact URL pasted in the prompt, then
 * the one whose number the task prompt names (and
 * only when exactly one matches); otherwise ambiguous — no chip beats a wrong
 * chip.
 *
 * Whatever that produces is then repo-scoped (#945): a winner from another repository that the
 * prompt does not corroborate is vetoed — see `isRepoScopedRef`. The veto is applied to the
 * RESULT rather than to the candidate list on purpose, so the guard stays strictly subtractive:
 * filtering first would let a project-local candidate win a two-candidate race today's rule calls
 * ambiguous, which is a wider behavior change than the defect warrants. As written this function
 * can only ever lose a value, never gain one.
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
 * The PR declaration the REFERENCED tier is allowed to act on.
 *
 * `CEZ:PR=N` means one of two things depending on when the agent writes it: on the way in it
 * names the PR the task is ABOUT, and once the task has opened a PR of its own the marker
 * contract asks it to re-declare with the new number ("Re-emit with the new number if the subject
 * changes (e.g. you open a PR later in the task)"). A declaration naming the PR this run CREATED
 * is therefore a statement about the CREATED tier, which `pullRequestUrl` already carries — and
 * feeding it to the referenced tier ERASES the about-PR, because `resolveReferencedRef` clears
 * the chip when no candidate matches the declared number (a task on #4326 that opened
 * #5366 dropped from two chips to one the moment it declared #5366).
 *
 * Both tiers stay true instead: the created PR is the created PR, and the reference resolves as
 * if that declaration had not been made — which is exactly what it was before the task opened
 * anything.
 */
function referencedPrDeclaration(run: RunRecord): number | undefined {
  const declared = run.markerRefs?.pr;
  if (declared === undefined) return undefined;
  return declared === refUrlNumber(run.pullRequestUrl) ? undefined : declared;
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
  // An accepted Stop is durable intent, never an interrupted run to auto-resume.
  if (run.stopping) {
    run.status = 'cancelled';
    run.finishedAt ??= new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'cancelled';
    }
  }
  run.stopping = undefined;
  // A run that was live when the previous process exited can never finish —
  // surface that instead of a forever-"running" ghost. `review` survives
  // restarts on purpose: the gate is pure data (worktree + branch + record)
  // with no live process, so the diff panel, Send back (resume) and Draft PR
  // all still work.
  if (
    !opts?.keepLive &&
    (run.status === 'running' || run.status === 'queued' || run.status === 'waiting')
  ) {
    run.status = 'failed';
    run.error = 'interrupted — cezar process exited during the run';
    run.finishedAt = run.finishedAt ?? new Date().toISOString();
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'failed';
    }
  }
  if (!['running', 'waiting', 'queued'].includes(run.status)) {
    run.activity = undefined;
    run.monitoringWakeAt = undefined;
  }
  // A pending usage-limit resume survives the restart on purpose (the wait can be
  // hours) — `RunManager.recover()` re-arms it from this field. It can only mean
  // anything on a `failed` run, so anywhere else it is stale bookkeeping.
  if (run.status !== 'failed') run.autoResumeAt = undefined;
  // The wake counter is intentionally process-local, so a restarted process
  // starts a fresh epoch instead of displaying a stale cap.
  run.monitoringWakeCapReached = undefined;
  // Heal a record written before `referencedPrDeclaration` existed: a task that re-declared
  // `CEZ:PR` with the PR it had just CREATED cleared the PR it was ABOUT, because no candidate
  // could match the created number. The evidence is all still on the record — only the
  // conclusion drawn from it was wrong — so re-resolve without that declaration instead of
  // asking for a migration. Deliberately one-directional: it only runs on a record that HAS no
  // referenced PR, so it can never take one away from a record written by an older cezar whose
  // candidate list no longer explains it. `prNumber` is not recoverable this way (the
  // declaration overwrote it) and is left alone — the restored URL is what paints the chip.
  if (
    run.referencedPullRequestUrl === undefined &&
    run.markerRefs?.pr !== undefined &&
    referencedPrDeclaration(run) === undefined
  ) {
    run.referencedPullRequestUrl = resolveReferencedRef(
      run.referencedPrCandidates ?? [],
      run.task,
      undefined,
    );
  }
  // Repository scoping follows reconciliation: stores arm a handle asynchronously, while
  // the read-only index applies its cached handle to these fresh records (#97). This ordering
  // also scopes any referenced PR restored above without filtering candidate evidence first.
  return run;
}

/**
 * Settle a live run whose owning process died, when a control adopts it (#779, plan step 3), so
 * that adopting never starts agent work: only Continue may, with the user's own input. A run that
 * never started is cancelled before it began, which Continue restarts as it would after a Stop (the
 * same "untouched" test as `isUntouchedCancelledRun`); any other live run is interrupted, exactly as
 * an open that does not recover settles it, and Continue resumes its last session. With `stop`
 * (the control is Stop, and this is its run) a live run is cancelled instead, as an accepted Stop
 * always reads. Mutates `run`.
 */
export function settleOrphanedRun(run: RunRecord, opts: { stop?: boolean } = {}): RunRecord {
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
 * Every field `RunStore.open` may rewrite while loading a record: what `reconcileLoadedRun` and
 * `refreshHumanAskSummary` assign. Compared before and after, it tells open() which rows
 * normalization changed, so it marks those dirty and no others. Edit it together with either
 * function, or a normalized row stays unsaved (the store tests pin each field).
 */
function loadNormalizedFields(run: RunRecord): string {
  return JSON.stringify([
    run.stopping, run.status, run.finishedAt, run.error, run.activity, run.monitoringWakeAt, run.autoResumeAt,
    run.monitoringWakeCapReached, run.referencedPullRequestUrl, run.hasPendingHumanAsk, run.steps.map((step) => step.status),
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
 * Import `runs.json` into a database that has never completed an import (#779, plan step 4).
 *
 * Nothing is read while a live cockpit other than this process owns the project
 * (`assertNoLegacyCockpit`): an older cezar still writes `runs.json` then, and the import could
 * not commit. Otherwise the file is read once, through one descriptor, and parsed; it is checked
 * again before anything is written, so a file that moved while it was parsed costs no write. Then
 * ONE transaction writes every record and the completion marker, or nothing:
 * - the marker is checked again once the transaction holds the write lock, so of two processes
 *   importing at once exactly one writes; the other finds the marker and writes nothing;
 * - right before COMMIT it refuses (`LegacyWriterError`) when an older cezar may still be writing
 *   `runs.json` (`assertNoLegacyWriter`) — the check that decides;
 * - only then are the exact bytes kept beside it (`backUpLegacyIndex`: synced, never half-written,
 *   an existing backup trusted only when it holds the same bytes), and the marker records what
 *   the import read: size, sha256 and the backup's name. A refused attempt leaves no backup;
 * - a crash or refusal leaves no marker, so the next open imports again from the start.
 * `runs.json` itself is left as it was, and nothing writes it again: an older cezar keeps reading
 * the history as it stood at the upgrade, and what it writes afterwards is never imported.
 *
 * A record that does not parse is skipped and the rest are imported; an index that does not parse
 * at all imports as an empty history. Either way the import that commits says so once, naming the
 * backup: the bytes survive there and in `runs.json`, which used to be overwritten by the next save
 * instead.
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
  const kept = `Its exact bytes are kept in ${join(dataDir, backup)}; BACKWARD_COMPATIBILITY.md §3 says how to import it after a repair.`;
  if (!parsed) console.warn(`[cez] ${LEGACY_INDEX_FILE} could not be read; no run was imported, and this project starts with an empty history. ${kept}`);
  else if (skipped > 0) console.warn(`[cez] ${skipped} of ${parsed.total} runs in ${LEGACY_INDEX_FILE} could not be read and were not imported. ${kept}`);
}

/**
 * Finished rows whose stored summary an open-time normalization would still change: a referenced
 * PR an older cezar's created-PR declaration erased (see `reconcileLoadedRun`). Not live, so not
 * in the `live` column; open decodes these few and keeps the ones it actually repaired.
 */
const LEGACY_REFERENCE_HEAL_SQL =
  "json_extract(summary, '$.markerRefs.pr') IS NOT NULL AND json_extract(summary, '$.referencedPullRequestUrl') IS NULL";

/** Mark-all-read's rule (see `RunStore.markAllRead`) over the columns and the stored summary. */
const MARK_ALL_READ_SQL = "archived = 0 AND status IN ('done', 'failed') AND finished_at IS NOT NULL" +
  " AND NOT (status = 'failed' AND json_extract(summary, '$.autoResumeAt') IS NOT NULL)" +
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

/** Newest first, runs created in the same millisecond in insertion order: the order `runs.db`
 *  lists in, and the order every list had while it was a stable sort of the in-memory map. */
/** Why a `run` event fired, when a delegation checkpoint caused it (in-process only). */
export type CommitSource = 'delegation-checkpoint' | 'delegation-destroy-progress';

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

/**
 * A stored summary, or undefined when the row holds none (a row seeded without one, or text that
 * is not a summary): the caller then projects the record instead. The column is written only by
 * `encodeRunRow`, from a record the schema accepted, so this checks the shape a list row cannot
 * do without rather than running the full contract schema — on a cockpit's thousand rows that
 * schema costs more than reading them. The cold reader (`run-index.ts`), which reads other
 * projects' databases, still validates in full.
 */
export function parseStoredSummary(text: string): RunSummary | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return undefined;
    const row = raw as Record<string, unknown>;
    return typeof row.id === 'string' && typeof row.title === 'string' && typeof row.status === 'string' &&
      typeof row.createdAt === 'string' && typeof row.archived === 'boolean' ? raw as RunSummary : undefined;
  } catch {
    return undefined;
  }
}

const WORKER_PROCESS_CAP = 32;
const recordedProcessSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().min(1).max(128).optional(),
  pgid: z.number().int().positive().optional() }).strict();
const workerProcessRecordSchema = z.object({ generation: z.string().uuid(), controller: recordedProcessSchema,
  processes: z.array(recordedProcessSchema).max(WORKER_PROCESS_CAP) }).strict();
const startToken = (pid: number) => { const token = processStartToken(pid); return token === undefined ? {} : { startToken: token }; };

/** The bulk-archive sweep's one predicate (#780): finished, not archived, not scheduled (a
 *  `failed` run waiting out a usage limit), not an owned worker (those leave with their parent),
 *  then filtered by pin state. Mirrored clause for clause by `isSweepable` in the cockpit's
 *  `lib/tasks-table.ts`. */
export function isSweepable(
  run: Pick<RunRecord, 'archived' | 'status' | 'autoResumeAt' | 'pinned'> & { delegation?: { role: string } },
  scope?: ArchiveFinishedScope,
): boolean {
  if (run.archived || !['done', 'failed', 'cancelled'].includes(run.status)) return false;
  if (run.status === 'failed' && run.autoResumeAt !== undefined) return false;
  if (run.delegation?.role === 'worker') return false;
  if (scope === 'unpinned') return !run.pinned;
  if (scope === 'pinned') return run.pinned === true;
  return true;
}

/**
 * File-backed run store: one row per run in `runs.db` (#779, `./run-database.ts`) plus one
 * append-only NDJSON event file per run. Also the in-process event bus the SSE endpoints
 * subscribe to: emits `('run', RunRecord)` and `('event', { runId, event: RunEvent })`.
 *
 * Only the held set lives in memory (#779, Amendment 2): live runs, the runs a RunManager pins,
 * their delegation families, and runs whose latest write has not settled yet (see `isHeld`).
 * `getRun` answers a held run with the held object, so `commitIndex` still installs into the
 * record a caller holds; any other run is read from `runs.db` as a fresh copy every time (frozen
 * under vitest, so an in-place write throws instead of being lost). Writes to a finished run go
 * through the methods here, which load it, change it and persist the row like any other.
 *
 * Two write paths, both through `writeIndex`:
 * - optimistic: a method changes the held record, marks it dirty and schedules the debounced
 *   save, which writes the dirty rows and deletions only;
 * - durable (`commitIndex`): one transaction with the changed rows AND everything a debounced
 *   save still owes. Only once it commits do the records change in memory, and only then do
 *   subscribers hear about it.
 *
 * Several processes may open one project (`serve` and a headless `cez run`), so a store writes
 * only the delegation families it claims in `run_claims` (#779, plan step 3; `run-claims.ts`).
 * Everything it holds is claimed: open claims the live rows nobody alive owns and leaves the rest
 * alone, and a write to a run not in memory claims its family first, or refuses it while another
 * live process owns it. Claims are released once a family leaves memory, and all of them on
 * `close()`; a crashed owner's are taken over only once it is proven dead. Every write is fenced
 * in its transaction: if a row is not as this store last saw it, or its claim is gone, nothing is
 * written, the evidence goes to `run_conflicts` and this store stops writing that row
 * (`handleConflicts`).
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
  static open(dataDir: string, opts?: { keepLive?: boolean; retryBusy?: boolean }): RunStore {
    const path = join(dataDir, RUNS_DB_FILE);
    const delays = opts?.retryBusy ? OPEN_RETRY_DELAYS_MS : [];
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return RunStore.openOnce(dataDir, path, opts?.keepLive === true);
      } catch (error) {
        const transient = error instanceof RunDatabaseBusyError || (error instanceof LegacyWriterError && error.reason === 'cockpit');
        if (!transient || attempt >= delays.length) {
          throw toRunStoreOpenError(error, path, attempt > 0 ? { waitedMs: Date.now() - started } : {});
        }
        sleepSync(delays[attempt]!);
      }
    }
  }

  private static openOnce(dataDir: string, path: string, keepLive: boolean): RunStore {
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const store = new RunStore(dataDir);
    store.keepLive = keepLive;
    const db = RunDatabase.open(path);
    try {
      if (db.getMeta(RUNS_IMPORT_COMPLETE_KEY) === undefined) importLegacyIndex(db, dataDir);
      store.db = db;
      store.owner = openClaimSession();
      store.loadHeldRows();
      store.warmTranscriptFacts();
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
      if (decoded) this.adoptLoadedRun(decoded, { keepLive: this.keepLive, onlyIfChanged: true }, row);
    }
    for (const rootId of this.anchoredFamilies()) this.holdFamily(rootId, decode);
    this.releaseUnheldClaims();
    if (unreadable > 0) console.warn(`[cez] ${unreadable} run(s) in ${RUNS_DB_FILE} could not be read; they are left in the database untouched.`);
  }

  /** Normalize a record just read from `row` (see `reconcileLoadedRun`) and hold it. Marks the row
   *  dirty only when normalization changed it, so the next save persists exactly the runs open()
   *  rewrote. The caller has claimed the row's family. */
  private adoptLoadedRun({ run, extras }: DecodedRun, opts: { keepLive?: boolean; onlyIfChanged?: boolean; settle?: boolean; stop?: boolean }, row: RunRow): void {
    const before = loadNormalizedFields(run);
    if (run.delegation?.role === 'root' && (run.status === 'waiting' || run.delegation.wait !== undefined)) {
      this.syncHumanAskSummary(run);
    }
    if (opts.settle) settleOrphanedRun(run, { stop: opts.stop });
    else reconcileLoadedRun(run, opts);
    const changed = loadNormalizedFields(run) !== before;
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
   * Take over the delegation family of an `orphaned` run for a control: claim it from its dead
   * owner (or from nobody), then load it and settle its live rows (`settleOrphanedRun`) — never
   * keep them for recovery to resume, since only Continue may start agent work. With `stop` the
   * control is Stop: `id` itself is settled as cancelled rather than interrupted. Returns the
   * family's root id, or undefined when a live owner holds it after all or it is gone. The caller
   * runs recovery for that family next (`RunManager.adoptOrphanedRun`), which then repairs it.
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

  /** Release `holder`'s pin. The run leaves memory at the next sweep once nothing else holds it. */
  unpin(id: string, holder: RunPinHolder): void {
    const holders = this.pins.get(id);
    if (!holders?.delete(holder)) return;
    if (holders.size === 0) this.pins.delete(id);
    this.sweepIfSettled([id]);
  }

  /**
   * Tell the store which repository this project IS (#945), so the referenced tier stops adopting
   * another repo's PR/issue as the task's subject. See `isRepoScopedRef` for the rule.
   *
   * A setter rather than an `open()` option because `open()` is synchronous and the handle costs a
   * `gh` spawn: callers arm this in the background so boot never waits on the network. `null` is a
   * first-class answer meaning "cannot be known" (no `gh`, no remote, a non-git root) and leaves
   * the store in exactly its pre-#945 behavior.
   *
   * Arming also HEALS records already poisoned by the un-scoped rule, on the `reconcileLoadedRun`
   * precedent: the evidence is all still on the record (`referenced*Candidates`), only the
   * conclusion drawn from it was wrong, so re-deciding beats asking for a migration. It rewrites
   * values, never the format, and is one-directional by construction — see `rescopeRun`. Held
   * runs are re-checked in memory; of the rest, only rows whose stored summary references another
   * repository are decoded, and the healed ones are written, so their summaries heal too.
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
   * (`listWorkersOf`, `findRunByClientRequestId`, `listGroupRuns`, `listRunsWithWorktree`,
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
  listRunSummaries(options: { archivedWindow?: number; roots?: boolean } = {}): { runs: RunSummary[]; truncated: boolean } {
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
   * `total` counts those. A cursor this store did not write answers `{ error }`.
   *
   * Ranking reads every archived root's key (id, created_at, seq: no record, no summary), so the
   * page and `total` agree with the held overlay; only the page's own rows are read in full.
   */
  listArchivedRuns(options: { before?: string; limit: number; q?: string }): ArchivedRunsResponse | { error: string } {
    let after: ListOrder | undefined;
    if (options.before !== undefined) {
      after = decodeArchivedCursor(options.before);
      if (!after) return { error: 'before is not a cursor this server wrote' };
    }
    const q = options.q?.trim() ?? '';
    const skipped = (id: string) => this.deleted.has(id) || this.held.has(id) || this.unreadable.has(id);
    const ranked = new Map<string, ListOrder & { summary?: RunSummary }>();
    if (q === '') {
      for (const key of this.db?.listKeysWhere(ARCHIVED_ROOT) ?? []) if (!skipped(key.id)) ranked.set(key.id, key);
    } else {
      for (const row of this.db?.searchRootSummaries(sqlPrefilterTokens(q)) ?? []) {
        if (skipped(row.id)) continue;
        const summary = parseStoredSummary(row.summary) ?? this.coldSummary(row.id);
        if (summary?.archived && matchesRunQuery(summary, q)) ranked.set(row.id, { ...row, summary });
      }
    }
    for (const [id, run] of this.held) {
      if (!run.archived || run.delegation?.role === 'worker') continue;
      const summary = toRunSummary(run);
      if (q === '' || matchesRunQuery(summary, q)) ranked.set(id, { ...this.listOrder(run), summary });
    }
    const ordered = [...ranked.entries()].sort(([, a], [, b]) => newestFirst(a, b));
    const rest = after ? ordered.filter(([, key]) => newestFirst(key, after) > 0) : ordered;
    const page = rest.slice(0, options.limit);
    const cold = new Map((this.db?.getSummaries(page.filter(([, key]) => !key.summary).map(([id]) => id)) ?? [])
      .map((row) => [row.id, parseStoredSummary(row.summary) ?? this.coldSummary(row.id)]));
    const runs = page.flatMap(([id, key]) => {
      const summary = key.summary ?? cold.get(id);
      return summary ? [summary] : [];
    });
    const last = page.at(-1)?.[1];
    return {
      runs,
      nextCursor: last && rest.length > page.length ? encodeArchivedCursor(last) : null,
      total: ordered.length,
    };
  }

  /**
   * The ROOT runs, archived or not, that match `query` (`matchesRunQuery`), newest first: at most
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
      if (summary && matchesRunQuery(summary, query)) matched.set(row.id, [summary, row]);
      return matched.size <= limit;
    });
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'worker') continue;
      const summary = toRunSummary(run);
      if (matchesRunQuery(summary, query)) matched.set(id, [summary, this.listOrder(run)]);
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

  /** The id of every root whose delegation carries a conversation, held or stored: recovery's
   *  full reconcile pass (#661). The stored summary names the role, so only roots' records are
   *  read, in SQLite. */
  listConversationRootIds(): string[] {
    const where = "json_extract(summary, '$.delegation.role') = 'root' AND json_extract(data, '$.delegation.conversation') IS NOT NULL";
    const ids = new Set((this.db?.listKeysWhere(where) ?? []).map((key) => key.id));
    for (const id of this.deleted) ids.delete(id);
    for (const [id, run] of this.held) {
      if (run.delegation?.role === 'root' && run.delegation.conversation) ids.add(id);
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

  /** The members of one parallel-variant group (spec 010), in no particular order. */
  listGroupRuns(groupId: string): RunRecord[] {
    return this.queryRuns(this.db?.listByGroup(groupId) ?? [], (run) => run.groupId === groupId).map(([run]) => run);
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
    systemPrompt?: string;
    workflowDef?: z.infer<typeof workflowDefSchema>;
    workflow: string;
    task: string;
    model?: string;
    /** Reasoning-effort pin (#45). Absent = harness default. */
    effort?: string;
    runner?: RunnerId;
    /** Composer's per-task agent account (spec 2026-07-29-agent-profiles). */
    agentProfile?: string;
    generateFollowups?: boolean;
    autonomous?: boolean;
    /** Task webhook opt-in (#589), set at creation so the first transition is already covered. */
    notify?: boolean;
    worktree?: false;
    groupId?: string;
    variant?: string;
    clientRequestId?: string;
    clientRequestHash?: string;
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
      generateFollowups: input.generateFollowups,
      autonomous: input.autonomous,
      ...(input.notify ? { notify: true } : {}),
      worktree: input.worktree,
      groupId: input.groupId,
      variant: input.variant,
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId, clientRequestHash: input.clientRequestHash }),
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

  /** Accept the family ledger and its recipient queue in a single durable index replacement. */
  commitConversation(rootId: string, conversation: ConversationState, delivery?: { recipientRunId: string; input: AgentInput }): void {
    const root = this.peek(rootId);
    if (root?.delegation?.role !== 'root') throw new Error('missing conversation root');
    const staged = new Map<string, RunRecord>();
    staged.set(rootId, { ...root, delegation: delegationStateSchema.parse({ ...root.delegation, conversation: { ...conversation,
      messages: conversation.messages.map(message => ({ ...message, text: this.redactText(message.text) })),
    } }) });
    if (delivery) {
      const recipient = staged.get(delivery.recipientRunId) ?? this.peek(delivery.recipientRunId);
      if (!recipient) throw new Error('missing conversation recipient');
      const input = agentInputSchema.parse({ ...delivery.input, text: this.redactText(delivery.input.text) });
      staged.set(recipient.id, { ...recipient, agentInputs: [...(recipient.agentInputs ?? []), input] });
    }
    this.commitIndex(staged);
  }

  /** Observable atomic input checkpoint: a failed write publishes nothing. */
  /** Accepted input the harness will never read returns to the queue (#505): only its
   * delivery and consumption receipts are cleared; order and identity are kept. */
  requeueUnconsumedAgentInputs(id: string, ids: readonly string[]): void {
    const run = this.peek(id);
    if (!run?.agentInputs || !ids.length) return;
    this.commitAgentInputs(id, run.agentInputs.map(input => {
      if (!ids.includes(input.id)) return input;
      const { deliveredAt: _delivered, consumedAt: _consumed, awaitingRead: _awaiting, ...queued } = input;
      return queued;
    }));
  }

  /** Model consumption observed by the current session (#505). Never un-sets deliveredAt. */
  commitAgentInputsConsumed(id: string, ids: readonly string[], at: string): void {
    const run = this.peek(id);
    if (!run?.agentInputs || !ids.length) return;
    this.commitAgentInputs(id, run.agentInputs.map(input => {
      if (!ids.includes(input.id) || !input.deliveredAt || input.consumedAt) return input;
      const { awaitingRead: _awaiting, ...read } = input;
      return { ...read, consumedAt: at };
    }));
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

  /** Crash recovery (#505): input a harness accepted but was never seen reading goes
   * back to the queue. Returns the requeued IDs. */
  requeueAwaitingReadInputs(id: string): string[] {
    const ids = (this.peek(id)?.agentInputs ?? []).filter(input => input.awaitingRead && input.deliveredAt && !input.consumedAt).map(input => input.id);
    this.requeueUnconsumedAgentInputs(id, ids);
    return ids;
  }

  commitAgentInputs(id: string, inputs: readonly AgentInput[], openingContinuationInputId?: string): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing agent input target');
    const agentInputs = inputs.map(input => agentInputSchema.parse(input));
    const now = new Date().toISOString();
    for (const input of run.agentInputs ?? []) {
      const claim = input.inboxClaim;
      if (!claim || claim.acknowledgedAt || claim.expiresAt <= now) continue;
      const matching = agentInputs.filter(next => next.id === input.id);
      if (matching.length !== 1 || !isDeepStrictEqual(matching[0]!.inboxClaim, claim)) {
        throw new Error('live inbox receipt changed');
      }
    }
    if (openingContinuationInputId && (run.continuationMessage?.agentInputId !== openingContinuationInputId ||
      !agentInputs.some(input => input.id === openingContinuationInputId && input.deliveredAt))) throw new Error('opening agent input checkpoint changed');
    this.commitIndex(new Map([[id, { ...run, agentInputs, ...(openingContinuationInputId ? { continuationMessage: undefined } : {}) }]]));
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
    this.commitIndex(new Map([[runId, { ...run, agentInputs: run.agentInputs!.map(input => input.inboxClaim?.receiptId === receiptId
      ? agentInputSchema.parse({ ...input, deliveredAt: at, inboxClaim: { ...input.inboxClaim, acknowledgedAt: at } }) : input) }]]));
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

  /** CI intent and its wake entry share one atomic index replacement. */
  commitCiWait(id: string, wait: CiWait, input?: AgentInput): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing CI wait target');
    const ciWait = ciWaitSchema.parse(wait);
    const entry = input ? agentInputSchema.parse(input) : undefined;
    this.commitIndex(new Map([[id, { ...run, ciWait, lastCiWaitError: undefined, ...(entry ? { agentInputs: run.agentInputs?.some(row => row.id === entry.id)
      ? run.agentInputs : [...(run.agentInputs ?? []), entry] } : {}) }]]));
  }

  /** Retire the wait and precisely its pending wake, optionally accepting human input. */
  commitCiWaitWithdrawal(id: string, acceptedHumanMessage?: QueuedMessage): void {
    const run = this.peek(id);
    if (!run?.ciWait) return;
    const { ciWait, ...rest } = run;
    const lastCiWait: CiWait = { ...ciWait, phase: 'withdrawn' };
    this.commitIndex(new Map([[id, { ...rest, ciWait: undefined, lastCiWait,
      ...(run.agentInputs ? { agentInputs: run.agentInputs.filter(input => input.id !== ciWait.wakeId || input.deliveredAt) } : {}),
      ...(acceptedHumanMessage ? { queuedMessages: [...(run.queuedMessages ?? []), queuedMessageSchema.parse(acceptedHumanMessage)] } : {}),
    }]]));
  }

  /** Provider acceptance and receipt retirement have one delivery checkpoint. */
  commitCiWaitDelivery(id: string, inputId: string): void {
    const run = this.peek(id);
    if (!run?.ciWait || run.ciWait.wakeId !== inputId) return;
    const { ciWait, ...rest } = run;
    const deliveredAt = new Date().toISOString();
    this.commitIndex(new Map([[id, { ...rest, ciWait: undefined, lastCiWait: { ...ciWait, phase: 'delivered' as const, deliveredAt },
      agentInputs: (run.agentInputs ?? []).map(input => input.id === inputId ? { ...input, deliveredAt } : input),
    }]]));
  }

  /** Retain the settled receipt and retire exactly one wait together with any human message that superseded it. */
  commitWorkerWaitWithdrawal(id: string, waitId: string, acceptedHumanMessage?: QueuedMessage): void {
    const run = this.peek(id);
    if (!run?.delegation || run.delegation.role === 'invalid' || run.delegation.wait?.id !== waitId) {
      throw new Error('worker wait changed before withdrawal');
    }
    const { wait, ...delegation } = run.delegation;
    const message = acceptedHumanMessage ? queuedMessageSchema.parse(acceptedHumanMessage) : undefined;
    this.commitIndex(new Map([[id, { ...run, delegation: { ...delegation, lastWait: wait.phase === 'wake-pending'
      ? reconcileWorkerWait(wait, [], new Date().toISOString())
      : { ...wait, phase: 'wake-pending', reason: wait.reason ?? 'cancelled', wakeId: wait.wakeId ?? wait.id } },
      // An adopted agent input belongs to its sender, even when it carries the wait receipt.
      ...(run.agentInputs ? { agentInputs: run.agentInputs.filter(input => input.id !== wait.wakeId || input.deliveredAt || input.source === 'agent') } : {}),
      ...(message ? {
        queuedMessages: [...(run.queuedMessages ?? []), message],
        ...(run.continuationMessage ? { continuationMessage: {
          ...run.continuationMessage, origin: 'human' as const,
          text: run.continuationMessage.origin === 'lifecycle' ? '' : run.continuationMessage.text,
        } } : {}),
      } : {}),
    }]]));
  }

  /** Successful deferred human delivery consumes only its persisted queue ID.
   * A crash before this checkpoint may replay that same message on recovery. */
  commitQueuedMessageDelivery(id: string, messageId: string): void {
    const run = this.peek(id);
    if (!run) throw new Error('missing queued message target');
    this.commitIndex(new Map([[id, { ...run, queuedMessages: (run.queuedMessages ?? []).filter(message => message.id !== messageId) }]]));
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
      activity: undefined, monitoringWakeAt: undefined, monitoringWakeCapReached: undefined,
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
   * The durable write: `staged` holds the records this operation replaces (`null` deletes one),
   * in the order subscribers hear about them. The transaction is the durability boundary;
   * flush() is deliberately best-effort.
   *
   * One transaction carries the staged rows and every row a debounced save still owes, so the
   * database never holds a commit without the optimistic writes made before it. If it fails,
   * nothing changed anywhere: the held records, the database, the pending dirty rows and the
   * subscribers all see the store as it was.
   */
  private commitIndex(staged: ReadonlyMap<string, RunRecord | null>, source?: CommitSource): void {
    if (!this.db) throw this.openFailure ?? new Error('runs database unavailable: nothing can be saved');
    this.assertWritable(staged);
    this.persist(staged);
    // Preserve existing record references, but expose the entire transaction before its first event.
    // A finished run joins the held set for the commit and leaves at the next sweep.
    for (const [id, next] of staged) {
      if (!next) { this.held.delete(id); continue; }
      this.committing.add(id);
      const current = this.held.get(id);
      if (current) Object.assign(current, next);
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
    if (normalized.status && !['running', 'waiting', 'queued'].includes(normalized.status)) {
      normalized.activity = undefined;
      normalized.monitoringWakeAt = undefined;
      normalized.monitoringWakeCapReached = undefined;
    }
    // …and the mirror image for the usage-limit resume (spec
    // 2026-08-03-auto-resume-after-usage-limit): it is a promise made ABOUT a failed run, so a
    // run coming back to life — the resume itself, a user Continue, a re-queue — retires it.
    // The manager's timer re-checks the record before it fires, so a cleared field is enough.
    if (normalized.status && ['running', 'waiting', 'queued'].includes(normalized.status)) {
      normalized.autoResumeAt = undefined;
    }
    const archived = Object.prototype.hasOwnProperty.call(normalized, 'archived')
      ? Boolean(normalized.archived)
      : undefined;
    if (archived !== undefined) {
      delete normalized.archived;
      delete normalized.archivedAt;
    }
    // Restore before mutating so a throw leaves status and archived unchanged (#818 S3).
    if (archived === false) restoreHistory(this.dataDir, id);
    Object.assign(run, this.redactPatch(normalized));
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
      run.referencedIssueUrl = resolveReferencedRef(
        run.referencedIssueCandidates, run.task, run.markerRefs?.issue, this.repoHandle,
      );
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

  setArchived(id: string, archived: boolean): RunRecord | undefined {
    const run = this.record(id);
    if (!run) return undefined;
    this.applyArchivedCascade(run, archived);
    return run;
  }

  /** Parent + owned workers; returns how many records flipped `archived`. */
  private applyArchivedCascade(run: RunRecord, archived: boolean): number {
    let changed = 0;
    if (this.applyArchived(run, archived)) changed++;
    // Owned workers nest under their parent only while both share Active/Archived (#250).
    // Cascade from the parent only — archiving one worker stays independent.
    if (run.delegation?.role !== 'worker') {
      for (const { id } of this.listWorkersOf(run.id)) {
        const child = this.record(id);
        if (child && this.applyArchived(child, archived)) changed++;
      }
    }
    return changed;
  }

  private applyArchived(run: RunRecord, archived: boolean): boolean {
    const changed = run.archived !== archived;
    // Transcript first: a restore throw aborts with the record unchanged (#818 S3).
    this.syncTranscriptForm(run.id, archived);
    run.archived = archived;
    run.archivedAt = archived ? new Date().toISOString() : undefined;
    if (archived) {
      clearPendingAutoResume(run);
      clearPin(run);
    }
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
  archiveFinished(scope?: ArchiveFinishedScope): { archived: number; ids: string[]; pinnedIds: string[] } {
    let archived = 0;
    // Snapshot first: cascade may archive still-live workers, mutating the held set, and the pin
    // has to be read before `applyArchived` clears it. Runs not in memory are picked off their
    // stored summary, which carries every field `isSweepable` reads.
    const picked: Array<readonly [Parameters<typeof isSweepable>[0] & { id: string }, ListOrder]> =
      [...this.held.values()].filter((run) => isSweepable(run, scope)).map((run) => [run, this.listOrder(run)]);
    for (const row of this.db?.listWhere("archived = 0 AND status IN ('done', 'failed', 'cancelled') AND parent_run_id IS NULL") ?? []) {
      if (this.held.has(row.id) || this.deleted.has(row.id)) continue;
      const summary = parseStoredSummary(row.summary);
      if (summary && isSweepable(summary, scope)) picked.push([summary, row]);
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

  /** Bulk mark-read: stamp every currently-unread finished run; returns the count.
   *  "Unread" here is the same rule the cockpit paints (`isUnread` in read-state.ts),
   *  clause for clause:
   *   - a `done` or `failed` run that finished and has not been seen since;
   *   - cancelled runs are never unread — you stopped them yourself;
   *   - archived ones never are either, since archiving is a stronger "done with this"
   *     than reading;
   *   - and a `failed` run with a pending `autoResumeAt` is not a done item AT ALL
   *     (`isScheduledResume`, spec 2026-08-03-auto-resume-after-usage-limit): it has an
   *     appointment to pick the work back up, so there is no outcome to have missed.
   *
   *  Keeping the two rules identical is what makes the returned count the number the
   *  cockpit's unread badge was showing. The `autoResumeAt` clause is the one that drifted
   *  (#803): `isUnread` gained it with auto-resume and this sweep did not, so a task waiting
   *  out a usage limit was uncounted by the badge but stamped read by the sweep — and this
   *  comment asserted an invariant the code no longer held.
   *
   *  This rule lives in two languages of the same repo, which is why it has now drifted
   *  once. The cockpit cannot import it (`packages/web` does not depend on the service, and
   *  should not), so a single definition would have to move to `packages/contract` — the one
   *  package both sides already import. Worth doing; deliberately not done here, because
   *  widening the contract package's remit from "shapes" to "behavior" is a design change
   *  that deserves its own review rather than riding along in a bug fix. Until then: EDIT
   *  BOTH, and the case-table tests on either side are what catch you if you don't. */
  markAllRead(): number {
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
        !(run.status === 'failed' && run.autoResumeAt !== undefined) &&
        run.finishedAt !== undefined &&
        (run.seenAt === undefined || run.seenAt < run.finishedAt);
      if (!unread) continue;
      run.seenAt = now;
      this.touch(run);
      count++;
    }
    return count;
  }

  appendEvent(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
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
    const full: RunEvent = this.redact({ ...event, seq, ts: new Date().toISOString() });
    // Sync append keeps event order without a write queue; local NDJSON
    // appends at agent-event rates are effectively free.
    if (!hasPlainHistory(this.dataDir, runId)) restoreHistory(this.dataDir, runId);
    const line = `${JSON.stringify(full)}\n`;
    appendFileSync(this.eventsPath(runId), line, 'utf8');
    this.facts.append(runId, full, Buffer.byteLength(line));
    this.maybeEnqueueHistoryCompress(run);
    if ((full.type === 'ask.requested' || full.type === 'human-input-delivered') &&
      this.syncHumanAskSummary(run)) this.touch(run);
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
      if (!run.pullRequestUrl) {
        const created = CREATED_PR_RE.test(claim) ? createdPrUrl(`${claim} ${haystack}`) : undefined;
        if (created) {
          this.updateRun(runId, { pullRequestUrl: created });
          // Adopting the created tier can RELEASE a declaration the referenced tier was holding
          // (see `referencedPrDeclaration`), so re-resolve here too: the about-PR must come back
          // whether the marker arrived before the creation evidence or after it.
          const resolved = resolveReferencedRef(
            run.referencedPrCandidates ?? [],
            run.task,
            referencedPrDeclaration(run),
            this.repoHandle,
          );
          if (resolved !== run.referencedPullRequestUrl) {
            run.referencedPullRequestUrl = resolved;
            changed = true;
          }
        } else if (PR_URL_RE.test(haystack) && this.trackReferencedPrs(run, haystack)) {
          changed = true;
        }
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
    run.referencedIssueUrl = resolveReferencedRef(
      run.referencedIssueCandidates ?? [],
      run.task,
      run.markerRefs?.issue,
      this.repoHandle,
    );
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
   * regex/namer numbers, and a declared PR re-resolves the referenced URL
   * against the candidate working set — including down to `undefined` when no
   * candidate matches (a wrong chip is worse than no chip). The created tier
   * (`pullRequestUrl`) is deliberately untouched.
   *
   * One declaration is NOT a statement about the referenced tier: the number of the PR this run
   * itself created. See `referencedPrDeclaration` — the marker contract asks the agent to
   * re-declare after it opens a PR, and taking that literally cost the task the PR it was about.
   */
  applyMarkerRefs(runId: string, refs: { pr?: number; issue?: number }): RunRecord | undefined {
    const run = this.record(runId);
    if (!run || (refs.pr === undefined && refs.issue === undefined)) return run;
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
      run.issueNumber = refs.issue;
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
      run.referencedIssueUrl = resolveReferencedRef(
        run.referencedIssueCandidates ?? [],
        run.task,
        run.markerRefs.issue,
        this.repoHandle,
      );
    }
    this.touch(run);
    return run;
  }

  /**
   * Fan an event out to live subscribers WITHOUT writing it to the NDJSON
   * file — the channel for coalesced `item.delta` flushes (protocol-v2
   * performance guardrail: raw deltas never hit disk; replay = the persisted
   * snapshots). Stamped with `seq`/`ts` like persisted lines so the live
   * wire keeps one ordering axis; the seq simply never appears in a replay
   * (gaps are fine — dedup compares with `>`).
   */
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const full: RunEvent = this.redact({ ...event, seq: this.nextSeq(runId), ts: new Date().toISOString() });
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
  private redact(event: RunEvent): RunEvent {
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

  hasProjection(runId: string, projectionId: string): boolean {
    return this.transcriptFacts(runId).projectionIds.includes(projectionId);
  }

  private factsWarming: Promise<void> = Promise.resolve();

  /** After open, build the indexes the delegation reconcile will ask for first, off the request
   *  path: every member of every family with a conversation (#880). */
  private warmTranscriptFacts(): void {
    // A microtask, not a timer: open returns first, and no timer outlives a store that never warms.
    this.factsWarming = Promise.resolve().then(() => {
      const ids: string[] = [];
      for (const rootId of this.listConversationRootIds()) ids.push(rootId, ...(this.db?.listIdsByParent(rootId) ?? []));
      return this.facts.warm(ids);
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

  /** The owned store's `refreshHumanAskSummary`, from the index, on the same rules: no history
   *  (legacy runs) keeps the summary, an unreadable one requests attention. True when it changed. */
  private syncHumanAskSummary(run: RunRecord): boolean {
    const facts = this.facts.get(run.id);
    const next = !facts ? true
      : facts.bytes > 0 || facts.archive !== undefined ? facts.pendingAsk !== undefined
      : run.hasPendingHumanAsk === true;
    if (next === run.hasPendingHumanAsk) return false;
    run.hasPendingHumanAsk = next;
    return true;
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
    return this.executionPath(id).replace(/\.execution\.json$/, '.identity.json');
  }

  readWorkerIdentity(id: string): WorkerExecutionIdentity | undefined {
    try {
      const fd = openSync(this.identityPath(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > 16384 || (info.mode & 0o077)) return undefined;
        const buffer = Buffer.alloc(16385); const count = readSync(fd, buffer, 0, buffer.length, 0);
        return workerExecutionIdentitySchema.parse(JSON.parse(buffer.subarray(0, count).toString('utf8')));
      } finally { closeSync(fd); }
    } catch { return undefined; }
  }

  private writeWorkerIdentity(id: string, identity: WorkerExecutionIdentity): void {
    // Immutable acceptance evidence. An orphan from failed index publication cannot be adopted.
    const fd = openSync(this.identityPath(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(identity)); fsyncSync(fd); } finally { closeSync(fd); }
  }

  private executionPath(id: string): string {
    z.string().uuid().parse(id);
    const dir = join(this.dataDir, 'runs');
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir)) throw new Error('Unsafe execution directory');
    return join(dir, `${id}.execution.json`);
  }

  readWorkerExecution(id: string): WorkerExecution | undefined {
    try {
      const path = this.executionPath(id);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > 16384 || (info.mode & 0o077)) return undefined;
        const buffer = Buffer.alloc(16385); const count = readSync(fd, buffer, 0, buffer.length, 0);
        return workerExecutionSchema.parse(JSON.parse(buffer.subarray(0, count).toString('utf8')));
      } finally { closeSync(fd); }
    } catch { return undefined; }
  }

  private writeWorkerExecution(id: string, proof: WorkerExecution, fresh = false): void {
    const path = this.executionPath(id);
    try {
      const existing = lstatSync(path);
      if (fresh || !existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe execution checkpoint');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(proof)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  }

  /** Complete execution is not permission to reuse/delete persistent resources (#738).
   * Synchronous, fresh and generation/resource fenced; callers hold admission off across awaits. */
  workerResourcesSafe(id: string, generation: string, resourceId: string, admittingQueued = false): boolean {
    return this.workerResourceHolders(id, generation, resourceId, { admittingQueued }) === 'safe';
  }

  /** `workerResourcesSafe` with the refusal's live PIDs (empty when no PID explains it). */
  workerResourceHolders(id: string, generation: string, resourceId: string,
    opts: { admittingQueued?: boolean; cwds?: CwdSource } = {}): 'safe' | number[] {
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
    return this.executionPath(id).replace(/\.execution\.json$/, '.processes.json');
  }

  /** Tri-state: only ENOENT is `absent` (legacy, scan-only). A present record that is unreadable,
   * wrongly permissioned, malformed or of another generation is `unknown`: never finalized or reaped. */
  readWorkerProcesses(id: string, generation: string): WorkerProcessRecord | 'absent' | 'unknown' {
    try {
      const fd = openSync(this.processesPath(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > 8192 || (info.mode & 0o077)) return 'unknown';
        const buffer = Buffer.alloc(8193); const count = readSync(fd, buffer, 0, buffer.length, 0);
        const record = workerProcessRecordSchema.parse(JSON.parse(buffer.subarray(0, count).toString('utf8')));
        return record.generation === generation ? record : 'unknown';
      } finally { closeSync(fd); }
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'; }
  }

  private writeWorkerProcesses(id: string, record: WorkerProcessRecord): void {
    const path = this.processesPath(id);
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe process record');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(workerProcessRecordSchema.parse(record))); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
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
    const parent = this.peek(child.delegation.parentRunId);
    if (parent?.delegation?.role !== 'root' || parent.delegation.historyDeletion) return false;
    const receipt = parent.delegation.receipts.find(entry => entry.workerId === id);
    const result = this.readWorkerResult(parent.id, id);
    if (!receipt || !result?.settled || result.cleanup !== 'complete' || result.status !== child.status ||
      result.revision !== (child.delegation.executionRevision ?? 0)) return false;
    const { state: _state, ...workspace } = result.workspace;
    if (JSON.stringify(workspace) !== JSON.stringify(child.delegation.workspace)) return false;
    const proof = this.readWorkerExecution(id);
    // Retain process evidence until scratch is safely removed. A prior pending deletion may
    // already have removed those files; it never authorizes deleting newly appeared scratch.
    if (proof && !this.workerResourcesSafe(id, proof.generation, workspace.resourceId)) return false;
    if (!proof && agentTmpDirMayExist(this.dataDir, id)) return false;
    if (receipt.deletion) return receipt.deletion.revision === result.revision &&
      receipt.deletion.resourceId === workspace.resourceId && receipt.deletion.phase === 'pending' &&
      (proof ? proof.phase === 'complete' && proof.generation === receipt.deletion.generation : !existsSync(this.executionPath(id)));
    return proof?.phase === 'complete';
  }

  canDeleteRun(id: string): boolean {
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
        rmSync(this.identityPath(id), { force: true });
        rmSync(this.processesPath(id), { force: true });
        rmSync(this.executionPath(id), { force: true });
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
  }

  deleteRun(id: string): boolean {
    if (!this.canDeleteRun(id)) return false;
    const run = this.peek(id);
    if (run && this.db && (this.quarantined.has(id) || !this.claimFamilies([familyKey(run)]).size)) return false;
    if (run?.delegation?.role === 'worker' || run?.delegation?.role === 'root') return this.deleteDelegatedRun(id);
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
      upserts.push(encodeRunRow(run, encoded.data));
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
   * A fenced write found rows that changed under this store (#779, plan step 3); the write itself
   * has already failed with nothing changed, and its caller sees that error.
   *
   * A conflict is UNEXPECTED when this store owned the row's family when it last read or wrote it:
   * a held or pending row, or one read inside a family it claimed. Another writer then broke the
   * claim. For each such row the original (what this store last saw), local (what it meant to
   * write, or that it meant to delete it) and current versions go to `run_conflicts` first. Only
   * once that evidence is stored does the row leave the pending set, so no retry rewrites it; this
   * store then refuses to write it again, and its held copy is replaced by the current row (or
   * dropped when deleted) and announced. That refusal lasts as long as this store: the explicit
   * recovery is a restart, which reads the row as it now stands, and the evidence row stays for a
   * person to compare. Other pending rows stay pending and the next save writes them.
   *
   * If the evidence cannot be stored, nothing changes: the rows stay pending, and the next write
   * meets the same conflict and tries again. A row read before its family was claimed may simply
   * have been finished by its previous owner in between: a stale read, not a conflict, so only the
   * write fails.
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
