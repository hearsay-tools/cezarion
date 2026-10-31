import { useEffect, useState } from 'react'

/*
 * The viewer's `devicePixelRatio`, live (hearsay-tools/cezarion#2069). Ultra renders the preview at
 * it. A window moved to another display, or a browser zoom, changes it; a `(resolution: Ndppx)`
 * query for the current ratio stops matching at that moment, so each ratio watches its own query.
 */

function read(): number {
  const ratio = typeof window === 'undefined' ? undefined : window.devicePixelRatio
  return typeof ratio === 'number' && ratio > 0 ? ratio : 1
}

export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(read)
  useEffect(() => {
    const list = window.matchMedia?.(`(resolution: ${ratio}dppx)`)
    if (!list) return
    const onChange = () => setRatio(read())
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [ratio])
  return ratio
}
