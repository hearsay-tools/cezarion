import { COLUMN_GAP } from './layout'
import { blocked, channelDetour, gridDetour, othersThan, roundedPath, spanOf } from './line-route'

/**
 * The shapes of the lines between tasks (spec 2026-11-05-live-activity-view, "Lines between
 * tasks"). Pure: boxes in, an SVG path and a label point out. All boxes are relative to the graph
 * host, in CSS pixels.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface LinePath {
  d: string
  /** Where the label sits: the middle of the line, or the free end of a stub. */
  label: Point
}

/** How far below a card's top edge a peer line meets it: level with the title. */
export const PEER_ANCHOR_Y = 22
/** How far the family line bows into the card's left margin. */
export const FAMILY_MARGIN = 18
/** A line whose other end is not on the view ends this far from the card that remains. */
export const STUB_LENGTH = 72

const round = (n: number) => Math.round(n * 10) / 10
const pt = (p: Point) => `${round(p.x)} ${round(p.y)}`

export const center = (box: Box): Point => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })

/**
 * A peer line from the sender card to the recipient card. Cards in one column (their left edges
 * within 40 px) bow out to the right; otherwise the line leaves the facing edges. A curve that
 * would cross another of `cards` (a column between the two) runs through the gaps instead.
 */
export function peerPath(from: Box, to: Box, cards: readonly Box[] = []): LinePath {
  const ay = from.y + PEER_ANCHOR_Y
  const by = to.y + PEER_ANCHOR_Y
  if (Math.abs(from.x - to.x) < 40) {
    const x = Math.max(from.x + from.w, to.x + to.w)
    const bow = 70
    return { d: `M${pt({ x, y: ay })} C ${pt({ x: x + bow, y: ay })}, ${pt({ x: x + bow, y: by })}, ${pt({ x: x + 2, y: by })}`, label: { x: x + bow * 0.75, y: (ay + by) / 2 } }
  }
  const right = to.x > from.x
  const ax = right ? from.x + from.w : from.x
  const bx = right ? to.x : to.x + to.w
  const k = Math.max(40, Math.abs(bx - ax) * 0.5) * (right ? 1 : -1)
  const end = bx - (right ? 2 : -2)
  if (blocked(spanOf({ x: ax, y: ay }, { x: bx, y: by }), othersThan(cards, from, to))) {
    const detour = channelDetour({ x: ax, y: ay }, { x: bx, y: by }, COLUMN_GAP, othersThan(cards, from, to))
    return { d: roundedPath(detour.points), label: detour.label }
  }
  return { d: `M${pt({ x: ax, y: ay })} C ${pt({ x: ax + k, y: ay })}, ${pt({ x: bx - k, y: by })}, ${pt({ x: end, y: by })}`, label: { x: (ax + bx) / 2, y: (ay + by) / 2 } }
}

/**
 * A peer line whose other end is not on the view: a short stub from the card's right edge. The
 * stub points into the card when the card is the recipient.
 */
export function stubPath(card: Box, cardIs: 'sender' | 'recipient'): LinePath {
  const y = card.y + PEER_ANCHOR_Y
  const edge = card.x + card.w
  const free = edge + STUB_LENGTH
  const d = cardIs === 'sender' ? `M${pt({ x: edge, y })} L ${pt({ x: free, y })}` : `M${pt({ x: free, y })} L ${pt({ x: edge + 2, y })}`
  return { d, label: { x: free, y } }
}

/**
 * A family line between two rows of one card (worker and parent, either direction), bowed
 * through the card's left margin. `from` and `to` are the rows' status shapes.
 */
export function familyPath(from: Box, to: Box, card: Box): LinePath {
  const a = { x: from.x, y: from.y + from.h / 2 }
  const b = { x: to.x - 2, y: to.y + to.h / 2 }
  const gx = card.x - FAMILY_MARGIN
  return { d: `M${pt(a)} C ${pt({ x: gx, y: a.y })}, ${pt({ x: gx, y: b.y })}, ${pt(b)}`, label: { x: gx, y: (a.y + b.y) / 2 } }
}

/** How high a global-view arc may rise above the pills; the strip reserves this room. */
export const ARC_MAX_LIFT = 30

/**
 * A peer arc of the global view. Two pills in one row: from the top middle of the sender, up over
 * the pills, down into the top middle of the recipient; a farther pill gets a higher arc, up to
 * `ARC_MAX_LIFT`, and the label sits near the top. Pills in different rows: through the gap
 * between the rows, from the facing edges (the sender's bottom to the recipient's top, or the
 * other way up), so the arc never crosses either pill; the label sits in the gap. When that curve
 * would cross another of `pills` (rows between the two), the arc runs through the row and column
 * gaps around it (`gridDetour`).
 */
export function arcPath(from: Box, to: Box, pills: readonly Box[] = []): LinePath {
  const ax = from.x + from.w / 2
  const bx = to.x + to.w / 2
  if (to.y >= from.y + from.h || to.y + to.h <= from.y) {
    const down = to.y > from.y
    const ay = down ? from.y + from.h + 1 : from.y - 1
    const by = down ? to.y - 3 : to.y + to.h + 3
    const k = (by - ay) / 2
    if (blocked(spanOf({ x: ax, y: ay }, { x: bx, y: by }), othersThan(pills, from, to))) {
      const detour = gridDetour(from, to, pills)
      return { d: roundedPath(detour.points), label: detour.label }
    }
    return { d: `M${pt({ x: ax, y: ay })} C ${pt({ x: ax, y: ay + k })}, ${pt({ x: bx, y: by - k })}, ${pt({ x: bx, y: by })}`, label: { x: (ax + bx) / 2, y: (ay + by) / 2 } }
  }
  const ay = from.y - 1
  const by = to.y - 1
  const top = Math.min(ay, by)
  const lift = Math.min(ARC_MAX_LIFT, 18 + Math.abs(bx - ax) * 0.05)
  return {
    d: `M${pt({ x: ax, y: ay })} C ${pt({ x: ax, y: top - lift })}, ${pt({ x: bx, y: top - lift })}, ${pt({ x: bx, y: by - 3 })}`,
    label: { x: (ax + bx) / 2, y: top - lift * 0.75 },
  }
}

/** A box relative to the host's top-left corner. */
export function relativeBox(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, host: Pick<DOMRect, 'left' | 'top'>): Box {
  return { x: rect.left - host.left, y: rect.top - host.top, w: rect.width, h: rect.height }
}
