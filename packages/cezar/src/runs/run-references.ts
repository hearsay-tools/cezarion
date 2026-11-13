/**
 * A run's task references: the PR and issue URLs its prompt and events name, and the rules that
 * resolve the referenced PR and issue from them (spec 2026-07-16-pr-autodiscovery, spec
 * 2026-07-21-report-ref-discovery). Pure but for the record each function changes; the store and
 * the record write rules (`record-write-rules.ts`) both apply them.
 */
import { isDeepStrictEqual } from 'node:util';
import { runPullRequestSchema } from '@open-mercato/cezar-contract/runs';
import type { RunEvent, RunPullRequest } from '@open-mercato/cezar-contract';
import { mergePullRequests } from './pull-requests.ts';
import { extractTaskRefs, isRepoScopedRef, MAX_REF, refUrlRepo } from './task-refs.ts';
import type { RepoHandle, RunRecord } from './store.ts';

export const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
export const ISSUE_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;

// The transcript auto-link is convenience only (the cockpit's own `gh pr create` path sets the
// URL authoritatively). Adopt a PR URL ONLY when the agent actually CREATED one — a task that
// reviews or merely references an existing PR must not get mislabeled with its number (#fake-pr).
const CREATED_PR_RE =
  /\b(?:gh\s+pr\s+create|pull\s*request\s+created|created\s+(?:a\s+)?(?:draft\s+)?(?:pr|pull\s*request)|opened\s+(?:a\s+)?(?:draft\s+)?pull\s*request)\b/i;

/** Referenced-tier working-set cap (spec 2026-07-16-pr-autodiscovery): past
 *  this many distinct PRs the conversation is a survey, not a subject. */
const MAX_PR_CANDIDATES = 8;

/**
 * Resolve declarations and prompt-supported candidates without guessing through ambiguity. Apply
 * repository scope to the winner only; filtering candidates first could promote an otherwise
 * ambiguous reference.
 */
