import { productEnv } from '../core/product-env.ts';
/**
 * The record write rules (ADR 0056, Decision 4 of .ai/specs/2026-11-03-run-store-owns-exits.md):
 * one ordered list, `RECORD_WRITE_RULES`, that every write path runs with its path as input.
 * Each rule names the paths it runs on (`on`). A rule that runs on only one of the two update
 * saves, or that the two saves apply differently, names that difference (`difference`), so a rule
 * one path skips is visible in the list: four fixes found such a skip after the rules left the
 * store (hearsay-tools/cezarion#2377 to hearsay-tools/cezarion#2382).
 *
 * The paths:
 * - `commit`: every store commit (`commitIndex`), on the staged records before they persist;
 * - `durableUpdate`: an update that commits at once, on a staged copy; its commit then runs `commit`;
 * - `debouncedUpdate`: an update the next save writes, on the held record;
 * - `loaded`: a record the store loads;
 * - `conversation`: a conversation ledger and the input it delivers;
 * - `pullRequests`: the PRs a run accumulates (updates, marker declarations, PR discovery, events);
 * - `archiveFields`: the fields an archive or restore sets (`stageArchive`, updates, bulk archive);
 * - `stepUpdate`: a step patch.
 *
 * Redaction: the store's `redact` owns the `CEZ_REDACT_SECRETS=0` opt-out, which skips host
 * secrets only, so every redaction rule scrubs session secrets (hearsay-tools/cezarion#2325).
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { agentInputSchema, delegationStateSchema } from '@open-mercato/cezar-contract/delegation';
import { runPullRequestSchema } from '@open-mercato/cezar-contract/runs';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import type { AgentInput, ConversationState, DelegationState, RunPullRequest } from '@open-mercato/cezar-contract';
import { redactSecrets } from '../core/secret-redaction.ts';
import { ConversationIdInUseError } from './conversation-identity.ts';
import { mergePullRequests } from './pull-requests.ts';
import { applyExit } from './run-exits.ts';
import {
  ISSUE_URL_RE, PR_URL_RE, refUrlNumber, referencedPrDeclaration, rescopeRun, resolveIssueReference, resolveReferencedRef,
  trackReferencedIssues, trackReferencedPrs,
} from './run-references.ts';
import type { RepoHandle, RunRecord, StepState } from './store.ts';

/** The fields an update writes: a run exit's write may carry the steps it settled (`applyExit`). */
export type RecordPatch = Partial<Omit<RunRecord, 'id' | 'steps'>> & { steps?: StepState[] };
type StepPatch = Partial<Omit<StepState, 'id'>>;

export const WRITE_PATHS = ['commit', 'durableUpdate', 'debouncedUpdate', 'loaded', 'conversation', 'pullRequests', 'archiveFields', 'stepUpdate'] as const;
export type WritePath = (typeof WRITE_PATHS)[number];

/** What a commit reads from the store: the records it holds and the family archive it stages. */
interface CommitHooks {
  peek(id: string): RunRecord | undefined;
  completionArchiveBlocker(run: RunRecord): string | undefined;
  stageArchive(staged: Map<string, RunRecord | null>, run: RunRecord, archived: boolean): void;
}

/** What an update reads from the store: its secrets, its repository, the run's transcript and the
 *  debounced save. */
interface UpdateHooks {
  redact(text: string): string;
  repoHandle?: RepoHandle | null | undefined;
  /** Restore the run's plain transcript. */
  restore(): void;
  /** The debounced archive: the transcript form, the archive fields, then the save. */
  archive(run: RunRecord, archived: boolean): unknown;
  /** The debounced save. */
  touch(run: RunRecord): void;
}

type ConversationDelivery = { recipientRunId: string; input: AgentInput; recipientDelegation?: DelegationState };

