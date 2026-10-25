import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { useGithubPages } from '@/api/queries'
import type { GithubData } from '@open-mercato/cezar-api-client'

import type { GithubView } from './github'

/**
 * Scroll-driven paging for the GitHub list (hearsay-tools/cezarion#1183, port of
 * open-mercato/cezar#1374).
 *
 * Which element scrolls the list depends on the layout: from `md` up the list pane (`gh-list`,
 * `md:overflow-y-auto`) scrolls on its own; below it the shell's `main` does. The virtualizer and
 * the load-more observer must both follow the element that really scrolls, or the virtualizer
 * never sees a scroll and leaves only its first window of rows mounted.
 */

/** How far below the visible list the next page starts loading, so it usually lands before the
 *  user reaches the end. */
export const LOAD_AHEAD_PX = 600

/** The element that scrolls `list`: the list itself when it is a scroll container, else the
 *  shell's `main`, else the list (a host with neither). */
export function resolveListScrollOwner(list: HTMLElement): HTMLElement {
  const overflowY = getComputedStyle(list).overflowY
  if (overflowY === 'auto' || overflowY === 'scroll') return list
  return list.closest<HTMLElement>('[data-slot="main"]') ?? list
}

/** `resolveListScrollOwner` for `list`, re-resolved when the `md` breakpoint flips and whenever
 *  the list's size changes (a layout change can move the scroll owner). The list arrives as an
 *  element, not a ref: it mounts only once the first page is in, and a ref read in a mount-only
 *  effect would stay null for the life of the route. */
export function useListScrollOwner(list: HTMLElement | null): HTMLElement | null {
  const [owner, setOwner] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!list) {
      setOwner(null)
      return
    }
    const resolve = () => setOwner(resolveListScrollOwner(list))
    resolve()
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)') : null
    media?.addEventListener('change', resolve)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resolve)
    observer?.observe(list)
    return () => {
      media?.removeEventListener('change', resolve)
      observer?.disconnect()
    }
  }, [list])
  return owner
}

/**
 * The distance from `owner`'s content start down to `container`, which the virtualizer needs as
 * `startMargin` when the owner scrolls more than the list (the phone's `main`, with the repo line,
 * tabs and search above the rows). Measured the same way as the thread and the diff.
 */
export function useStartMargin(container: HTMLElement | null, owner: HTMLElement | null): number {
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      if (!container || !owner) return
      setStartMargin(Math.max(0, Math.round(
        container.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop,
      )))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [container, owner])
  return startMargin
}

/**
 * Calls `loadMore` whenever the returned sentinel ref comes within `LOAD_AHEAD_PX` of the scroll
 * owner's visible bottom. The observer is rebuilt every time `enabled` flips back on (after each
 * page lands) or the owner changes, and a fresh observer reports its initial state, so a sentinel
 * still in view after a short page keeps loading until it scrolls out or pages run out. When
 * `main` scrolls, the observer watches the viewport (`root: null`), which `main` fills.
 */
export function useLoadMoreSentinel(enabled: boolean, root: HTMLElement | null, loadMore: () => void): (node: HTMLElement | null) => void {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const loadMoreRef = useRef(loadMore)
  useEffect(() => {
    loadMoreRef.current = loadMore
  })
  useEffect(() => {
    if (!enabled || !sentinel || !root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current()
      },
      {
        root: root.getAttribute('data-slot') === 'main' ? null : root,
        rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px`,
      },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [enabled, sentinel, root])
  return setSentinel
}

/** The GitHub tab's infinite list query (`useGithubPages(...).pages`). */
export type GithubPagesQuery = ReturnType<typeof useGithubPages>['pages']

export type GithubListPaging = ReturnType<typeof useGithubListPaging>

/**
 * Scroll-driven paging for the route (#1183, port of open-mercato/cezar#1374). The rows virtualize
 * against the element that really scrolls them (the list pane from `md` up, the shell's `main`
 * below it), and the next page loads when the sentinel nears that element's bottom. No automatic
 * paging under a text, label, assignee or board narrow: a narrowed list would keep the sentinel
 * in view and crawl every page, so the next page waits for the user's Load more. The
 * list-backed presets keep paging, so their counts read `N+` until a side is done; the
 * search-backed ones never page. A failed page stops the observer too, or the still-visible
 * sentinel would retry it in a tight loop.
 */
export function useGithubListPaging(
  view: GithubView,
  list: GithubPagesQuery,
  gh: GithubData | undefined,
  backedQuery: string | null,
  narrowing: boolean,
) {
  const [listEl, setListEl] = useState<HTMLElement | null>(null)
  const [rowsEl, setRowsEl] = useState<HTMLDivElement | null>(null)
  const scrollOwner = useListScrollOwner(listEl)
  const scrollOwnerRef = useRef<HTMLElement | null>(null)
  scrollOwnerRef.current = scrollOwner
  const startMargin = useStartMargin(rowsEl, scrollOwner)
  // Gated on the loaded SIDE, not on the preset's matches: a preset with nothing on the loaded
  // pages must still page on to the match a later page holds.
  const loadedSide = view === 'issues' ? gh?.issues.length ?? 0 : gh?.prs.length ?? 0
  const pagingAvailable = list.hasNextPage && backedQuery === null && loadedSide > 0
  const pagingShown = pagingAvailable && !narrowing
  // Under a narrow the next page waits for the user's Load more: the filter only sees loaded
  // rows, and a match on a later page must stay reachable without crawling every page.
  const manualPaging = pagingAvailable && narrowing
  const loadMoreRef = useLoadMoreSentinel(
    pagingShown && !list.isFetchingNextPage && !list.isFetchNextPageError,
    scrollOwner,
    () => void list.fetchNextPage(),
  )
  return { listEl, setListEl, setRowsEl, scrollOwner, scrollOwnerRef, startMargin, pagingAvailable, manualPaging, loadMoreRef }
}
