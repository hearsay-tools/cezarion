import * as React from 'react'

import { scrollParents } from './line-viewport'
import { LAYOUT_SETTLED } from './use-flip'

/**
 * Measure line shapes from a laid-out host: the overlay's parent element. It measures once after
 * layout, then again when the host or one of its `observed` elements changes size
 * (`ResizeObserver`), never on a frame loop (spec 2026-11-05-live-activity-view, "Performance").
 * With `scroll`, it also measures again when the host's scrolling parents or the window scroll or
 * resize, at most once a frame, for lines that follow what is on screen ("Many lines"). It
 * measures again when the host's FLIP animations settle (`LAYOUT_SETTLED`): a transform causes no
 * resize, so a measure taken mid-flight would otherwise stay.
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
  scroll = false,
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
    const releaseScroll = scroll ? followScroll(host, run) : undefined
    host.addEventListener(LAYOUT_SETTLED, run)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(run)
    observer?.observe(host)
    for (const el of host.querySelectorAll(observed)) observer?.observe(el)
    return () => {
      observer?.disconnect()
      host.removeEventListener(LAYOUT_SETTLED, run)
      releaseScroll?.()
    }
  }, [overlayRef, measure, same, observed, layoutKey, scroll])
  return shapes
}

/** Run `run` after the host's scrolling parents or the window scroll or resize: one run for each
 *  frame that saw such an event, and none while nothing moves. */
function followScroll(host: Element, run: () => void): () => void {
  let pending: number | undefined
  const schedule = () => {
    if (pending !== undefined) return
    pending = requestAnimationFrame(() => {
      pending = undefined
      run()
    })
  }
  const targets: (Element | Window)[] = [...scrollParents(host), window]
  for (const target of targets) target.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  return () => {
    for (const target of targets) target.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    if (pending !== undefined) cancelAnimationFrame(pending)
  }
}
