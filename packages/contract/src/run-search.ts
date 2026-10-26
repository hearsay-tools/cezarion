import type { RunSummary } from './runs.ts';

/**
 * The one rule for "does this run match what was typed" (hearsay-tools/cezarion#1807). The project
 * list, All tasks, the archived pages, the ⌘K palette and the SQL prefilter under the last two all
 * ask it, so a run found in one place is found in the others unless a reader says why not, in an
 * option of the call. A new searchable field is one entry in `RUN_SEARCH_FIELDS`.
 *
 * Every whitespace-separated token must match. A token matches a substring of a text field. A
 * number, with a leading `#` stripped, also matches a reference number EXACTLY and an id as a
 * prefix, never digits inside a URL: `86` finding #864 would turn every short query into noise.
 * Any other token also matches inside the id and the URLs.
 *
 * `import type` only, on purpose: the cold reader imports this module and must stay cheap to load.
 */

/** The fields of a run the search reads. A list row, an index row and a full record all fit. */
export type RunSearchRun = Pick<RunSummary,
  | 'id' | 'title' | 'titleSummary' | 'branch' | 'workflow' | 'workflowLabel' | 'automationId'
  | 'pullRequestUrl' | 'referencedPullRequestUrl' | 'referencedIssueUrl' | 'pullRequests'
  | 'prNumber' | 'issueNumber' | 'markerRefs'>;

/**
 * Which fields a reader looks in. `stored` is everything the run holds: the server's search, which
 * reaches history and so also matches ids, URLs and every reference number. `shown` is only what a
 * row prints, plus the reference numbers the row shows: the cockpit's lists, which must not show a
 * row for a reason the reader cannot see. The one exception is the branch, which a folded column
 * hides: pasting a branch name from a terminal to find its task is a deliberate gesture.
 */
export type RunSearchScope = 'stored' | 'shown';

/** `tokens`: every token must match, in any field. `phrase`: the trimmed query is one token. */
export type RunSearchMode = 'tokens' | 'phrase';

/**
 * Automation display names by automation id, for a search whose list shows each task's origin line
 * (hearsay-tools/cezarion#1616). With a lookup, a task an automation launched also matches by that
 * automation's name, or by its recorded id when no definition names it, as the cockpit's own
 * filter does. Without one, the automation is not searched: the ⌘K palette shows no origin line,
 * and a match with no visible reason is noise.
 */
export type AutomationNames = ReadonlyMap<string, string>;

/** What a `shown` reader knows that the run does not carry. A field it leaves out is not searched. */
export interface RunSearchExtras {
  /** The title the row prints. */
  displayTitle?: string | undefined;
  /** The origin line's automation: its name, or its recorded id. */
  automation?: string | undefined;
  projectName?: string | undefined;
  tags?: readonly string[] | undefined;
  /** The reference numbers the row shows. Called only when a token is a number. */
  references?: (() => readonly number[]) | undefined;
}

interface SearchOptionsBase {
  mode?: RunSearchMode;
}

/** The server's reach. Without `automationNames` the automation is not searched. */
export interface StoredRunSearch extends SearchOptionsBase {
  scope?: 'stored';
  automationNames?: AutomationNames | undefined;
}

/** A list's reach: what it prints, from `extras`. */
export interface ShownRunSearch extends SearchOptionsBase {
  scope: 'shown';
  extras: RunSearchExtras;
  /** Fields this reader's rows do not print. A field added later is searched unless listed here. */
  omit?: readonly RunSearchFieldId[];
}

export type RunSearchOptions = StoredRunSearch | ShownRunSearch;

type Texts = (run: RunSearchRun, extras: RunSearchExtras) => ReadonlyArray<string | undefined>;

interface FieldCommon {
  readonly id: string;
  readonly scopes: readonly RunSearchScope[];
  /**
   * `summary`: the text sits verbatim in the run's stored summary JSON, which is all the SQL
   * prefilter can read. `reader`: the reader hands it in (`universe` lists every text it could be).
   */
  readonly source: 'summary' | 'reader';
  /** Every text a `reader` field could hold under `options`, so the prefilter leaves out a token
   *  that could match through it. Required for a `reader` field in the stored scope. */
  readonly universe?: (options: StoredRunSearch) => readonly string[];
}

