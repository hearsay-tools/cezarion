import { useEffect, useState } from 'react'

/** Tailwind's md breakpoint. Keep tree selection aligned with md: styles. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 48rem)'

/**
 * md-and-up, live: the "phones force unified+wrap" rule (spec §"Session git view — Changes &
 * Files tabs (#390)") must follow a rotation/resize, not the first render. jsdom (no
 * matchMedia) counts as desktop, same convention as plan-dock.ts.
 *
 * Shared by the task Changes tab and the repo view (R5 1.7) — one seam, one rule.
 */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window.matchMedia !== 'function' || window.matchMedia(DESKTOP_MEDIA_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const onChange = () => setDesktop(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return desktop
}
