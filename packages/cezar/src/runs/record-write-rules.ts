import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { agentInputSchema, delegationStateSchema } from '@open-mercato/cezar-contract/delegation';
import { runPullRequestSchema } from '@open-mercato/cezar-contract/runs';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import type { AgentInput, ConversationState, DelegationState, RunPullRequest } from '@open-mercato/cezar-contract';
import { redactSecrets } from '../core/secret-redaction.ts';
import { mergePullRequests } from './pull-requests.ts';
import type { RepoHandle, RunRecord, StepState } from './store.ts';

type RecordPatch = Partial<Omit<RunRecord, 'id' | 'steps'>>;
type Staged = ReadonlyMap<string, RunRecord | null>;

/** Rule order is path-specific. These differences preserve existing behavior:
 * commit tests isUsageLimitHold; loaded/debounced test only status. Durable task edits skip
 * reference resolution. Completion preparation is commit-only. Patch redaction's opt-out also
 * skips session secrets, while text redaction always scrubs those secrets.
 */
export const WRITE_PATH_RULES = {
  commit: ['stale-resume:hold', 'completion-actions'],
  durableUpdate: ['issue-seed', 'pull-requests', 'restore', 'redact-patch', 'archive-fields'],
  debouncedUpdate: ['issue-seed', 'pull-requests', 'restore', 'redact-patch', 'assign', 'stale-resume:status', 'task-references', 'archive-or-touch'],
  loaded: ['stale-resume:status'],
  conversation: ['redact-messages', 'parse-delegation', 'redact-input', 'parse-input', 'append-input'],
  // updateRun, marker declarations, PR discovery and event observations.
  pullRequests: ['merge-pull-requests'],
  // stageArchive, updateRun and applyArchived, including bulk archive.
  archiveFields: ['archive-time', 'store-owned:withdraw-hold', 'store-owned:clear-pin'],
  stepUpdate: ['redact-step-error'],
} as const;

interface CommitHooks {
  peek(id: string): RunRecord | undefined;
  completionArchiveBlocker(run: RunRecord): string | undefined;
  stageArchive(staged: Map<string, RunRecord | null>, run: RunRecord, archived: boolean): void;
}

// Pure reference helpers remain in store.ts; callbacks avoid a store/module value cycle.
interface UpdateHooks {
  redact(text: string): string;
  refUrlNumber(url: string | undefined): number | undefined;
  repoHandle?: RepoHandle | null | undefined;
  restore(): void;
  withdrawHold(run: RunRecord): void;
  clearPin(run: RunRecord): void;
  hasPrUrl(text: string): boolean;
  hasIssueUrl(text: string): boolean;
  trackReferencedPrs(run: RunRecord, text: string): unknown;
  trackReferencedIssues(run: RunRecord, text: string): unknown;
  resolveReferencedPr(run: RunRecord): string | undefined;
  resolveIssueReference(run: RunRecord): string | undefined;
  rescopeRun(run: RunRecord): unknown;
  archive(run: RunRecord, archived: boolean): unknown;
  touch(run: RunRecord): void;
}

export function stageCommit(input: Staged, hooks: CommitHooks): Map<string, RunRecord | null> {
  return prepareCompletionActions(withoutStaleResumes(input), hooks);
}

export function stageLoaded(run: RunRecord): void {
  // Open waits survive at every status; recovery owns their cancellation.
  if (run.status !== 'waiting') run.autoResumeAt = undefined;
}

export function redactText(text: string, sessionSecrets: readonly string[], hostSecrets: () => readonly string[]): string {
  const safe = sessionSecrets.length ? redactSecrets(text, sessionSecrets) : text;
  if (process.env.CEZ_REDACT_SECRETS === '0') return safe;
  return redactSecrets(safe, hostSecrets());
}