/** How a token matches: `text` by substring; `identifier` by prefix when it is a number and by
 *  substring otherwise; `link` by substring unless it is a number; `reference` by number alone. */
export type RunSearchField = FieldCommon & (
  | { readonly kind: 'text' | 'identifier' | 'link'; readonly texts: Texts }
  | { readonly kind: 'reference'; readonly numbers: (run: RunSearchRun, extras: RunSearchExtras) => readonly number[] }
);

/** The `#N` in a forge URL — `…/pull/774` → 774. Null when the tail is not a number, so a URL
 *  shape we do not recognise invalidates nothing rather than inventing a key. */
export function refNumberFromUrl(url: string): number | null {
  const last = /\/(\d+)\/?$/.exec(url.trim());
  const parsed = last ? Number(last[1]) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function heldReferences(run: RunSearchRun): number[] {
  const numbers = new Set<number>();
  for (const url of [run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl]) {
    const number = url ? refNumberFromUrl(url) : null;
    if (number !== null) numbers.add(number);
  }
  for (const number of [run.prNumber, run.issueNumber, run.markerRefs?.pr, run.markerRefs?.issue]) {
    if (typeof number === 'number' && Number.isInteger(number) && number > 0) numbers.add(number);
  }
  for (const pr of run.pullRequests ?? []) numbers.add(pr.number);
  return [...numbers];
}

/**
 * THE list of searchable fields. Add a field here and every reader searches it. A reader that
 * must not says so in `omit`, in its own call. The summary-sourced entries are what `runs.db`
 * stores, which is the only thing the SQL prefilter sees (`sqlPrefilterTokens`).
 */
export const RUN_SEARCH_FIELDS = [
  { id: 'title', kind: 'text', scopes: ['stored'], source: 'summary', texts: (run) => [run.title] },
  { id: 'titleSummary', kind: 'text', scopes: ['stored'], source: 'summary', texts: (run) => [run.titleSummary] },
  { id: 'displayTitle', kind: 'text', scopes: ['shown'], source: 'reader', texts: (_run, extras) => [extras.displayTitle] },
  { id: 'branch', kind: 'text', scopes: ['stored', 'shown'], source: 'summary', texts: (run) => [run.branch] },
  { id: 'workflow', kind: 'text', scopes: ['stored', 'shown'], source: 'summary', texts: (run) => [run.workflow] },
  { id: 'workflowLabel', kind: 'text', scopes: ['stored', 'shown'], source: 'summary', texts: (run) => [run.workflowLabel] },
  {
    id: 'automation', kind: 'text', scopes: ['stored', 'shown'], source: 'reader',
    texts: (_run, extras) => [extras.automation],
    universe: (options) => [...(options.automationNames?.values() ?? [])],
  },
  { id: 'projectName', kind: 'text', scopes: ['shown'], source: 'reader', texts: (_run, extras) => [extras.projectName] },
  { id: 'tags', kind: 'text', scopes: ['shown'], source: 'reader', texts: (_run, extras) => extras.tags ?? [] },
  { id: 'id', kind: 'identifier', scopes: ['stored'], source: 'summary', texts: (run) => [run.id] },
  {
    id: 'urls', kind: 'link', scopes: ['stored'], source: 'summary',
    texts: (run) => [run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl, ...(run.pullRequests ?? []).map((pr) => pr.url)],
  },
  { id: 'heldReferences', kind: 'reference', scopes: ['stored'], source: 'summary', numbers: heldReferences },
  { id: 'shownReferences', kind: 'reference', scopes: ['shown'], source: 'reader', numbers: (_run, extras) => extras.references?.() ?? [] },
] as const satisfies readonly RunSearchField[];

export type RunSearchFieldId = (typeof RUN_SEARCH_FIELDS)[number]['id'];

/** The same list, typed by what a field is rather than by which fields there are. */
const FIELDS: readonly RunSearchField[] = RUN_SEARCH_FIELDS;

/** The query as lowercased, whitespace-split tokens, empties dropped. */
export function searchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((token) => token !== '');
}

