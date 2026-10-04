import { describe, expect, it } from 'vitest'
import { uiStateSchema } from './workspace.js'

describe('per-project sidebar limits contract', () => {
  it.each([0, -1, 1.5, '2', '', true, Infinity])('rejects invalid limit %j', value => {
    for (const key of ['overall', 'needsYou', 'finished', 'working']) {
      expect(uiStateSchema.safeParse({ sidebarLimits: { [key]: value } }).success).toBe(false)
    }
  })
  it('preserves positive integers, Unlimited and absent preferences', () => {
    expect(uiStateSchema.parse({})).toEqual({})
    const state = { sidebarLimits: { overall: 7, needsYou: null, finished: 2, working: null } }
    expect(uiStateSchema.parse(state)).toEqual(state)
  })
})
