import type { GithubData, GithubItem } from '@open-mercato/cezar-api-client'

/**
 * The paged GitHub list (hearsay-tools/cezarion#1183), as pure functions over the pages an
 * infinite query holds. Each side pages on its own cursor; a side that answered `null` is done
 * and is asked for its total only, so it never restarts at page 1.
 */
/** Rows per side per page. The owner's decision (2026-10-16): 50 rows, comment counts after paint. */
export const GITHUB_PAGE_SIZE = 50

export type GithubPageParam = { issuesCursor?: string; prsCursor?: string; issuesDone?: true; prsDone?: true }

/** The request after `last`, or `undefined` when both sides are done or the server does not
 *  page at all (an older server sends neither cursor). */
export function nextGithubPageParam(last: GithubData): GithubPageParam | undefined {
  if (!last.available) return undefined
  const issues = last.issuesNextCursor
  const prs = last.prsNextCursor
  if (issues === undefined && prs === undefined) return undefined
  if (!issues && !prs) return undefined
  return {
    ...(issues ? { issuesCursor: issues } : { issuesDone: true as const }),
    ...(prs ? { prsCursor: prs } : { prsDone: true as const }),
  }
}

/** True when `side` has no further page: its cursor is `null` or absent. Unknown data is not
 *  exhausted. */
export function githubSideExhausted(data: GithubData | undefined, side: 'issues' | 'prs'): boolean {
  if (!data) return false
  const cursor = side === 'issues' ? data.issuesNextCursor : data.prsNextCursor
  return cursor === null || cursor === undefined
}

function uniqueByNumber(rows: GithubItem[], seen: Set<number>, into: GithubItem[]): void {
  for (const row of rows) {
    if (seen.has(row.number)) continue
    seen.add(row.number)
    into.push(row)
  }
}

/**
 * Every loaded page as one `GithubData`, the shape the tab rendered before paging. Page 1 owns
 * the metadata; rows concatenate with the first copy of a number winning (a row that moved
 * between two fetches appears once); the last page owns the cursors. Board metadata is ready
 * only when every page is, so a project filter stays pending while any page still refreshes.
 */
export function flattenGithubPages(pages: readonly GithubData[]): GithubData | undefined {
  const first = pages[0]
  if (!first) return undefined
  const last = pages[pages.length - 1]!
  const issues: GithubItem[] = []
  const prs: GithubItem[] = []
  const seenIssues = new Set<number>()
  const seenPrs = new Set<number>()
  const labelColors: Record<string, string> = {}
  for (const page of pages) {
    uniqueByNumber(page.issues, seenIssues, issues)
    uniqueByNumber(page.prs, seenPrs, prs)
    for (const [name, color] of Object.entries(page.labelColors ?? {})) labelColors[name] ??= color
  }
  const projects = pages.find((page) => page.projects)?.projects
  const states = pages.map((page) => page.projectsState)
  const unavailable = pages.find((page) => page.projectsState === 'unavailable')
  const projectsState = states.includes('refreshing') ? 'refreshing'
    : unavailable ? 'unavailable'
      : states.some((state) => state === 'ready') ? 'ready' : undefined
  const { projectsGeneration: _generation, projectsReason: _reason, ...head } = first
  return {
    ...head,
    issues,
    prs,
    ...(Object.keys(labelColors).length > 0 ? { labelColors } : {}),
    ...(projects ? { projects } : {}),
    ...(projectsState ? { projectsState } : {}),
    ...(projectsState === 'unavailable' && unavailable?.projectsReason ? { projectsReason: unavailable.projectsReason } : {}),
    ...('issuesNextCursor' in last ? { issuesNextCursor: last.issuesNextCursor } : {}),
    ...('prsNextCursor' in last ? { prsNextCursor: last.prsNextCursor } : {}),
  }
}

const numbersOf = (rows: readonly GithubItem[]) => rows.map((row) => row.number).join(',')

/**
 * Fold a fresh page 1 (`head`, from the live read) into the loaded pages. With later pages
 * loaded, a head whose rows or totals moved would shift every cursor after it, so the caller
 * refetches all loaded pages in order instead (`'refetch'`). Otherwise the head replaces page
 * 1 in place, keeping page 1's verified board membership while the head's own lookup refreshes.
 */
export function reconcileGithubHead(pages: readonly GithubData[], head: GithubData): 'refetch' | GithubData[] {
  const current = pages[0]
  if (pages.length > 1 && current && (
    numbersOf(current.issues) !== numbersOf(head.issues)
    || numbersOf(current.prs) !== numbersOf(head.prs)
    || current.issuesTotal !== head.issuesTotal
    || current.prsTotal !== head.prsTotal
  )) return 'refetch'
  let next = head
  if (current && head.available && head.projectsState === 'refreshing' && current.repo === head.repo) {
    const known = new Map(current.issues.map((row) => [row.number, row.projectIds]))
    next = {
      ...head,
      issues: head.issues.map((row) => {
        const ids = known.get(row.number)
        return row.projectIds === undefined && ids !== undefined ? { ...row, projectIds: ids } : row
      }),
    }
  }
  return [next, ...pages.slice(1)]
}
