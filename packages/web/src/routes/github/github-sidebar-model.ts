import {
  GITHUB_SEARCH_MAX,
  type GithubData,
  type GithubItem,
  type GithubSearchData,
  type RunRecord,
} from '@open-mercato/cezar-api-client'

import { taskReferences } from '@/lib/tasks-table'

/**
 * The GitHub view's own sidebar list (#622): which filters exist, what URL each one is, and how
 * its count is derived. Pure and React-free on purpose — the desktop sidebar, the mobile filter
 * screen and the main list all read the SAME rules from here, so a row's count and the list it
 * opens can never disagree about what "Has a task" or "Review requested" means.
 *
 * Nothing here invents data. A count is `null` (unknown) when its source has not answered, and a
 * lower bound (`atLeast`) when its source is capped: the open list at `GITHUB_LIST_LIMIT`, and a
 * qualifier search at the server's `GITHUB_SEARCH_MAX` hits.
 */

export type GithubListView = 'issues' | 'prs'

export const ISSUE_FILTERS = ['assigned', 'no-task', 'has-task', 'all'] as const
export const PR_FILTERS = ['review', 'mine', 'failing', 'all'] as const
export type IssueFilter = (typeof ISSUE_FILTERS)[number]
export type PrFilter = (typeof PR_FILTERS)[number]
export type GithubFilter = IssueFilter | PrFilter

/** The row ids (`data-gh-filter`): `all` is the Issues row, `all-prs` its pull-request twin. */
export type GithubRowId = 'assigned' | 'no-task' | 'has-task' | 'all' | 'review' | 'mine' | 'failing' | 'all-prs'

/** The open-list fetch cap. A count that reaches it reads `N+`. */
export const GITHUB_LIST_LIMIT = 1000
export const GITHUB_FILTER_SEARCH_CAP = GITHUB_SEARCH_MAX

/** `gh search prs` qualifiers, passed through the existing `/github/search` route verbatim. */
export const REVIEW_QUERY = 'is:open review-requested:@me'
export const FAILING_QUERY = 'is:open status:failure'

export function isSearchBackedFilter(view: GithubListView, filter: GithubFilter | null): boolean {
  return view === 'prs' && (filter === 'review' || filter === 'failing')
}

export function searchQueryFor(filter: GithubFilter | null): string | null {
  return filter === 'review' ? REVIEW_QUERY : filter === 'failing' ? FAILING_QUERY : null
}

/** `null` = no `filter` param at all; an unknown or foreign-view value falls back to `all`. */
export function parseGithubFilter(view: GithubListView, raw: string | null): GithubFilter | null {
  if (raw === null) return null
  const allowed: readonly string[] = view === 'issues' ? ISSUE_FILTERS : PR_FILTERS
  return allowed.includes(raw) ? (raw as GithubFilter) : 'all'
}

/** The list (or, with `number`, detail) path. A filter is always written explicitly so a bare
 *  `/github` keeps its own meaning (remembered tab on desktop, the filter screen on a phone). */
export function githubFilterPath(view: GithubListView, filter: GithubFilter | null, number?: number, tail = ''): string {
  const base = view === 'issues' ? '/github' : '/github/prs'
  const path = `${number === undefined ? base : `${view === 'issues' ? '/github/issues' : '/github/prs'}/${number}`}${tail}`
  return filter === null ? path : `${path}?filter=${encodeURIComponent(filter)}`
}

export function rowIdOf(view: GithubListView, filter: GithubFilter | null): GithubRowId {
  const effective = filter ?? 'all'
  return effective === 'all' ? (view === 'issues' ? 'all' : 'all-prs') : effective
}

export function filterForRow(id: GithubRowId): { view: GithubListView; filter: GithubFilter } {
  if (id === 'all') return { view: 'issues', filter: 'all' }
  if (id === 'all-prs') return { view: 'prs', filter: 'all' }
  return { view: id === 'review' || id === 'mine' || id === 'failing' ? 'prs' : 'issues', filter: id }
}

export const ISSUE_ROWS: readonly { id: GithubRowId; label: string }[] = [
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'no-task', label: 'No task yet' },
  { id: 'has-task', label: 'Has a task' },
  { id: 'all', label: 'All open' },
]
/** The board lists three pull-request filters and no "All open": every open PR is one click away
 *  on the main header's Pull requests tab, and `all-prs` stays a row id so a bare PR list still
 *  resolves to a filter (it simply lights no sidebar row). */
export const PR_ROWS: readonly { id: GithubRowId; label: string }[] = [
  { id: 'review', label: 'Review requested' },
  { id: 'mine', label: 'Mine' },
  { id: 'failing', label: 'Checks failing' },
]

