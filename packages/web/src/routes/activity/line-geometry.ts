import { COLUMN_GAP } from './layout'
import { blocked, channelDetour, gridDetour, othersThan, roundedPath, spanOf, type Rect } from './line-route'

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
/** A stub to a task that is not on the view drops this far below (or above) its anchor. */
export const STUB_DROP = 44

const round = (n: number) => Math.round(n * 10) / 10
const pt = (p: Point) => `${round(p.x)} ${round(p.y)}`

export const center = (box: Box): Point => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })

/** Which side of a card has a column gap: toward `other` when it is in another column, else the
 *  right, unless the card is in the last column (`hostWidth`). */
export function facingSide(card: Box, other: Box | undefined, hostWidth: number): 1 | -1 {
  if (other && other.x > card.x + 40) return 1
  if (other && other.x < card.x - 40) return -1
  return card.x + card.w + COLUMN_GAP <= hostWidth + 1 ? 1 : -1
}

/** Two cards in one column: the line bows out through the gap on `side`. */
function bowPath(from: Box, to: Box, lane: number, side: 1 | -1, ay: number, by: number): LinePath {
  const x = side > 0 ? Math.max(from.x + from.w, to.x + to.w) : Math.min(from.x, to.x)
  const bow = (70 + lane) * side
  return { d: `M${pt({ x, y: ay })} C ${pt({ x: x + bow, y: ay })}, ${pt({ x: x + bow, y: by })}, ${pt({ x: x + 2 * side, y: by })}`, label: { x: x + bow * 0.75, y: (ay + by) / 2 } }
}

/**
 * A peer line from the sender card to the recipient card. Cards in one column (their left edges
 * within 40 px) bow out through the gap on `side`; otherwise the line leaves the facing edges. A
 * curve that would cross another of `cards` (a column between the two) runs through the gaps
 * instead. `lane` (`laneOffsets`) moves the line off the pair's other lines.
 */
export function peerPath(from: Box, to: Box, cards: readonly Box[] = [], lane = 0, side: 1 | -1 = 1): LinePath {
  const ay = from.y + PEER_ANCHOR_Y + lane
  const by = to.y + PEER_ANCHOR_Y + lane
  if (Math.abs(from.x - to.x) < 40) return bowPath(from, to, lane, side, ay, by)
  const right = to.x > from.x
  const ax = right ? from.x + from.w : from.x
  const bx = right ? to.x : to.x + to.w
  const k = Math.max(40, Math.abs(bx - ax) * 0.5) * (right ? 1 : -1)
  const end = bx - (right ? 2 : -2)
  if (blocked(spanOf({ x: ax, y: ay }, { x: bx, y: by }), othersThan(cards, from, to))) {
    const detour = channelDetour({ x: ax, y: ay }, { x: bx, y: by }, COLUMN_GAP, othersThan(cards, from, to), lane)
    return { d: roundedPath(detour.points), label: detour.label }
  }
  return { d: `M${pt({ x: ax, y: ay })} C ${pt({ x: ax + k, y: ay })}, ${pt({ x: bx - k, y: by })}, ${pt({ x: end, y: by })}`, label: { x: (ax + bx) / 2, y: (ay + by) / 2 } }
}

export interface StubEnd {
  /** The gap the stub runs in: `facingSide`. */
  side: 1 | -1
  /** The card at the other end, when it is on the view but off screen. */
  other?: Box
  /** The visible part of the graph, relative to the host: the stub ends inside it. */
  view?: Rect
  /** The label's height: the stub ends where its label still fits on screen. */
  labelHeight: number
  lane?: number
}

/** Where a stub's free end sits: at the viewport edge toward the off-screen card, or a short drop
 *  below the anchor for a task that is not on the view at all. Either way the end, and the label
 *  centred on it, stay inside the viewport. */