/** What each token is matched as: the whitespace-split tokens, or the whole trimmed query. */
function queryTokens(query: string, mode: RunSearchMode | undefined): string[] {
  if (mode !== 'phrase') return searchTokens(query);
  const phrase = query.trim().toLowerCase();
  return phrase === '' ? [] : [phrase];
}

/** The origin a row prints for an automation task: its name, else its recorded id. */
function storedOrigin(run: RunSearchRun, names: AutomationNames | undefined): string | undefined {
  return names && run.automationId !== undefined ? names.get(run.automationId) ?? run.automationId : undefined;
}

interface SearchText {
  /** Lowercased text fields. */
  prose: string[];
  /** Lowercased identifiers (the id). */
  ids: string[];
  /** Lowercased links. */
  links: string[];
  /** The reference numbers as strings. Built on the first call: a list that never sees a numeric
   *  token never pays for them. */
  references: () => ReadonlySet<string>;
}

function searchText(run: RunSearchRun, options: RunSearchOptions): SearchText {
  const scope = options.scope ?? 'stored';
  const omit: readonly string[] = options.scope === 'shown' ? options.omit ?? [] : [];
  const extras: RunSearchExtras = options.scope === 'shown'
    ? options.extras : { automation: storedOrigin(run, options.automationNames) };
  const prose: string[] = [];
  const ids: string[] = [];
  const links: string[] = [];
  const buckets = { text: prose, identifier: ids, link: links };
  const numberSources: Array<() => readonly number[]> = [];
  for (const field of FIELDS) {
    if (!field.scopes.includes(scope) || omit.includes(field.id)) continue;
    if (field.kind === 'reference') {
      numberSources.push(() => field.numbers(run, extras));
      continue;
    }
    for (const value of field.texts(run, extras)) {
      if (typeof value === 'string') buckets[field.kind].push(value.toLowerCase());
    }
  }
  let references: Set<string> | undefined;
  return {
    prose, ids, links,
    references: () => references ??= new Set(numberSources.flatMap((numbers) => numbers().map(String))),
  };
}

/**
 * Whether every token of `query` matches `run`, under `options` (stored scope, every-token mode
 * and no automation names when omitted). A blank query matches nothing: a list that shows every
 * row for a blank query decides that itself.
 */
export function matchesRunSearch(run: RunSearchRun, query: string, options: RunSearchOptions = {}): boolean {
  const tokens = queryTokens(query, options.mode);
  if (tokens.length === 0) return false;
  const { prose, ids, links, references } = searchText(run, options);
  return tokens.every((token) => {
    if (prose.some((field) => field.includes(token))) return true;
    const bare = token.replace(/^#/, '');
    if (/^\d+$/.test(bare)) {
      // A pasted id starts with digits as often as letters, so a number may still be its prefix.
      return references().has(String(Number(bare))) || ids.some((id) => id.startsWith(bare));
    }
    return ids.some((id) => id.includes(token)) || links.some((link) => link.includes(token));
  });
}

/**
 * The tokens SQL may narrow rows with, as `instr(lower(summary), ?) > 0` over the stored summary
 * JSON. Only tokens that read the same there: ASCII, since SQLite's `lower()` folds ASCII alone,
 * and without `"` or `\`, which JSON escapes. Leaving a token out only widens the prefilter;
 * `matchesRunSearch` still checks it.
 *
 * A token inside a text a `reader` field could hold is left out too (today, an automation's name):
 * the summary holds the automation's id, not its name, so the row it should find would never
 * reach `matchesRunSearch`. Pass the same options to both.
 */
export function sqlPrefilterTokens(query: string, options: StoredRunSearch = {}): string[] {
  const outside = FIELDS
    .filter((field) => field.scopes.includes('stored') && field.source === 'reader')
    .flatMap((field) => field.universe?.(options) ?? [])
    .map((text) => text.toLowerCase());
  return queryTokens(query, options.mode)
    .map((token) => token.replace(/^#/, ''))
    .filter((token) => token !== '' && /^[\x20-\x7e]+$/.test(token) && !/["\\]/.test(token))
    .filter((token) => !outside.some((text) => text.includes(token)));
}
