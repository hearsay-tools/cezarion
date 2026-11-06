import { vi } from 'vitest'

import type { Box, Point } from './line-geometry'

/**
 * Geometry fixtures for the line tests. jsdom lays nothing out, so a test places the measured
 * elements itself, then samples the drawn paths.
 */

/** Answer `getBoundingClientRect` from `boxes`, keyed by the element's `attribute` value; every
 *  other element sits at the origin with no size (the host). */
export function placeBoxes(attribute: string, boxes: Record<string, Box>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const box = boxes[this.getAttribute(attribute) ?? '']
    const { x, y, w, h } = box ?? { x: 0, y: 0, w: 0, h: 0 }
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect
  })
}

/** A grid of boxes: `cols` columns and `rows` rows, `w`×`h` each, with the given gaps. */
export function gridBoxes(ids: string[][], { w = 220, h = 60, colGap = 14, rowGap = 44, top = 40 } = {}): Record<string, Box> {
  const out: Record<string, Box> = {}
  ids.forEach((row, r) => row.forEach((id, c) => { out[id] = { x: c * (w + colGap), y: top + r * (h + rowGap), w, h } }))
  return out
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** Points along an absolute `M`/`L`/`Q`/`C` path, the commands the line geometry writes. */
export function samplePath(d: string, steps = 40): Point[] {
  const out: Point[] = []
  let at: Point = { x: 0, y: 0 }
  for (const [, cmd, args] of d.matchAll(/([MLQC])([^MLQC]*)/g)) {
    const n = (args?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const p = (i: number): Point => ({ x: n[i] ?? 0, y: n[i + 1] ?? 0 })
    if (cmd === 'M') {
      at = p(0)
      out.push(at)
      continue
    }
    const ctrl = cmd === 'L' ? [at, p(0)] : cmd === 'Q' ? [at, p(0), p(2)] : [at, p(0), p(2), p(4)]
    for (let s = 1; s <= steps; s++) {
      let pts = ctrl
      while (pts.length > 1) pts = pts.slice(1).map((q, i) => lerp(pts[i] as Point, q, s / steps))
      out.push(pts[0] as Point)
    }
    at = ctrl[ctrl.length - 1] as Point
  }
  return out
}

/** True when the point lies inside the box, `inset` pixels in from each edge. */
export const inside = (p: Point, b: Box, inset = 1) => p.x > b.x + inset && p.x < b.x + b.w - inset && p.y > b.y + inset && p.y < b.y + b.h - inset

/** True when two boxes overlap. */
export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** A label's box from its centre (the style's left and top) and its size. */
export function labelBox(el: Element, size: { w: number; h: number }): Box {
  const style = (el as HTMLElement).style
  return { x: Number.parseFloat(style.left) - size.w / 2, y: Number.parseFloat(style.top) - size.h / 2, w: size.w, h: size.h }
}
