import { useEffect, useState } from 'react'

/**
 * `(hover: none)`, live — the JS twin of the stylesheet's `no-hover` variant (`styles/index.css`),
 * for the rare element that must CHANGE, not just resize, on a device that cannot hover. The
 * sidebar's references are the case (#617 01b): on touch they render as plain text so the whole
 * row is the tap target. jsdom (no matchMedia) counts as a pointer device, like `useIsDesktop`.
 */
const QUERY = '(hover: none)'

export function useNoHover(): boolean {
  const [noHover, setNoHover] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(QUERY)
    setNoHover(query.matches)
    const onChange = (event: MediaQueryListEvent) => setNoHover(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return noHover
}
