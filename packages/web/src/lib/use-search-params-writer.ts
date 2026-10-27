import * as React from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'

/** One change to the query string, from the params as they will be once earlier writes land. */
export type SearchParamsUpdate = (current: URLSearchParams) => URLSearchParams

/**
 * The query string, and a writer that composes with writes still on their way
 * (hearsay-tools/cezarion#1616).
 *
 * `useSearchParams`' own setter starts from the params of the render that created it, and the
 * router applies each navigation in a transition. A second write before the first renders (a
 * tab click, then the search debounce) then starts from the old params and silently undoes the
 * first. This writer starts from the last params it wrote until the router renders a newer URL,
 * skips a write that changes nothing, and makes every write a `replace`, so Back leaves the page.
 *
 * Each dispatched navigation carries `{ __writerSession, __writerSeq }` in its history state.
 * `__writerSession` is a random token generated at mount, so Back/Forward cannot restore a state
 * from a previous instance. `__writerSeq` is a monotone counter: when the landed seq equals
 * `latestSeq`, the last pending write has arrived and `next` resets; when the landed seq is
 * smaller, a newer write is still in flight and `next` is preserved. A navigation without our
 * session token is external (sidebar link, pasted URL, Back/Forward) and resets `next` to the
 * new URL (hearsay-tools/cezarion#1790).
 */
export function useSearchParamsWriter(): [URLSearchParams, (update: SearchParamsUpdate) => void] {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const session = React.useRef(Math.random())
  const pending = React.useRef({ rendered: searchParams, next: searchParams, seq: 0, latestSeq: 0 })
  React.useLayoutEffect(() => {
    if (pending.current.rendered === searchParams) return
    const state = location.state as { __writerSession?: number; __writerSeq?: number } | null
    const writerSeq = state?.__writerSession === session.current ? state.__writerSeq : undefined
    if (writerSeq !== undefined && writerSeq <= pending.current.latestSeq) {
      // One of our writes landed.
      pending.current.rendered = searchParams
      if (writerSeq === pending.current.latestSeq) {
        // The latest write landed; reset next to signal we've arrived.
        pending.current.next = searchParams
      }
      // An older write landed while a newer one is still in flight — preserve next.
    } else {
      // External navigation: reset so subsequent writes start from the new URL.
      pending.current = { rendered: searchParams, next: searchParams, seq: pending.current.seq, latestSeq: 0 }
    }
  }, [searchParams, location])
  const write = React.useCallback((update: SearchParamsUpdate) => {
    const next = update(new URLSearchParams(pending.current.next))
    // A write that changes nothing navigates nowhere. Even a same-URL navigation can land after
    // the reader opened another page, and take them back to this one.
    if (next.toString() === pending.current.next.toString()) return
    const seq = pending.current.seq + 1
    pending.current = { ...pending.current, next, seq, latestSeq: seq }
    void navigate({ search: `?${next}` }, { replace: true, state: { __writerSession: session.current, __writerSeq: seq } })
  }, [navigate])
  return [searchParams, write]
}