/** One write in progress, per path. A rule changes the fields its path stages. */
interface Writes {
  commit: { path: 'commit'; staged: Map<string, RunRecord | null>; hooks: CommitHooks };
  durableUpdate: UpdateWrite;
  debouncedUpdate: UpdateWrite;
  loaded: { path: 'loaded'; run: RunRecord };
  conversation: {
    path: 'conversation'; staged: Map<string, RunRecord>; root: RunRecord; state: ConversationState;
    delivery: ConversationDelivery | undefined; recipient?: RunRecord; input?: AgentInput;
    peek(id: string): RunRecord | undefined; redact(text: string): string;
  };
  pullRequests: { path: 'pullRequests'; run: RunRecord; entries: readonly RunPullRequest[]; handle: RepoHandle | null | undefined; changed: boolean };
  archiveFields: { path: 'archiveFields'; run: RunRecord; archived: boolean; now: string };
  stepUpdate: { path: 'stepUpdate'; patch: StepPatch; redact(text: string): string };
}
/** An update: `run` is the held record, and on a durable save the staged copy from `assign` on.
 *  `archived` is the archive flag `restore` takes off the patch. */
type UpdateWrite = { path: 'durableUpdate' | 'debouncedUpdate'; run: RunRecord; patch: RecordPatch; archived: boolean | undefined; hooks: UpdateHooks };

type RecordWriteRule = {
  id: string;
  on: readonly WritePath[];
  /** Why the rule runs on one update save only, or differs between them. */
  difference?: string;
  apply(write: Writes[WritePath]): void;
};

function rule<P extends WritePath>(id: string, on: readonly P[], apply: (write: Writes[P]) => void, difference?: string): RecordWriteRule {
  return { id, on, ...(difference ? { difference } : {}), apply: write => apply(write as Writes[P]) };
}

const UPDATES = ['durableUpdate', 'debouncedUpdate'] as const;
const hasOwn = (patch: object, key: string) => Object.prototype.hasOwnProperty.call(patch, key);

