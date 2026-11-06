import type { Box } from './line-geometry'
import type { Rect } from './line-route'

/**
 * What part of the graph is on screen (spec 2026-11-05-live-activity-view, "Many lines"): a
 * request between two cards that are both on screen is a full line; a request whose other end is
 * off screen is a stub that ends at the viewport edge; no line is drawn when neither end is on
 * screen.
 */

/** Which ends of a line are on screen. */
export type OnScreen = 'both' | 'sender' | 'recipient' | 'none'

/** True when any part of the box is inside the visible rectangle, or touches its edge. */
export const isOnScreen = (box: Box, view: Rect) => box.x <= view.x1 && view.x0 <= box.x + box.w && box.y <= view.y1 && view.y0 <= box.y + box.h

/** The ends of a line on screen. An end that is not on the view at all (`undefined`) is off screen. */
export function endsOnScreen(sender: Box | undefined, recipient: Box | undefined, view: Rect): OnScreen {
  const from = sender !== undefined && isOnScreen(sender, view)
  const to = recipient !== undefined && isOnScreen(recipient, view)
  if (from && to) return 'both'
  if (from) return 'sender'
  if (to) return 'recipient'
  return 'none'
}

const scrolls = (el: Element) => /(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowY)

/** The elements between the host and the document that clip or scroll it. */
export function scrollParents(host: Element): Element[] {
  const out: Element[] = []
  for (let el = host.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) if (scrolls(el)) out.push(el)
  return out
}

function intersect(a: Rect, b: Rect): Rect {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }
}

/**
 * The visible part of the window and of every scrolling parent, relative to the host's top-left
 * corner. A parent that reports no size (not laid out) does not clip.
 */
export function visibleRect(host: Element): Rect {
  const origin = host.getBoundingClientRect()
  let view: Rect = { x0: 0, y0: 0, x1: window.innerWidth, y1: window.innerHeight }
  for (const parent of scrollParents(host)) {
    const rect = parent.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) view = intersect(view, { x0: rect.left, y0: rect.top, x1: rect.right, y1: rect.bottom })
  }
  return { x0: view.x0 - origin.left, y0: view.y0 - origin.top, x1: view.x1 - origin.left, y1: view.y1 - origin.top }
}
