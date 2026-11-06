import type { Box, Point } from './line-geometry'

/**
 * Routing for lines that would cross a card or a pill (spec 2026-11-05-live-activity-view, "Lines
 * between tasks" and "Global view"). A line runs only through the gaps between boxes: the row and
 * column gaps of the global view's pill grid, and the column gaps and the free space between
 * cards of the project graph. Pure: boxes in, points out; all boxes are relative to the host.
 */

/** A rectangle by its edges. */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The rectangle two points span. */
export const spanOf = (a: Point, b: Point): Rect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) })

/** True when any box reaches into the rectangle, `inset` pixels in from the box's edges. */
export function blocked(rect: Rect, boxes: readonly Box[], inset = 1): boolean {
  return boxes.some((b) => b.x + inset < rect.x1 && rect.x0 < b.x + b.w - inset && b.y + inset < rect.y1 && rect.y0 < b.y + b.h - inset)
}

/** Every box except the two ends of the line. */
export const othersThan = (boxes: readonly Box[], ...ends: Box[]) => boxes.filter((box) => !ends.some((end) => sameBox(box, end)))
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

const round = (n: number) => Math.round(n * 10) / 10
const pt = (p: Point) => `${round(p.x)} ${round(p.y)}`

/** Drop repeated points and the middle point of three in one straight line. */
function corners(points: readonly Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    const before = out[out.length - 2]
    if (before && last && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) out.pop()
    out.push(p)
  }
  return out
}

/** A polyline as an SVG path with rounded corners. */
export function roundedPath(points: readonly Point[], radius = 8): string {
  const pts = corners(points)
  const first = pts[0]
  if (!first) return ''
  let d = `M${pt(first)}`
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as Point
    const prev = pts[i - 1] as Point
    const next = pts[i + 1]
    if (!next) {
      d += ` L ${pt(p)}`
      continue
    }
    const r = Math.min(radius, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2)
    const toward = (from: Point, to: Point, by: number): Point => {
      const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
      return { x: from.x + ((to.x - from.x) / len) * by, y: from.y + ((to.y - from.y) / len) * by }
    }
    d += ` L ${pt(toward(p, prev, r))} Q ${pt(p)}, ${pt(toward(p, next, r))}`
  }
  return d
}

/** The rows and columns of a grid of boxes, each by its outer edges. */
export interface Grid {
  rows: { top: number; bottom: number }[]
  cols: { left: number; right: number }[]
}

function bands(boxes: readonly Box[], start: (b: Box) => number, end: (b: Box) => number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (const box of [...boxes].sort((a, b) => start(a) - start(b))) {
    const last = out[out.length - 1]
    if (last && Math.abs(start(box) - last.from) <= 2) last.to = Math.max(last.to, end(box))
    else out.push({ from: start(box), to: end(box) })
  }
  return out
}

/** Group boxes into rows by their top edge and into columns by their left edge. */
export function gridOf(boxes: readonly Box[]): Grid {
  return {
    rows: bands(boxes, (b) => b.y, (b) => b.y + b.h).map(({ from, to }) => ({ top: from, bottom: to })),
    cols: bands(boxes, (b) => b.x, (b) => b.x + b.w).map(({ from, to }) => ({ left: from, right: to })),
  }
}

const indexOf = <T>(list: readonly T[], at: (item: T) => number, value: number) => Math.max(0, list.findIndex((item) => Math.abs(at(item) - value) <= 2))

/** The middle of the gap after row `r` (or before it, with `r - 1`). */
const rowGapAfter = (grid: Grid, r: number) => ((grid.rows[r]?.bottom ?? 0) + (grid.rows[r + 1]?.top ?? (grid.rows[r]?.bottom ?? 0) + 16)) / 2

/** The column gap the vertical leg runs in: between the two columns when they differ, else the
 *  gap right of the column, else left of it, else just right of the only column. */
function columnGapX(grid: Grid, from: number, to: number): number {
  const cols = grid.cols
  const between = (c: number) => ((cols[c]?.right ?? 0) + (cols[c + 1]?.left ?? 0)) / 2
  if (from < to) return between(from)
  if (from > to) return between(from - 1)
  if (from + 1 < cols.length) return between(from)
  if (from > 0) return between(from - 1)
  return (cols[from]?.right ?? 0) + 8
}

/**
 * A global-view arc between pills in different rows that would cross another pill: out of the
 * sender into the row gap next to it, along that gap to a column gap, along the column gap to the
 * row gap next to the recipient, and into the recipient. The label sits on the first leg in the
 * row gap, which no pill reaches into.
 */
export function gridDetour(from: Box, to: Box, pills: readonly Box[]): { points: Point[]; label: Point } {
  const grid = gridOf(pills)
  const rs = indexOf(grid.rows, (row) => row.top, from.y)
  const rr = indexOf(grid.rows, (row) => row.top, to.y)
  const down = rr > rs
  const ax = from.x + from.w / 2
  const bx = to.x + to.w / 2
  const y1 = down ? rowGapAfter(grid, rs) : rowGapAfter(grid, rs - 1)
  const y2 = down ? rowGapAfter(grid, rr - 1) : rowGapAfter(grid, rr)
  const gx = columnGapX(grid, indexOf(grid.cols, (col) => col.left, from.x), indexOf(grid.cols, (col) => col.left, to.x))
  const start = { x: ax, y: down ? from.y + from.h + 1 : from.y - 1 }
  const end = { x: bx, y: down ? to.y - 3 : to.y + to.h + 3 }
  return { points: [start, { x: ax, y: y1 }, { x: gx, y: y1 }, { x: gx, y: y2 }, { x: bx, y: y2 }, end], label: { x: (ax + gx) / 2, y: y1 } }
}

/** How far a channel through a column of cards keeps from the cards above and below it. */
const CHANNEL_CLEARANCE = 15

/**
 * The height at which a line can cross the cards between two non-adjacent columns: free of every
 * card in `between`, inside the graph, nearest to `want`. Below the lowest card is always free.
 */
function channelY(between: readonly Box[], want: number, ends: readonly number[]): number {
  const candidates = [...ends, ...between.flatMap((b) => [b.y - CHANNEL_CLEARANCE, b.y + b.h + CHANNEL_CLEARANCE])]
  // Above the graph's top edge a line would run over the header and chips.
  const free = candidates.filter((y) => y >= 0 && !between.some((b) => b.y - 6 < y && y < b.y + b.h + 6))
  return free.reduce((best, y) => (Math.abs(y - want) < Math.abs(best - want) ? y : best), free[0] ?? want)
}

/**
 * A project-view peer line whose curve would cross a card of a column between the two ends: out
 * of the sender's facing edge into the column gap, along it to a height that is free in every
 * column between, across those columns, along the recipient's column gap, and into its edge.
 */
export function channelDetour(a: Point, b: Point, gap: number, cards: readonly Box[]): { points: Point[]; label: Point } {
  const dir = b.x > a.x ? 1 : -1
  const g1 = a.x + (dir * gap) / 2
  const g2 = b.x - (dir * gap) / 2
  const between = cards.filter((card) => card.x + card.w > Math.min(g1, g2) && card.x < Math.max(g1, g2))
  const cy = channelY(between, (a.y + b.y) / 2, [a.y, b.y])
  const label = cy !== a.y ? { x: g1, y: (a.y + cy) / 2 } : { x: g2, y: (cy + b.y) / 2 }
  return { points: [a, { x: g1, y: a.y }, { x: g1, y: cy }, { x: g2, y: cy }, { x: g2, y: b.y }, { x: b.x - dir * 2, y: b.y }], label }
}
