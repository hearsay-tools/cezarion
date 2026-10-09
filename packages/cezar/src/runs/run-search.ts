/**
 * The one rule for "does this run match what was typed" (#864): the archived-runs page, the store's
 * search and the cold reader's search all ask it, so a run found in one place is found in all.
 *
 * Every whitespace-separated token must match. A token matches a substring of the run's text
 * fields. A number — with a leading `#` stripped — matches the prose fields as a substring, the
 * id as a prefix, and the reference numbers EXACTLY, never digits inside a URL: `86` finding
 * #864 would turn every short query into noise.
 *
 * Pure and dependency-free on purpose: the cold reader imports it, and the cold reader must stay
 * cheap to load.
 */
import type { RunSummary } from '@open-mercato/cezar-contract';

/** The shortest query the search routes accept. One character matches nearly every run. */
export const MIN_SEARCH_QUERY_LENGTH = 2;

/** The `#N` in a forge URL — `…/pull/774` → 774. Null when the tail is not a number, so a URL
 *  shape we do not recognise invalidates nothing rather than inventing a key. */
export function refNumberFromUrl(url: string): number | null {
  const last = /\/(\d+)\/?$/.exec(url.trim());
  const parsed = last ? Number(last[1]) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The query as lowercased, whitespace-split tokens, empties dropped. */
export function searchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((token) => token !== '');
}

/**
 * The tokens SQL may narrow rows with, as `instr(lower(summary), ?) > 0` over the stored summary
 * JSON. Only tokens that read the same there: ASCII, since SQLite's `lower()` folds ASCII alone,
 * and without `"` or `\`, which JSON escapes. Leaving a token out only widens the prefilter;
 * `matchesRunQuery` still checks it.
 */
export function sqlPrefilterTokens(query: string): string[] {
  return searchTokens(query)
    .map((token) => token.replace(/^#/, ''))
    .filter((token) => token !== '' && /^[\x20-\x7e]+$/.test(token) && !/["\\]/.test(token));
}

function referenceNumbers(run: RunSummary): Set<string> {
  const numbers = new Set<string>();
  for (const url of [run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl]) {
    const number = url ? refNumberFromUrl(url) : null;
    if (number !== null) numbers.add(String(number));
  }
  for (const number of [run.prNumber, run.issueNumber, run.markerRefs?.pr, run.markerRefs?.issue]) {
    if (typeof number === 'number' && Number.isInteger(number) && number > 0) numbers.add(String(number));
  }
  for (const pr of run.pullRequests ?? []) numbers.add(String(pr.number));
  return numbers;
}

/** Whether every token of `query` matches `run`. A blank query matches nothing. */
export function matchesRunQuery(run: RunSummary, query: string): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return false;
  // The fields a person reads. A number typed is a reference or part of a title, never a digit
  // run inside a URL or a uuid: `86` must not find #864 through `…/issues/864` (#864 review).
  const prose = [run.title, run.titleSummary, run.branch, run.workflow, run.workflowLabel]
    .filter((field): field is string => typeof field === 'string').map((field) => field.toLowerCase());
  const urls = [run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl, ...(run.pullRequests ?? []).map(pr => pr.url)]
    .filter((field): field is string => typeof field === 'string').map((field) => field.toLowerCase());
  const id = run.id.toLowerCase();
  let numbers: Set<string> | undefined;
  return tokens.every((token) => {
    if (prose.some((field) => field.includes(token))) return true;
    const bare = token.replace(/^#/, '');
    if (/^\d+$/.test(bare)) {
      numbers ??= referenceNumbers(run);
      // A pasted id starts with digits as often as letters, so a number may still be its prefix.
      return numbers.has(String(Number(bare))) || id.startsWith(bare);
    }
    return id.includes(token) || urls.some((field) => field.includes(token));
  });
}