function prepareUpdate(run: RunRecord, patch: RecordPatch, hooks: UpdateHooks) {
  if (Object.prototype.hasOwnProperty.call(patch, 'issueNumber')) delete run.referencedIssueNumberSeeded;
  const normalized = { ...patch };
  if (normalized.pullRequestUrl !== undefined) {
    stagePullRequests(run, [run.pullRequestUrl, normalized.pullRequestUrl].flatMap((url) => {
      const number = hooks.refUrlNumber(url);
      if (number === undefined) return [];
      const parsed = runPullRequestSchema.safeParse({ number, url, source: 'created' });
      return parsed.success ? [parsed.data] : [];
    }), hooks.repoHandle);
  }
  // Waits are not cleared here: RunManager cancels them explicitly when a run ends (spec
  // 2026-10-17-unified-waits), so a terminal patch never retires one as a side effect.
  const archived = Object.prototype.hasOwnProperty.call(normalized, 'archived') ? Boolean(normalized.archived) : undefined;
  if (archived !== undefined) { delete normalized.archived; delete normalized.archivedAt; }
  // Restore before mutating so a throw leaves status and archived unchanged (hearsay-tools/cezarion#818 S3).
  if (archived === false) hooks.restore();
  return { normalized, archived };
}

export function stageDurableUpdate(run: RunRecord, patch: RecordPatch, hooks: UpdateHooks): RunRecord {
  const { normalized, archived } = prepareUpdate(run, patch, hooks);
  const next = { ...run, ...redactPatch(normalized, hooks.redact) };
  if (archived !== undefined) stageArchiveFields(next, archived, new Date().toISOString(), hooks.withdrawHold, hooks.clearPin);
  return next;
}

export function stageDebouncedUpdate(run: RunRecord, patch: RecordPatch, hooks: UpdateHooks): void {
  const { normalized, archived } = prepareUpdate(run, patch, hooks);
  Object.assign(run, redactPatch(normalized, hooks.redact));
  // The usage-limit resume is the appointment of a `waiting` run (hearsay-tools/cezarion#1236),
  // so a run coming back to life or settling retires it. stageCommit applies the hold predicate;
  // this debounced path mutates the held record with the status-only predicate.
  stageLoaded(run);
  if (normalized.task !== undefined) resolveEditedTaskRefs(run, hooks);
  if (archived !== undefined) hooks.archive(run, archived);
  else hooks.touch(run);
}

export function stageStepUpdate(patch: Partial<Omit<StepState, 'id'>>, redact: (text: string) => string): Partial<Omit<StepState, 'id'>> {
  if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
  if (typeof patch.error !== 'string') return patch;
  return { ...patch, error: redact(patch.error) };
}

/** Stage the ledger before its recipient input, also when both are the same run. The input
 * appends to the recipient's staged queue, so a worker continuation keeps a patched agentInputs. */