/** The rules, in the order every path runs them. */
export const RECORD_WRITE_RULES: readonly RecordWriteRule[] = [
  // A patched issue number is its writer's, no longer the number reference resolution seeded.
  rule('issue-seed', UPDATES, ({ run, patch }) => { if (hasOwn(patch, 'issueNumber')) delete run.referencedIssueNumberSeeded; }),
  rule('pull-requests', UPDATES, ({ run, patch, hooks }) => {
    if (patch.pullRequestUrl === undefined) return;
    stagePullRequests(run, [run.pullRequestUrl, patch.pullRequestUrl].flatMap((url) => {
      const number = refUrlNumber(url);
      if (number === undefined) return [];
      const parsed = runPullRequestSchema.safeParse({ number, url, source: 'created' });
      return parsed.success ? [parsed.data] : [];
    }), hooks.repoHandle);
  }),
  // Takes the archive flag off the patch. Restores before the patch is written, so a throw leaves
  // status and archived unchanged (hearsay-tools/cezarion#818 S3). Waits are not cleared on an
  // update: RunManager cancels them when a run ends (spec 2026-10-17-unified-waits).
  rule('restore', UPDATES, (write) => {
    if (!hasOwn(write.patch, 'archived')) return;
    const { archived, archivedAt: _archivedAt, ...patch } = write.patch;
    write.patch = patch;
    write.archived = Boolean(archived);
    if (!write.archived) write.hooks.restore();
  }),
  rule('redact-patch', UPDATES, (write) => { write.patch = redactPatch(write.patch, write.hooks.redact); }),
  rule('assign', UPDATES, (write) => {
    if (write.path === 'durableUpdate') write.run = { ...write.run, ...write.patch };
    else Object.assign(write.run, write.patch);
  }, 'The durable save writes a staged copy, which its commit persists before it replaces the held record; the debounced save writes the held record. The rules before it change the held record on both.'),
  rule('retire-completion-action', ['debouncedUpdate'], ({ run }) => {
    if (run.completionAction && completionActionRetired(run)) run.completionAction = undefined;
  }, 'The durable save retires an action in its commit (completion-actions), so every path stores one action state per run state (hearsay-tools/cezarion#2324).'),
  // A resume time is the appointment of a `waiting` run (hearsay-tools/cezarion#1236,
  // hearsay-tools/cezarion#1496), so a run coming back to life or settling retires it. Open waits
  // survive at every status: recovery owns their cancellation. `autoResumeAttempts` stays, since
  // `MAX_AUTO_RESUMES` counts attempts across resumes.
  rule('stale-resume', ['commit', 'debouncedUpdate', 'loaded'], (write) => {
    if (write.path !== 'commit') {
      if (isStaleResume(write.run)) write.run.autoResumeAt = undefined;
      return;
    }
    // A copy, set to `undefined` and never deleted: a caller may stage the held record itself.
    for (const [id, run] of [...write.staged]) if (run && isStaleResume(run)) write.staged.set(id, { ...run, autoResumeAt: undefined });
  }, 'The durable save takes it in its commit. A commit stages a copy; the debounced save and a load change the held record.'),
  rule('completion-actions', ['commit'], prepareCompletionActions,
    'Only a commit creates an action, because the action and its archive must be durable: updateRun routes an opted-in Done and option changes to a commit (hearsay-tools/cezarion#2324). The debounced save only retires one (retire-completion-action).'),
  // Both update saves resolve an edited task alike (hearsay-tools/cezarion#2323).
  rule('task-references', UPDATES, ({ run, patch, hooks }) => { if (patch.task !== undefined) resolveEditedTaskRefs(run, hooks.repoHandle); }),
  rule('archive-fields', ['durableUpdate'], ({ run, archived }) => {
    if (archived !== undefined) stageArchiveFields(run, archived, new Date().toISOString());
  }, 'The durable save sets the archive fields on its copy, and its commit queues the transcript compression. The debounced save archives through archive-or-touch.'),
  rule('archive-or-touch', ['debouncedUpdate'], ({ run, archived, hooks }) => {
    if (archived !== undefined) hooks.archive(run, archived);
    else hooks.touch(run);
  }, 'The debounced save archives the held record with its transcript form, then saves it; without an archive flag it only saves. The durable save archives through archive-fields and saves in its commit.'),
  rule('merge-pull-requests', ['pullRequests'], (write) => {
    const next = mergePullRequests(write.run.pullRequests, write.entries, write.handle
      ? `https://github.com/${write.handle.owner}/${write.handle.name}` : undefined);
    if (isDeepStrictEqual(next, write.run.pullRequests)) return;
    write.run.pullRequests = next;
    write.changed = true;
  }),
  rule('archive-time', ['archiveFields'], ({ run, archived, now }) => {
    run.archived = archived;
    run.archivedAt = archived ? now : undefined;
    if (!archived) run.manualUnarchivedAt = now;
  }),
  rule('withdraw-hold', ['archiveFields'], ({ run, archived }) => { if (archived) withdrawHold(run); }),
  rule('clear-pin', ['archiveFields'], ({ run, archived }) => { if (archived) clearPin(run); }),
  // The ledger is staged before its recipient input, also when both are the same run.
  rule('redact-messages', ['conversation'], (write) => {
    write.state = { ...write.state, messages: write.state.messages.map(message => ({ ...message, text: write.redact(message.text) })) };
  }),
  rule('parse-delegation', ['conversation'], ({ staged, root, state }) => {
    staged.set(root.id, { ...root, delegation: delegationStateSchema.parse({ ...root.delegation, conversation: state }) });
  }),
  // The staged queue can differ from the stored one: a continuation patch may set it.
  rule('find-recipient', ['conversation'], (write) => {
    if (!write.delivery) return;
    const recipient = write.staged.get(write.delivery.recipientRunId) ?? write.peek(write.delivery.recipientRunId);
    if (!recipient) throw new Error('missing conversation recipient');
    const id = write.delivery.input.id;
    if (recipient.agentInputs?.some(queued => queued.id === id)) throw new ConversationIdInUseError();
    write.recipient = recipient;
  }),
  rule('redact-input', ['conversation'], (write) => {
    if (write.delivery) write.input = { ...write.delivery.input, text: write.redact(write.delivery.input.text) };
  }),
  rule('parse-input', ['conversation'], (write) => { if (write.input) write.input = agentInputSchema.parse(write.input); }),
  // The input appends to the recipient's staged queue, so a worker continuation keeps a patched agentInputs.
  rule('append-input', ['conversation'], ({ staged, delivery, recipient, input }) => {
    if (!delivery || !recipient || !input) return;
    const delegation = !recipient.delegation && delivery.recipientDelegation ? { delegation: delegationStateSchema.parse(delivery.recipientDelegation) } : {};
    staged.set(recipient.id, { ...recipient, ...delegation, agentInputs: [...(recipient.agentInputs ?? []), input] });
  }),
  // `StepState.error` is the step-level counterpart of the run's `error`: `run.ts` feeds the same
  // message to both (open-mercato/cezar#456 review).
  rule('redact-step-error', ['stepUpdate'], (write) => {
    if (typeof write.patch.error === 'string') write.patch = { ...write.patch, error: write.redact(write.patch.error) };
  }),
];