export function resolveReferencedRef(
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
export function refUrlNumber(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const n = Number(url.split('/').pop());
  return Number.isInteger(n) && n > 0 && n < MAX_REF ? n : undefined;
}

/**
 * Ignore a created-PR declaration when resolving the referenced subject, so a task can retain
 * both its original subject and its new PR.
 */
export function referencedPrDeclaration(run: RunRecord): number | undefined {
  const declared = run.markerRefs?.pr;
  if (declared === undefined) return undefined;
  return declared === refUrlNumber(run.pullRequestUrl) ? undefined : declared;
}

/** Prompt attribution survives declarations of follow-up issues. Bare hashes become issues
 * only after an issue signal; explicit PR prompts never acquire an invented issue identity. */
export function originatingIssue(run: RunRecord): number | undefined {
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

export function resolveIssueReference(run: RunRecord, handle?: RepoHandle | null): string | undefined {
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

export function restoreOriginatingIssue(run: RunRecord): void {
  const origin = originatingIssue(run);
  if (origin === undefined || run.markerRefs?.issue === undefined) return;
  run.issueNumber = origin;
  delete run.referencedIssueNumberSeeded;
  if (run.referencedIssueCandidates !== undefined || refUrlNumber(run.referencedIssueUrl) !== origin) {
    run.referencedIssueUrl = resolveIssueReference(run);
  }
}

/** Whether a stored summary names a referenced PR or issue, or a declared PR, outside `handle`'s
 *  repository: a row `rescopeRun` may change once the handle is known (`LOAD_REPAIR_SQL`, store.ts). */
export function namesForeignReference(summary: Pick<RunRecord, 'referencedPullRequestUrl' | 'referencedIssueUrl' | 'pullRequests'>, handle: RepoHandle): boolean {
  const own = `${handle.owner}/${handle.name}`.toLowerCase();
  const declared = (summary.pullRequests ?? []).filter((entry) => entry.source === 'declared').map((entry) => entry.url);
  return [summary.referencedPullRequestUrl, summary.referencedIssueUrl, ...declared].some((url) => url !== undefined && refUrlRepo(url) !== own);
}

/**
 * Drop this run's referenced PR/issue if the project's handle proves it foreign and the prompt
 * does not corroborate it (#945). Returns whether anything changed.
 *
 * One-directional by construction: it only ever clears fields, so a record written by an older
 * Squawk — or read by one after this ran — is never worse off, and a downgrade sees a record whose
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
 * Fold every PR URL in `haystack` into the run's referenced-tier working
 * set and re-resolve `referencedPullRequestUrl` (spec
 * 2026-07-16-pr-autodiscovery). Mutates the record in place — the caller
 * owns persistence/fan-out — and reports whether anything changed.
 */
export function trackReferencedPrs(run: RunRecord, haystack: string, handle?: RepoHandle | null): boolean {
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
    handle,
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
export function trackReferencedIssues(
  run: RunRecord,
  haystack: string,
  handle?: RepoHandle | null,
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
  run.referencedIssueUrl = resolveIssueReference(run, handle);
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
 * Every scannable string of one persisted event: the v1 top-level fields plus
 * the protocol-v2 `item.*` content (nested — the reason v2 streams were
 * invisible to the janitor, #407). Reasoning items are skipped: thinking text
 * speculates about PRs the task never touches.
 */
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
  pushAssistantMessageFragment(event, fragments);
  const item = event.item;
  if (item && typeof item === 'object') {
    const it = item as Record<string, unknown>;
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
  pushAssistantMessageFragment(event, fragments);
  return fragments;
}

/** The assistant's own message text in a v2 `item.*` payload, if any — the one
 * fragment shape both the creation-claim and agent-text readers accept. */
function pushAssistantMessageFragment(event: Record<string, unknown>, fragments: string[]): void {
  const item = event.item;
  if (item && typeof item === 'object') {
    const it = item as Record<string, unknown>;
    if (it.kind === 'message' && it.role === 'assistant' && typeof it.text === 'string') {
      fragments.push(it.text);
    }
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
 * One associated URL per trusted creation claim; replayed v1/v2 reports merge by identity.
 * Stages each parsed URL through the store's staging callback and gives the first one the
 * run's `pullRequestUrl`. Reports whether anything changed.
 */
function claimCreatedPullRequests(
  run: RunRecord,
  created: readonly string[],
  accumulatePullRequests: (run: RunRecord, entries: readonly RunPullRequest[]) => boolean,
): boolean {
  let changed = false;
  for (const url of created) {
    const number = refUrlNumber(url);
    const parsed = runPullRequestSchema.safeParse({ number, url, source: 'created' });
    if (!parsed.success) continue;
    changed = accumulatePullRequests(run, [parsed.data]) || changed;
    if (!run.pullRequestUrl) { run.pullRequestUrl = url; changed = true; }
  }
  return changed;
}

/**
 * The janitor trick: agents print the PR URL after `gh pr create` — the
 * first one spotted in the transcript becomes the run's PR link. Scans v1
 * fields AND nested v2 `item.*` content (#407). A URL without the created
 * phrasing still feeds the referenced tier (the PR the task is about) —
 * and the phrasing itself is only believed from a source that can speak
 * FOR this run (`eventCreationClaimFragments`), never from quoted output.
 *
 * Runs after the event is appended, indexed and emitted: discovery reads the
 * event text and may still update and touch the run.
 * `accumulatePullRequests` is the store's staging callback
 * (`stagePullRequests` with the store's repo handle); `touch` is the
 * store's dirty/save/fan-out signal.
 */
export function scanEventReferences(
  run: RunRecord,
  event: RunEvent,
  repoHandle: RepoHandle | null | undefined,
  accumulatePullRequests: (run: RunRecord, entries: readonly RunPullRequest[]) => boolean,
  touch: (run: RunRecord) => void,
): void {
  const haystack = eventTextFragments(event).join(' ');
  const agentHaystack = eventAgentTextFragments(event).join(' ');
  // The creation CLAIM is read from a narrower source than the URL is
  // (`eventCreationClaimFragments`), which is why the two are searched
  // together rather than the haystack alone: the phrase must land in the
  // trusted prefix, and the link may come from anywhere after it.
  const claim = eventCreationClaimFragments(event).join(' ');
  if (haystack.length > 0) {
    const item = event.item as Record<string, unknown> | undefined;
    const toolOutput = item?.kind === 'tool' && typeof item.output === 'string' ? item.output : undefined;
    const created = createdPrUrls(claim, haystack, toolOutput);
    let changed = claimCreatedPullRequests(run, created, accumulatePullRequests);
    if (created.length > 0) {
      const resolved = resolveReferencedRef(
        run.referencedPrCandidates ?? [], run.task, referencedPrDeclaration(run), repoHandle,
      );
      if (resolved !== run.referencedPullRequestUrl) {
        run.referencedPullRequestUrl = resolved;
        changed = true;
      }
    } else if (!run.pullRequestUrl && PR_URL_RE.test(haystack) && trackReferencedPrs(run, haystack, repoHandle)) {
      changed = true;
    }
    // Issue links feed their own referenced tier regardless of PR state —
    // a task that created a PR can still be ABOUT an issue
    // (spec 2026-07-21-report-ref-discovery).
    if (
      ISSUE_URL_RE.test(haystack) &&
      trackReferencedIssues(run, haystack, repoHandle, agentHaystack)
    ) {
      changed = true;
    }
    if (changed) touch(run);
  }
}
