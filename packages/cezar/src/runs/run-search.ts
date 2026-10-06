/**
 * The one rule for "does this run match what was typed" (#864): the archived-runs page, the store's
 * search and the cold reader's search all ask it, so a run found in one place is found in all.
 *
 * Every whitespace-separated token must match. A token matches a substring of the run's text
 * fields, or — with a leading `#` stripped — EXACTLY one of its reference numbers: `86` finding
 * #864 by number would turn every short query into noise.
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
  return numbers;
}

/** Whether every token of `query` matches `run`. A blank query matches nothing. */
export function matchesRunQuery(run: RunSummary, query: string): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return false;
  const text = [
    run.title, run.titleSummary, run.id, run.branch, run.workflow, run.workflowLabel,
    run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl,
  ].filter((field): field is string => typeof field === 'string').map((field) => field.toLowerCase());
  let numbers: Set<string> | undefined;
  return tokens.every((token) => {
    if (text.some((field) => field.includes(token))) return true;
    const bare = token.replace(/^#/, '');
    if (!/^\d+$/.test(bare)) return false;
    numbers ??= referenceNumbers(run);
    return numbers.has(String(Number(bare)));
  });
}
