import { useLayoutEffect, useRef } from 'react'

/** Native focus and scrollIntoView must use the space between the sticky controls.
 * Measure their rendered sizes: activity expansion and drafts both change the footer. */
export function useSessionViewport() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = ref.current
    const main = root?.closest<HTMLElement>('[data-slot="main"]')
    const header = root?.querySelector<HTMLElement>('[data-slot="run-header"]')
    const footer = root?.querySelector<HTMLElement>('[data-slot="thread-dock"]')
    if (!main || !header || !footer) return

    const update = () => {
      main.style.setProperty('--thread-viewport-height', `${main.clientHeight}px`)
      main.style.setProperty('--thread-header-height', `${header.getBoundingClientRect().height}px`)
      main.style.setProperty('--thread-footer-height', `${footer.getBoundingClientRect().height}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    observer.observe(footer)
    observer.observe(main)
    return () => {
      observer.disconnect()
      main.style.removeProperty('--thread-header-height')
      main.style.removeProperty('--thread-footer-height')
      main.style.removeProperty('--thread-viewport-height')
    }
  }, [])
  return ref
}