function stubEndY(y: number, { other, view, labelHeight }: StubEnd): number {
  const margin = labelHeight / 2 + 4
  const wanted = !other || !view ? y + STUB_DROP : other.y > y ? Math.max(y + STUB_DROP, view.y1 - margin) : Math.min(y - STUB_DROP, view.y0 + margin)
  return view ? clampInto(wanted, view.y0 + margin, view.y1 - margin) : wanted
}

/** `value` inside `[low, high]`; a range too small for it keeps `low`. */
export const clampInto = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/**
 * A peer line whose other end is not on screen: a stub from the card's edge into the column gap,
 * then along the gap to its free end, where the label names the other task. The stub runs from
 * the free end into the card when the card is the recipient, so its dashes and comets still move
 * from the sender to the recipient.
 */
export function stubPath(card: Box, cardIs: 'sender' | 'recipient', end: StubEnd): LinePath {
  const lane = end.lane ?? 0
  const y = card.y + PEER_ANCHOR_Y + lane
  const edge = end.side > 0 ? card.x + card.w : card.x
  const gx = edge + (end.side * COLUMN_GAP) / 2 + lane / 2
  const free = { x: gx, y: stubEndY(y, end) }
  const points = cardIs === 'sender' ? [{ x: edge, y }, { x: gx, y }, free] : [free, { x: gx, y }, { x: edge + 2 * end.side, y }]
  return { d: roundedPath(points), label: free }
}

/**
 * A family line between two rows of one card (worker and parent, either direction), bowed
 * through the card's left margin. `from` and `to` are the rows' status shapes.
 */
export function familyPath(from: Box, to: Box, card: Box, lane = 0): LinePath {
  const a = { x: from.x, y: from.y + from.h / 2 }
  const b = { x: to.x - 2, y: to.y + to.h / 2 }
  const gx = card.x - FAMILY_MARGIN + lane / 2
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
 * gaps around it (`gridDetour`). `lane` (`laneOffsets`) moves the arc off the pair's other arcs.
 */
export function arcPath(from: Box, to: Box, pills: readonly Box[] = [], lane = 0): LinePath {
  const ax = from.x + from.w / 2 + lane
  const bx = to.x + to.w / 2 + lane
  if (to.y >= from.y + from.h || to.y + to.h <= from.y) {
    const down = to.y > from.y
    const ay = down ? from.y + from.h + 1 : from.y - 1
    const by = down ? to.y - 3 : to.y + to.h + 3
    const k = (by - ay) / 2
    if (blocked(spanOf({ x: ax, y: ay }, { x: bx, y: by }), othersThan(pills, from, to))) {
      const detour = gridDetour(from, to, pills, lane)
      return { d: roundedPath(detour.points), label: detour.label }
    }
    return { d: `M${pt({ x: ax, y: ay })} C ${pt({ x: ax, y: ay + k })}, ${pt({ x: bx, y: by - k })}, ${pt({ x: bx, y: by })}`, label: { x: (ax + bx) / 2, y: (ay + by) / 2 } }
  }
  const ay = from.y - 1
  const by = to.y - 1
  const top = Math.min(ay, by)
  // The lanes of one pair nest around the lone arc's height; two lanes stay inside the room the
  // strip reserves above a row.
  const lift = Math.max(8, Math.min(ARC_MAX_LIFT, 18 + Math.abs(bx - ax) * 0.05) + lane)
  return {
    d: `M${pt({ x: ax, y: ay })} C ${pt({ x: ax, y: top - lift })}, ${pt({ x: bx, y: top - lift })}, ${pt({ x: bx, y: by - 3 })}`,
    label: { x: (ax + bx) / 2, y: top - lift * 0.75 },
  }
}

/** A box relative to the host's top-left corner. */
export function relativeBox(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, host: Pick<DOMRect, 'left' | 'top'>): Box {
  return { x: rect.left - host.left, y: rect.top - host.top, w: rect.width, h: rect.height }
}
