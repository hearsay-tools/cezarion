import type { QueryClient } from '@tanstack/react-query'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { queryKeys } from './queries'

/**
 * Task detail refreshes driven by the workspace stream. The stream carries list rows, never the
 * full record a detail holds, so a detail stays current by asking `GET /runs/:id`, and its Finish
 * verdict comes only from a fetch that started after the latest event.
 */

/** Drop a cached detail's Finish verdict. Only a detail fetch started after the latest event
 *  may say whether Finish is allowed, so `undefined` (unknown) hides Finish and Accept. */
export function dropFinishVerdict(queryClient: QueryClient, key: readonly unknown[]): void {
  const cached = queryClient.getQueryData<ApiRun>(key)
  if (cached?.finishBlocked === undefined) return
  const { finishBlocked: _stale, ...run } = cached
  queryClient.setQueryData<ApiRun>(key, run)
}

/** The fastest an open task detail refetches under sustained events (D1). */
export const RUN_DETAIL_REFRESH_MS = 400

/**
 * Keep a task detail current from summary events (hearsay-tools/cezarion#2730, plan item 6). The
 * stream no longer carries the full record, so the detail asks `GET /runs/:id`:
 *
 * - every event drops the cached Finish verdict at once;
 * - an observed detail fetches at once when no fetch is in flight, then at most one trailing
 *   fetch per `RUN_DETAIL_REFRESH_MS`. A fetch in flight is kept, never cancelled, so a burst
 *   costs one request plus one trailing request, not one per event;
 * - a response whose fetch started before the latest event never restores the verdict: it lands
 *   without `finishBlocked`, and the trailing fetch brings the current one;
 * - an unobserved cached detail is only marked stale (`refetchType: 'none'`), so a remount
 *   refetches instead of showing Finish or Accept from an old verdict.
 *
 * Fetches are identified by their promise: a fetch in flight at an event started before it.
 */
export function createRunDetailFetcher(queryClient: QueryClient) {
  interface Entry {
    key: readonly unknown[]
    /** A fetch that starts after the latest event is owed. */
    owed: boolean
    lastStart: number
    timer?: ReturnType<typeof setTimeout> | undefined
    /** Fetches in flight at an event: their answers cannot carry a current verdict. */
    preEvent: WeakSet<Promise<unknown>>
  }
  const entries = new Map<string, Entry>()
  const find = (key: readonly unknown[]) => queryClient.getQueryCache().find({ queryKey: key, exact: true })
  const pump = (entry: Entry): void => {
    if (!entry.owed || entry.timer !== undefined) return
    const query = find(entry.key)
    if (!query) {
      entry.owed = false
      return
    }
    if (!query.isActive()) {
      entry.owed = false
      void queryClient.invalidateQueries({ queryKey: entry.key, exact: true, refetchType: 'none' })
      return
    }
    // The fetch in flight settles first; its settlement pumps again.
    if (query.state.fetchStatus !== 'idle') return
    const wait = entry.lastStart + RUN_DETAIL_REFRESH_MS - Date.now()
    if (wait > 0) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        pump(entry)
      }, wait)
      return
    }
    entry.owed = false
    entry.lastStart = Date.now()
    void queryClient.refetchQueries({ queryKey: entry.key, exact: true, type: 'active' }, { cancelRefetch: false })
  }
  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || entries.size === 0) return
    const entry = entries.get(JSON.stringify(event.query.queryKey))
    if (!entry) return
    if (event.action.type === 'success' && !event.action.manual) {
      const promise = event.query.promise
      if (promise && entry.preEvent.has(promise)) {
        entry.preEvent.delete(promise)
        dropFinishVerdict(queryClient, entry.key)
        // The answer predates the latest event, so a fetch started after it is still owed: at once
        // for an enabled reader, or as a stale mark for the next one (a success clears the mark).
        entry.owed = true
      }
    }
    if (event.query.state.fetchStatus === 'idle') pump(entry)
  })
  return {
    onEvent(id: string): void {
      const key = queryKeys.runs.detail(id)
      const query = find(key)
      if (!query) return
      const cacheKey = JSON.stringify(key)
      let entry = entries.get(cacheKey)
      if (!entry) {
        entry = { key, owed: false, lastStart: 0, preEvent: new WeakSet() }
        entries.set(cacheKey, entry)
      }
      if (query.state.fetchStatus !== 'idle' && query.promise) entry.preEvent.add(query.promise)
      dropFinishVerdict(queryClient, key)
      entry.owed = true
      pump(entry)
    },
    forget(id: string): void {
      const cacheKey = JSON.stringify(queryKeys.runs.detail(id))
      clearTimeout(entries.get(cacheKey)?.timer)
      entries.delete(cacheKey)
    },
    cancel(): void {
      unsubscribe()
      for (const entry of entries.values()) clearTimeout(entry.timer)
      entries.clear()
    },
  }
}

export type RunDetailFetcher = ReturnType<typeof createRunDetailFetcher>

/** A worker's event: keep the parent's Finish verdict unknown immediately, but fetch only after
 * the event burst settles. Per-mount timers retain the original scoped key and are cancelled on
 * cleanup. */
export function createRunDetailRefresher(queryClient: QueryClient) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    refresh(id: string): void {
      const key = queryKeys.runs.detail(id)
      if (!queryClient.getQueryState(key)) return
      const cacheKey = JSON.stringify(key)
      clearTimeout(pending.get(cacheKey))
      // Invalidation alone reuses an initial in-flight request. Cancel it now so a
      // pre-event response cannot restore permission during the debounce window.
      // Keep TanStack's default revert: a cancelled fetch restores the last successful
      // query state (or pending on first load), instead of surfacing a cancellation error.
      // setQueryData updates the revert snapshot, so the event patch above survives too.
      void queryClient.cancelQueries({ queryKey: key })
      pending.set(cacheKey, setTimeout(() => {
        pending.delete(cacheKey)
        void queryClient.invalidateQueries({ queryKey: key })
      }, 400))
    },
    cancel(): void {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    },
  }
}