/** The filter's name as the main header's title says it ("Issues · No task yet"). */
export const ACTIVE_FILTER_LABEL: Record<GithubFilter, string> = Object.fromEntries(
  [...ISSUE_ROWS, ...PR_ROWS].map((row) => [row.id, row.label]),
) as Record<GithubFilter, string>

export interface FilterCount {
  value: number
  /** `atLeast` when the source was capped, so the real number may be higher. */
  bound: 'exact' | 'atLeast'
}

export function formatCount(count: FilterCount | null): string {
  return count === null ? '' : `${count.value}${count.bound === 'atLeast' ? '+' : ''}`
}

/** Tooltip that says why a count is a lower bound, or why it is missing. */
export function countTitle(id: GithubRowId, count: FilterCount | null): string | undefined {
  if (count?.bound !== 'atLeast') return undefined
  return id === 'review' || id === 'failing'
    ? `At least ${count.value}: GitHub search returns at most ${GITHUB_FILTER_SEARCH_CAP} results.`
    : `At least ${count.value}: only the first ${GITHUB_LIST_LIMIT} open items are loaded.`
}

const sameLogin = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()

/** `https://host/owner/name/issues/N` → `owner/name` (lower-cased), or null when unparseable. */
function repoOfUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Numbers of this repo's issues that a live task references: non-archived runs of THIS project,
 * read through `taskReferences` (the same rule the chips use), Issue references only.
 *
 * A reference with a URL must name this repository; without a known repo such a reference cannot
 * be verified and is skipped. A bare number is the project's own (`taskReferences` tags it with
 * the project, and is called without a `repoBase` so nothing is synthesized). Transcript
 * candidates are never read — the set is exactly what the task records say, so it can undercount
 * (a task that never named its issue) but never claims a foreign issue.
 */
export function issueNumbersWithTask(
  runs: readonly RunRecord[],
  repo: string | undefined,
  projectId: string | undefined,
): Set<number> {
  const own = repo?.toLowerCase()
  const numbers = new Set<number>()
  for (const run of runs) {
    if (run.archived) continue
    for (const reference of taskReferences(run, undefined, projectId)) {
      if (reference.kind !== 'Issue') continue
      if (reference.url) {
        if (own === undefined || repoOfUrl(reference.url) !== own) continue
      }
      numbers.add(reference.number)
    }
  }
  return numbers
}

/** Main-list rows for a search-backed filter: the HITS, in GitHub's order — never an intersection
 *  with the open list, which would drop hits past its cap. A listed row wins over the bare hit
 *  because it carries the diff stat the search does not. */
export function rowsFromSearch(hits: readonly GithubItem[], open: readonly GithubItem[]): GithubItem[] {
  const listed = new Map(open.map((item) => [item.number, item]))
  return hits.map((hit) => listed.get(hit.number) ?? hit)
}

export interface CountInputs {
  gh: GithubData | undefined
  /** `null` while the runs have not answered, so task counts stay unknown rather than zero. */
  tasks: ReadonlySet<number> | null
  review: GithubSearchData | undefined
  failing: GithubSearchData | undefined
}

function fromSearch(data: GithubSearchData | undefined): FilterCount | null {
  if (!data?.available) return null
  return { value: data.items.length, bound: data.truncated ? 'atLeast' : 'exact' }
}

export function filterCounts({ gh, tasks, review, failing }: CountInputs): Record<GithubRowId, FilterCount | null> {
  const none: Record<GithubRowId, FilterCount | null> = {
    assigned: null, 'no-task': null, 'has-task': null, all: null, review: fromSearch(review),
    mine: null, failing: fromSearch(failing), 'all-prs': null,
  }
  if (!gh?.available) return none
  const issuesCapped = gh.issues.length >= GITHUB_LIST_LIMIT
  const prsCapped = gh.prs.length >= GITHUB_LIST_LIMIT
  const listed = (value: number, capped: boolean): FilterCount => ({ value, bound: capped ? 'atLeast' : 'exact' })
  const withTask = tasks ? gh.issues.filter((issue) => tasks.has(issue.number)).length : null
  return {
    ...none,
    all: listed(gh.issues.length, issuesCapped),
    'all-prs': listed(gh.prs.length, prsCapped),
    assigned: gh.viewerLogin
      ? listed(gh.issues.filter((issue) => issue.assignees?.some((login) => sameLogin(login, gh.viewerLogin))).length, issuesCapped)
      : null,
    mine: gh.viewerLogin ? listed(gh.prs.filter((item) => sameLogin(item.author, gh.viewerLogin)).length, prsCapped) : null,
    'has-task': withTask === null ? null : listed(withTask, issuesCapped),
    'no-task': withTask === null ? null : listed(gh.issues.length - withTask, issuesCapped),
  }
}