export function stageConversation(staged: Map<string, RunRecord>, root: RunRecord, state: ConversationState,
  delivery: { recipientRunId: string; input: AgentInput; recipientDelegation?: DelegationState } | undefined,
  peek: (id: string) => RunRecord | undefined, redact: (text: string) => string): void {
  staged.set(root.id, { ...root, delegation: delegationStateSchema.parse({ ...root.delegation, conversation: { ...state,
    messages: state.messages.map(message => ({ ...message, text: redact(message.text) })),
  } }) });
  if (delivery) {
    const recipient = staged.get(delivery.recipientRunId) ?? peek(delivery.recipientRunId);
    if (!recipient) throw new Error('missing conversation recipient');
    const input = agentInputSchema.parse({ ...delivery.input, text: redact(delivery.input.text) });
    const delegation = !recipient.delegation && delivery.recipientDelegation ? { delegation: delegationStateSchema.parse(delivery.recipientDelegation) } : {};
    staged.set(recipient.id, { ...recipient, ...delegation, agentInputs: [...(recipient.agentInputs ?? []), input] });
  }
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

function prepareCompletionActions(input: ReadonlyMap<string, RunRecord | null>, hooks: CommitHooks): Map<string, RunRecord | null> {
  const staged = new Map(input);
  for (const [id, candidate] of input) {
    if (!candidate) continue;
    const previous = hooks.peek(id);
    let next = candidate;
    const changed = candidate.status === 'done' && !candidate.archived && (
      previous?.status !== 'done' ||
      Boolean(previous.archiveWhenDone) !== Boolean(candidate.archiveWhenDone) ||
      Boolean(previous.autoMergePr) !== Boolean(candidate.autoMergePr));
    if (changed && (candidate.archiveWhenDone || candidate.autoMergePr)) {
      next = { ...candidate, completionAction: { id: randomUUID(), phase: 'pending' } };
      staged.set(id, next);
      if (next.archiveWhenDone && !next.autoMergePr) {
        const blocker = hooks.completionArchiveBlocker(next);
        next.completionAction = { ...next.completionAction!, phase: blocker ? 'blocked' : 'complete', ...(blocker ? { message: blocker } : {}) };
        if (!blocker) hooks.stageArchive(staged, next, true);
      }
    } else if (candidate.status !== 'done' || (!candidate.archiveWhenDone && !candidate.autoMergePr)) {
      if (candidate.completionAction) staged.set(id, { ...candidate, completionAction: undefined });
    }
  }
  return staged;
}

/** Prompt edits can both revoke and restore a reference. Resolve the retained working sets
 *  before notifying readers, using the same ambiguity, marker and repository rules as events. */
function resolveEditedTaskRefs(run: RunRecord, hooks: UpdateHooks): void {
  // An edited prompt is trusted evidence, just like the initial prompt. Collect its new
  // URLs without discarding earlier evidence before applying the usual resolution rules.
  if (hooks.hasPrUrl(run.task)) hooks.trackReferencedPrs(run, run.task);
  if (hooks.hasIssueUrl(run.task)) hooks.trackReferencedIssues(run, run.task);
  if (run.referencedPrCandidates !== undefined) {
    run.referencedPullRequestUrl = hooks.resolveReferencedPr(run);
  }
  if (run.referencedIssueCandidates !== undefined) {
    run.referencedIssueUrl = hooks.resolveIssueReference(run);
    const number = hooks.refUrlNumber(run.referencedIssueUrl);
    if (run.referencedIssueNumberSeeded) {
      // We may change only the number this janitor owns, including clearing an ambiguous one.
      run.issueNumber = number;
      if (number === undefined) delete run.referencedIssueNumberSeeded;
    } else if (number !== undefined && run.issueNumber === undefined &&
      run.markerRefs?.issue === undefined && hooks.hasIssueUrl(run.task)) {
      // A new seed still needs trusted prompt evidence; retained tool output alone is insufficient.
      run.issueNumber = number;
      run.referencedIssueNumberSeeded = true;
    }
  }
  // Legacy records may carry a URL without a candidate array. Preserve that evidence when
  // allowed, while still revoking a foreign URL the edited prompt no longer corroborates.
  hooks.rescopeRun(run);
}

export function stagePullRequests(run: RunRecord, entries: readonly RunPullRequest[], handle?: RepoHandle | null): boolean {
  const next = mergePullRequests(run.pullRequests, entries, handle
    ? `https://github.com/${handle.owner}/${handle.name}` : undefined);
  if (isDeepStrictEqual(next, run.pullRequests)) return false;
  run.pullRequests = next;
  return true;
}

/**
 * Scrub the free-text fields of a record patch (open-mercato/cezar#427 review). Redacting only
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
 * field away (open-mercato/cezar#456 review).
 */
export function redactPatch(
  patch: RecordPatch, redact: (text: string) => string,
): Partial<Omit<RunRecord, 'id' | 'steps'>> {
  if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
  const out = { ...patch };
  for (const field of ['title', 'titleSummary', 'error'] as const) {
    const value = out[field];
    if (typeof value === 'string') out[field] = redact(value);
  }
  return out;
}

export function stageArchiveFields(run: RunRecord, archived: boolean, now: string, withdrawHold: (run: RunRecord) => void, clearPin: (run: RunRecord) => void): void {
  run.archived = archived;
  run.archivedAt = archived ? now : undefined;
  if (archived) { withdrawHold(run); clearPin(run); }
  else run.manualUnarchivedAt = now;
}
