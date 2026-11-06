import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { RunEvent, RunHistoryContext, RunHistoryPage } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { getRunHistory, getRunHistoryContext } from './client'
import { useRunEvents } from './run-events'

const MAX_HISTORY_PAGES = 5
const COMPACT_LIVE_AT_EVENTS = 200
const MAX_LIVE_EVENTS = 5_000

function orderedUnique(...groups: readonly RunEvent[][]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>()
  for (const group of groups) {
    for (const event of group) bySeq.set(event.seq, event)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

type HistoryData = InfiniteData<RunHistoryPage, string | undefined>

/**
 * Put a freshly read cursorless page in place of the cached newest page. Compaction, the refresh
 * on entry and the fold on exit all write through here. A page older than the cached newest one
 * is a response that lost a race with a newer write, and is dropped.
 */
function mergeNewestPage(
  queryClient: QueryClient,
  key: readonly unknown[],
  latestPage: RunHistoryPage,
): void {
  queryClient.setQueryData<HistoryData>(key, (current) => {
    if (!current) return { pages: [latestPage], pageParams: [undefined] }
    const pages = [...current.pages]
    const pageParams = [...current.pageParams]
    let latestIndex = -1
    for (let index = 0; index < pages.length; index += 1) {
      if (latestIndex === -1 || pages[index]!.asOfSeq > pages[latestIndex]!.asOfSeq) latestIndex = index
    }
    if (latestIndex >= 0 && pages[latestIndex]!.asOfSeq > latestPage.asOfSeq) return current
    if (latestIndex >= 0 && pages[latestIndex]!.newerCursor === undefined) {
      pages[latestIndex] = latestPage
      pageParams[latestIndex] = undefined
    } else {
      pages.push(latestPage)
      pageParams.push(undefined)
    }
    while (pages.length > MAX_HISTORY_PAGES) {
      pages.shift()
      pageParams.shift()
    }
    return { pages, pageParams }
  })
}

/** The context reaches the newest page when no event between them is missing. The two are read
 *  together, so this holds once the first context lands, and again after each refresh. */
function contextReachesPage(context: RunHistoryContext | undefined, newestPage: RunHistoryPage | undefined): boolean {
  if (context === undefined) return false
  const firstSeq = newestPage?.events[0]?.seq
  return firstSeq === undefined || context.asOfSeq >= firstSeq - 1
}

export interface RunHistoryState {
  visibleEvents: RunEvent[]
  currentEvents: RunEvent[]
  /**
   * `currentEvents` holds the run's whole current state: the context has loaded and reaches the
   * newest page, or the full replay stands in. Before that, it holds the newest page alone, which
   * can miss an agent the page starts after (hearsay-tools/cezarion#2588).
   */
  currentComplete: boolean
  isPending: boolean
  contextPending: boolean
  fallback: boolean
  hasOlder: boolean
  isFetchingOlder: boolean
  olderError: string | undefined
  loadOlder: () => Promise<void>
  jumpToLatest: () => Promise<void>
  retainedPages: number
}

/**
 * Bounded transcript hydration: newest page and compact current-state context load in parallel,
 * then one cursor-resumed SSE carries live frames. Any optimized-path failure switches once to
 * the protected full-replay hook so a missing optimization never makes a session unreadable.
 */
export function useRunHistory(runId: string | undefined): RunHistoryState {
  const scope = queryScope()
  const queryClient = useQueryClient()
  const historyKey = ['run-history', scope, runId] as const
  const contextKey = ['run-history-context', scope, runId] as const

  const history = useInfiniteQuery({
    queryKey: historyKey,
    enabled: runId !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => getRunHistory(runId!, pageParam, { signal }),
    getPreviousPageParam: (firstPage) => firstPage.olderCursor,
    getNextPageParam: (lastPage) => lastPage.newerCursor,
    maxPages: MAX_HISTORY_PAGES,
    // Freshness is the refresh on entry below, which replaces the newest page only. A stale
    // infinite query would instead refetch every retained page, oldest first, on mount.
    staleTime: Infinity,
    retry: 1,
  })
  const context = useQuery({
    queryKey: contextKey,
    enabled: runId !== undefined,
    queryFn: ({ signal }) => getRunHistoryContext(runId!, { signal }),
    retry: 1,
  })

  // The newest page and the context are read together, every time the newest page is replaced:
  // a new page drops the live frames before it, and a context older than those frames would leave
  // them out of the current state until a reload (hearsay-tools/cezarion#2588).
  const refreshNewest = useCallback(async (signal?: AbortSignal) => {
    const options = signal ? { signal } : undefined
    const [latest, current] = await Promise.all([
      getRunHistory(runId!, undefined, options), getRunHistoryContext(runId!, options),
    ])
    signal?.throwIfAborted()
    mergeNewestPage(queryClient, ['run-history', scope, runId], latest)
    queryClient.setQueryData(['run-history-context', scope, runId], current)
    return latest
  }, [queryClient, runId, scope])

  const recoverLive = useCallback(async (_reason: string, signal: AbortSignal) => {
    if (runId === undefined) return
    const latest = await refreshNewest(signal)
    return { cursor: latest.liveCursor, afterSeq: latest.asOfSeq }
  }, [refreshNewest, runId])

  const fallback = history.isError || context.isError
  const fallbackEvents = useRunEvents(fallback ? runId : undefined, { onReset: recoverLive })
  const pages = history.data?.pages ?? []
  const newestPage = pages.reduce<RunHistoryPage | undefined>(
    (latest, page) =>
      page.newerCursor === undefined
        ? page
        : latest ?? page,
    undefined,
  )
  const compactingLive = useRef(false)
  const compactLive = useCallback(() => {
    if (runId === undefined || compactingLive.current) return
    compactingLive.current = true
    void refreshNewest()
      // Compaction is an optimization, not a load: this call is fire-and-forget (`void`), so a
      // rejection here has no query to reject and would surface as an unhandled rejection. The
      // live buffer still holds every event, and the next `onCompact` retries — so swallowing is
      // the graceful outcome. Reachable via a transport error, and now also via a malformed page
      // body, which the client validates rather than casts (#827).
      .catch(() => {})
      .finally(() => {
        compactingLive.current = false
      })
  }, [refreshNewest, runId])

  // Re-entry (#881): a cached newest page is as old as the last visit, and the stream would
  // replay everything since from its `asOfSeq`, one frame at a time. Read the newest page again
  // first, keep the cached one on screen meanwhile, and open the stream from the fresh page.
  // Decided while rendering, so the stream never opens at the stale cursor before the refresh.
  const hasCachedHistory = (id: string | undefined) =>
    id !== undefined && queryClient.getQueryData(['run-history', scope, id]) !== undefined
  const [refresh, setRefresh] = useState(() => ({ runId, pending: hasCachedHistory(runId) }))
  let refreshPending = refresh.pending
  if (refresh.runId !== runId) {
    refreshPending = hasCachedHistory(runId)
    setRefresh({ runId, pending: refreshPending })
  }
  useEffect(() => {
    if (!refreshPending || runId === undefined) return
    let cancelled = false
    const controller = new AbortController()
    void refreshNewest(controller.signal)
      // A failed refresh leaves the cached page, and the stream replays from its cursor as before.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRefresh({ runId, pending: false })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [refreshNewest, refreshPending, runId])

  const liveEvents = useRunEvents(!fallback && newestPage && !refreshPending ? runId : undefined, {
    cursor: newestPage?.liveCursor,
    afterSeq: newestPage?.asOfSeq,
    maxEvents: MAX_LIVE_EVENTS,
    compactAt: COMPACT_LIVE_AT_EVENTS,
    onCompact: compactLive,
    onReset: recoverLive,
  })

  // Exit (#881): live frames die with this component. Fold them into the cached newest page so
  // the next entry shows them at once, while its own refresh is in flight.
  const liveCount = useRef(0)
  liveCount.current = liveEvents.length
  useEffect(() => () => {
    if (liveCount.current > 0) compactLive()
  }, [compactLive])

  const pagedEvents = useMemo(
    () => orderedUnique(...pages.map((page) => page.events as RunEvent[])),
    [pages],
  )
  const visibleEvents = useMemo(
    () => fallback ? fallbackEvents : orderedUnique(pagedEvents, liveEvents),
    [fallback, fallbackEvents, pagedEvents, liveEvents],
  )
  const currentComplete = fallback || contextReachesPage(context.data, newestPage)
  const currentEvents = useMemo(() => {
    if (fallback) return fallbackEvents
    const contextEvents = (context.data?.contextEvents ?? []) as RunEvent[]
    const contextHighWater = context.data?.asOfSeq ?? 0
    return orderedUnique(contextEvents, visibleEvents.filter(({ seq }) => seq > contextHighWater))
  }, [context.data, fallback, fallbackEvents, visibleEvents])

  const loadOlder = useCallback(async () => {
    await history.fetchPreviousPage()
  }, [history.fetchPreviousPage])

  const jumpToLatest = useCallback(async () => {
    // Full replay already includes the tail and remains subscribed to live SSE.
    // Resetting an unavailable optimization would discard it and unmount the
    // thread, losing the caller's scroll intent while the same failure retries.
    if (fallback) return
    await Promise.all([
      queryClient.resetQueries({ queryKey: historyKey, exact: true }),
      queryClient.invalidateQueries({ queryKey: contextKey, exact: true }),
    ])
  }, [contextKey, fallback, historyKey, queryClient])

  return {
    visibleEvents,
    currentEvents,
    currentComplete,
    isPending: !fallback && history.isPending,
    contextPending: !fallback && context.isPending,
    fallback,
    hasOlder: !fallback && Boolean(history.hasPreviousPage),
    isFetchingOlder: history.isFetchingPreviousPage,
    olderError: history.isFetchPreviousPageError
      ? history.error instanceof Error ? history.error.message : 'Could not load earlier items'
      : undefined,
    loadOlder,
    jumpToLatest,
    retainedPages: pages.length,
  }
}
