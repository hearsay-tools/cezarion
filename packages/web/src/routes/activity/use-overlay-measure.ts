import * as React from 'react'

/**
 * Measure line shapes from a laid-out host: the overlay's parent element. It measures once after
 * layout, then again when the host or one of its `observed` elements changes size
 * (`ResizeObserver`), never on a frame loop (spec 2026-11-05-live-activity-view, "Performance").
 *
 * The host is read through the overlay's own ref: React attaches a parent's ref only after its
 * children's layout effects run, so a ref passed down from the host is still null at the first
 * measure. `measure` and `same` must be stable between renders (`useCallback`); `layoutKey`
 * changes whenever the measured elements may have moved.
 */
export function useOverlayMeasure<T>(
  overlayRef: React.RefObject<Element | null>,
  measure: (host: HTMLElement) => T[],
  same: (a: readonly T[], b: readonly T[]) => boolean,
  observed: string,
  layoutKey: string,
): T[] {
  const [shapes, setShapes] = React.useState<T[]>([])
  React.useLayoutEffect(() => {
    const host = overlayRef.current?.parentElement
    if (!host) return
    const run = () => {
      const next = measure(host)
      setShapes((previous) => (same(previous, next) ? previous : next))
    }
    run()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(run)
    observer.observe(host)
    for (const el of host.querySelectorAll(observed)) observer.observe(el)
    return () => observer.disconnect()
  }, [overlayRef, measure, same, observed, layoutKey])
  return shapes
}