function runRules<P extends WritePath>(write: Writes[P]): Writes[P] {
  for (const each of RECORD_WRITE_RULES) if (each.on.includes(write.path)) each.apply(write);
  return write;
}

/** The rules `path` runs, in order. */
export function writePathRules(path: WritePath): string[] {
  return RECORD_WRITE_RULES.filter(each => each.on.includes(path)).map(each => each.id);
}

export function stageCommit(input: ReadonlyMap<string, RunRecord | null>, hooks: CommitHooks): Map<string, RunRecord | null> {
  return runRules<'commit'>({ path: 'commit', staged: new Map(input), hooks }).staged;
}

export function stageLoaded(run: RunRecord): void {
  runRules<'loaded'>({ path: 'loaded', run });
}

export function stageDurableUpdate(run: RunRecord, patch: RecordPatch, hooks: UpdateHooks): RunRecord {
  return runRules<'durableUpdate'>({ path: 'durableUpdate', run, patch, archived: undefined, hooks }).run;
}

export function stageDebouncedUpdate(run: RunRecord, patch: RecordPatch, hooks: UpdateHooks): void {
  runRules<'debouncedUpdate'>({ path: 'debouncedUpdate', run, patch, archived: undefined, hooks });
}

export function stageStepUpdate(patch: StepPatch, redact: (text: string) => string): StepPatch {
  return runRules<'stepUpdate'>({ path: 'stepUpdate', patch, redact }).patch;
}

export function stageConversation(staged: Map<string, RunRecord>, root: RunRecord, state: ConversationState,
  delivery: ConversationDelivery | undefined, peek: (id: string) => RunRecord | undefined, redact: (text: string) => string): void {
  runRules<'conversation'>({ path: 'conversation', staged, root, state, delivery, peek, redact });
}

export function stagePullRequests(run: RunRecord, entries: readonly RunPullRequest[], handle?: RepoHandle | null): boolean {
  return runRules<'pullRequests'>({ path: 'pullRequests', run, entries, handle, changed: false }).changed;
}

export function stageArchiveFields(run: RunRecord, archived: boolean, now: string): void {
  runRules<'archiveFields'>({ path: 'archiveFields', run, archived, now });
}

/** The one stale-resume rule, on every write path (hearsay-tools/cezarion#2322): a resume time is
 *  the appointment of a `waiting` run, so any time that is not a usage-limit hold is stale. */
function isStaleResume(run: RunRecord): boolean {
  return run.autoResumeAt !== undefined && !isUsageLimitHold(run);
}

export function redactText(text: string, sessionSecrets: readonly string[], hostSecrets: () => readonly string[]): string {
  const safe = sessionSecrets.length ? redactSecrets(text, sessionSecrets) : text;
  if (productEnv('REDACT_SECRETS') === '0') return safe;
  return redactSecrets(safe, hostSecrets());
}

