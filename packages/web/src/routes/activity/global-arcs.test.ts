// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { sameArcs, type ArcShape } from './global-arcs'

describe('sameArcs', () => {
  const arc: ArcShape = { id: 'wait:a:b', kind: 'wait', d: 'M0 0 L 10 10', label: { x: 5, y: 5 } }

  it('holds two lists with the same arcs in the same order equal', () => {
    expect(sameArcs([arc], [{ ...arc, label: { ...arc.label } }])).toBe(true)
    expect(sameArcs([], [])).toBe(true)
  })

  it('tells lists apart by length, id, path and label place', () => {
    expect(sameArcs([arc], [])).toBe(false)
    expect(sameArcs([arc], [{ ...arc, id: 'wait:a:c' }])).toBe(false)
    expect(sameArcs([arc], [{ ...arc, d: 'M0 0 L 10 12' }])).toBe(false)
    expect(sameArcs([arc], [{ ...arc, label: { x: 6, y: 5 } }])).toBe(false)
    expect(sameArcs([arc], [{ ...arc, label: { x: 5, y: 6 } }])).toBe(false)
  })
})
