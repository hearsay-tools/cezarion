import { describe, expect, it } from 'vitest'

import { LANE_GAP, laneOffsets, roundedPath, separateLabels } from './line-route'

describe('laneOffsets', () => {
  it('gives each request between one pair, in either direction, its own lane around the centre', () => {
    const lanes = laneOffsets([
      { requestId: 'there', senderRunId: 'a', recipientRunId: 'b' },
      { requestId: 'back', senderRunId: 'b', recipientRunId: 'a' },
      { requestId: 'alone', senderRunId: 'a', recipientRunId: 'c' },
    ])
    expect(Object.fromEntries(lanes)).toEqual({ there: -LANE_GAP / 2, back: LANE_GAP / 2, alone: 0 })
  })
})

describe('separateLabels', () => {
  const size = { w: 100, h: 20 }

  it('moves a label past every label already placed that it would overlap, along the axis', () => {
    const at = { x: 50, y: 50 }
    const sideways = separateLabels([{ id: 'a', at }, { id: 'b', at }, { id: 'c', at }], size, 'x')
    expect([...sideways.values()].map((p) => p.x)).toEqual([50, 154, 258])
    const down = separateLabels([{ id: 'a', at }, { id: 'b', at }], size, 'y')
    expect(down.get('b')).toEqual({ x: 50, y: 74 })
  })

  it('leaves labels that do not overlap where they are', () => {
    const out = separateLabels([{ id: 'a', at: { x: 0, y: 0 } }, { id: 'b', at: { x: 300, y: 0 } }], size, 'x')
    expect(out.get('b')).toEqual({ x: 300, y: 0 })
  })
})

describe('roundedPath', () => {
  it('rounds each corner and drops repeated and straight-through points', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 20 }, { x: 0, y: 40 }, { x: 40, y: 40 }])).toBe('M0 0 L 0 32 Q 0 40, 8 40 L 40 40')
  })
})