/** Iterates the records the commit staged before it: an archive this rule stages adds the family. */
function prepareCompletionActions(write: Writes['commit']): void {
  const { staged, hooks } = write;
  for (const [id, candidate] of [...staged]) {
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
    } else if (candidate.completionAction && completionActionRetired(candidate)) {
      staged.set(id, { ...candidate, completionAction: undefined });
    }
  }
}

/** An action has meaning only on a Done run with a completion option on. */
function completionActionRetired(run: RunRecord): boolean {
  return run.status !== 'done' || (!run.archiveWhenDone && !run.autoMergePr);
}

/** Prompt edits can both revoke and restore a reference. Resolve the retained working sets
 *  before notifying readers, using the same ambiguity, marker and repository rules as events. */
function resolveEditedTaskRefs(run: RunRecord, handle: RepoHandle | null | undefined): void {
  // An edited prompt is trusted evidence, just like the initial prompt. Collect its new
  // URLs without discarding earlier evidence before applying the usual resolution rules.
  if (PR_URL_RE.test(run.task)) trackReferencedPrs(run, run.task, handle);
  if (ISSUE_URL_RE.test(run.task)) trackReferencedIssues(run, run.task, handle);
  if (run.referencedPrCandidates !== undefined) {
    run.referencedPullRequestUrl = resolveReferencedRef(run.referencedPrCandidates, run.task, referencedPrDeclaration(run), handle);
  }
  if (run.referencedIssueCandidates !== undefined) {
    run.referencedIssueUrl = resolveIssueReference(run, handle);
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
  rescopeRun(run, handle);
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
 * `StepState.error` is the step-level counterpart, scrubbed by `redact-step-error`.
 */
export function redactPatch(
  patch: RecordPatch, redact: (text: string) => string,
): Partial<Omit<RunRecord, 'id' | 'steps'>> {
  const out = { ...patch };
  for (const field of ['title', 'titleSummary', 'error'] as const) {
    const value = out[field];
    if (typeof value === 'string') out[field] = redact(value);
  }
  // A patched input queue persists as written, so its text is scrubbed like a delivered input.
  if (out.agentInputs) out.agentInputs = out.agentInputs.map(input => ({ ...input, text: redact(input.text) }));
  return out;
}

/**
 * Archiving IS resigning from a task, so an archived run can never carry a pending usage-limit
 * resume (spec 2026-08-03-auto-resume-after-usage-limit). The rule lives in the archive fields
 * rather than in the archive route because the bulk "Archive finished" sweep never goes through
 * that route, and a user who archives fifty finished tasks has resigned from all fifty.
 *
 * The engine needs no telling: its timer re-reads the record before it fires and no sweep re-arms
 * an archived run, so a cleared field is the whole cancellation.
 */
function withdrawHold(run: RunRecord): void {
  // A withdrawn appointment settles the run failed with its kept error (hearsay-tools/cezarion#1236),
  // the state a usage-limited run was in before it waited.
  if (isUsageLimitHold(run)) Object.assign(run, applyExit(run, 'withdraw-hold'));
  run.autoResumeAt = undefined;
  run.autoResumeAttempts = undefined;
  run.autoResumeReason = undefined;
}

/**
 * Archiving is resigning from a task, so it retires the pin too (#935) — a pin on a task the
 * user has filed away is stale by definition, and the archived view collapses into one bucket
 * anyway, so a surviving pin would be invisible state waiting to surprise whoever unarchives.
 *
 * Here rather than in the pin route for the same reason `withdrawHold` is: the bulk "Archive
 * finished" sweep never goes through a route, and it has to obey the rule too.
 *
 * Deleted, not set to `false`: absent is what every reader treats as unpinned, and it is the
 * shape a cezar that has never heard of pins already writes.
 */
export function clearPin(run: RunRecord): void {
  delete run.pinned;
  delete run.pinnedAt;
}
