import type { Point } from './line-geometry'
import type { Rect } from './line-route'

/**
 * Stack the project view's peer labels (spec 2026-11-05-live-activity-view, "Lines between tasks"
 * and "Many lines"). Labels that share a column gap are kept apart and inside the viewport in one
 * step: each moves into the viewport, then down past the label above it, then, from the bottom
 * edge, up past the label below it. When a gap cannot hold them all, they stay apart and the
 * topmost leaves the viewport's top edge; a label never covers another. Pure.
 */

export interface PlacedLabel {
  id: string
  at: Point
}

/** Labels whose centres are closer than a label's width sideways share a column. */
function columns(labels: readonly PlacedLabel[], width: number): PlacedLabel[][] {
  const out: PlacedLabel[][] = []
  for (const label of labels) {
    const column = out.find((group) => Math.abs((group[0]?.at.x ?? Number.NaN) - label.at.x) < width)
    if (column) column.push(label)
    else out.push([label])
  }
  return out
}

/** One column, top to bottom: inside the viewport, then apart going down, then apart going up
 *  from the bottom edge. */
function stackColumn(column: readonly PlacedLabel[], step: number, top: number, bottom: number): PlacedLabel[] {
  const ys = column.map((label) => Math.min(bottom, Math.max(top, label.at.y)))
  const order = ys.map((_, i) => i).sort((a, b) => (ys[a] as number) - (ys[b] as number))
  for (let k = 1; k < order.length; k++) {
    const i = order[k] as number
    ys[i] = Math.max(ys[i] as number, (ys[order[k - 1] as number] as number) + step)
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k] as number
    const below = k + 1 < order.length ? (ys[order[k + 1] as number] as number) - step : bottom
    ys[i] = Math.min(ys[i] as number, below)
  }
  return column.map((label, i) => ({ id: label.id, at: { x: label.at.x, y: ys[i] as number } }))
}

/**
 * The final centre of each label. `view` is the visible part of the host; without one, labels
 * only move apart, downwards.
 */
export function stackLabels(labels: readonly PlacedLabel[], size: { w: number; h: number }, view?: Rect, pad = 4): Map<string, Point> {
  const top = view ? view.y0 + size.h / 2 : Number.NEGATIVE_INFINITY
  const bottom = view ? view.y1 - size.h / 2 : Number.POSITIVE_INFINITY
  const out = new Map<string, Point>()
  for (const column of columns(labels, size.w + pad)) {
    for (const label of stackColumn(column, size.h + pad, top, bottom)) out.set(label.id, label.at)
  }
  return out
}
