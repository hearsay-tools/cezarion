import { useEffect, useState } from 'react'

/** The pane docks beside the transcript from this width; below it the pane takes the main area. */
export const PREVIEW_DOCK_QUERY = '(min-width: 1180px)'
/** A phone: the pane is full screen and the viewport is always Fit. */
export const PREVIEW_PHONE_QUERY = '(max-width: 767px)'

/** `matches` for a media query, live. `fallback` is the answer where `matchMedia` does not exist. */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const read = (): boolean => window.matchMedia?.(query).matches ?? fallback
  const [matches, setMatches] = useState(read)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  return matches
}
