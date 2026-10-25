import { useMemo } from 'react'

import { useGithubChecks, useGithubCommentCounts } from '@/api/queries'
import type { GithubData, GithubItem } from '@open-mercato/cezar-api-client'

import type { GithubView } from './github'
import type { GithubPagesQuery } from './github-paging'

/** How many on-screen PR rows one checks request covers (matches the server's `GH_CHECKS_MAX`).
 *  The visible window is hydrated first; without virtualization (Phase 2) rows past this stay
 *  glyph-less, exactly as a PR with no CI would. */
const CHECKS_WINDOW = 100

export type GithubBadges = ReturnType<typeof useGithubBadges>

/** Pin the selected detail and visible search hits before filling from the open list. The
 *  shared hook retains its project scope, cache and view lifetime; every request stays bounded. */
function checksWindow(
  gh: GithubData | undefined,
  view: GithubView,
  selectedNumber: number | null,
  searchHits: readonly GithubItem[],
  openItems: readonly GithubItem[],
): number[] {
  if (!gh?.available || view !== 'prs') return []
  const nums = new Set<number>()
  if (selectedNumber !== null && Number.isInteger(selectedNumber)) nums.add(selectedNumber)
  for (const pr of [...searchHits, ...openItems, ...gh.prs]) {
    if (nums.size >= CHECKS_WINDOW) break
    nums.add(pr.number)
  }
  return [...nums]
}

/** The badges each row and the detail hydrate after paint: the PR checks glyph (#664) and the
 *  comment count (#1183), for the loaded rows only. */
export function useGithubBadges(
  view: GithubView,
  list: GithubPagesQuery,
  gh: GithubData | undefined,
  selectedNumber: number | null,
  searchHits: readonly GithubItem[],
  openItems: readonly GithubItem[],
) {
  const checkPrNumbers = checksWindow(gh, view, selectedNumber, searchHits, openItems)
  const checksQuery = useGithubChecks(checkPrNumbers, view === 'prs')
  const checksMap = checksQuery.data?.available ? checksQuery.data.checks : undefined
  // Deferred comment counts (#1183): one request per loaded page of the active kind. A row the
  // list deferred shows no badge until its count lands; a search hit carries its own.
  const countsKind = view === 'issues' ? 'issue' : 'pr'
  const countGroups = useMemo(() => {
    return (list.data?.pages ?? []).map((page) => {
      return (view === 'issues' ? page.issues : page.prs).map((item) => item.number)
    })
  }, [list.data, view])
  const commentCounts = useGithubCommentCounts(countsKind, countGroups, gh?.available === true && gh.commentsDeferred === true)
  const deferredNumbers = useMemo(() => new Set(gh?.commentsDeferred
    ? (view === 'issues' ? gh.issues : gh.prs).map((item) => item.number) : []), [gh, view])
  const commentsOf = (item: GithubItem): number | undefined =>
    commentCounts[item.number] ?? (deferredNumbers.has(item.number) ? undefined : item.comments)
  return { checkPrNumbers, checksMap, commentsOf }
}
