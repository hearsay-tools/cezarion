/**
 * A run's task references: the PR and issue URLs its prompt and events name, and the rules that
 * resolve the referenced PR and issue from them (spec 2026-07-16-pr-autodiscovery, spec
 * 2026-07-21-report-ref-discovery). Pure but for the record each function changes; the store and
 * the record write rules (`record-write-rules.ts`) both apply them.
 */
import { isDeepStrictEqual } from 'node:util';
import { mergePullRequests } from './pull-requests.ts';
import { extractTaskRefs, isRepoScopedRef, MAX_REF } from './task-refs.ts';
import type { RepoHandle, RunRecord } from './store.ts';

export const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
export const ISSUE_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;

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
