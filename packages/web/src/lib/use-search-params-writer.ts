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
 * and every write is a `replace`, so Back leaves the page.
 */
export function useSearchParamsWriter(): [URLSearchParams, (update: SearchParamsUpdate) => void] {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const pending = React.useRef({ rendered: searchParams, next: searchParams })
  React.useLayoutEffect(() => {
    if (pending.current.rendered !== searchParams) pending.current = { rendered: searchParams, next: searchParams }
  }, [searchParams])
  const write = React.useCallback((update: SearchParamsUpdate) => {
    const next = update(new URLSearchParams(pending.current.next))
    pending.current = { ...pending.current, next }
    void navigate({ search: `?${next}` }, { replace: true })
  }, [navigate])
  return [searchParams, write]
}
