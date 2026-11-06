import { describe, expect, it } from 'vitest'

import { stackLabels } from './label-stack'

const size = { w: 88, h: 40 }
const view = { x0: 0, y0: 0, x1: 1000, y1: 600 }
const at = (id: string, x: number, y: number) => ({ id, at: { x, y } })
const ys = (out: Map<string, { y: number }>) => [...out.values()].map((p) => p.y)

describe('stackLabels', () => {
  it('moves labels into the viewport, then up from its bottom edge so they stay apart', () => {
    const out = stackLabels([at('a', 348, 590), at('b', 348, 590), at('c', 348, 640)], size, view)
    expect(ys(out)).toEqual([492, 536, 580])
  })

  it('pushes labels down past each other, as before, while the gap has room', () => {
    expect(ys(stackLabels([at('a', 348, 100), at('b', 348, 110)], size, view))).toEqual([100, 144])
  })

  it('keeps labels of other gaps where they are', () => {
    expect(ys(stackLabels([at('a', 348, 580), at('b', 744, 580)], size, view))).toEqual([580, 580])
  })

  it('keeps labels apart when a gap cannot hold them all: the topmost leaves the top edge', () => {
    const out = ys(stackLabels(Array.from({ length: 16 }, (_, i) => at(`l${i}`, 348, 300)), size, view)).sort((a, b) => a - b)
    expect(out[out.length - 1]).toBe(580)
    for (let i = 1; i < out.length; i++) expect(out[i]! - out[i - 1]!).toBeGreaterThanOrEqual(size.h)
    expect(out[0]).toBeLessThan(size.h / 2)
  })

  it('only moves labels apart, downwards, without a viewport', () => {
    expect(ys(stackLabels([at('a', 0, 5_000), at('b', 0, 5_000)], size))).toEqual([5_000, 5_044])
  })
})
