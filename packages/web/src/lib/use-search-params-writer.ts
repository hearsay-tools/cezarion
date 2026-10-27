import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router'

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
 * `inflight` tracks the search strings of every navigation we dispatched but haven't seen land
 * yet, oldest first. When a URL commits, we check whether it matches one of our in-flight
 * dispatches: if so we consume that entry (and all older ones) and only reset `next` once the
 * very last dispatch has landed; if not, it is an external navigation and we reset completely
 * (hearsay-tools/cezarion#1790).
 */
export function useSearchParamsWriter(): [URLSearchParams, (update: SearchParamsUpdate) => void] {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const pending = React.useRef({ rendered: searchParams, next: searchParams, inflight: [] as string[] })
  React.useLayoutEffect(() => {
    if (pending.current.rendered === searchParams) return
    const landed = searchParams.toString()
    const idx = pending.current.inflight.indexOf(landed)
    if (idx !== -1) {
      // One of our writes landed. Consume it and all older in-flight entries.
      const remaining = pending.current.inflight.slice(idx + 1)
      pending.current = {
        rendered: searchParams,
        // Keep `next` while more recent writes are still in flight; reset once we've arrived.
        next: remaining.length > 0 ? pending.current.next : searchParams,
        inflight: remaining,
      }
    } else {
      // External navigation: reset completely so subsequent writes start from the new URL.
      pending.current = { rendered: searchParams, next: searchParams, inflight: [] }
    }
  }, [searchParams])
  const write = React.useCallback((update: SearchParamsUpdate) => {
    const next = update(new URLSearchParams(pending.current.next))
    // A write that changes nothing navigates nowhere. Even a same-URL navigation can land after
    // the reader opened another page, and take them back to this one.
    if (next.toString() === pending.current.next.toString()) return
    pending.current = { ...pending.current, next, inflight: [...pending.current.inflight, next.toString()] }
    void navigate({ search: `?${next}` }, { replace: true })
  }, [navigate])
  return [searchParams, write]
}
