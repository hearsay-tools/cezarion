import { expect, it } from 'vitest'
import { expectEditorFitsViewport } from '../../e2e/session-layout'

// #795 review proof: editor bottom 1000 / actions bottom 980 passes normal-padding
// assertions, but an 844px viewport must still reject that accepted geometry.
it('rejects an out-of-viewport editor even when its action padding passes', () => {
  const facts = { editor: { bottom: 1000 }, viewportHeight: 844, bottomGap: 20 }
  expect(facts.bottomGap).toBeGreaterThanOrEqual(0)
  expect(facts.bottomGap).toBeLessThanOrEqual(20)
  expect(() => expectEditorFitsViewport(facts)).toThrow()
})

it('retains exactly one pixel of viewport allowance', () => {
  expect(() => expectEditorFitsViewport({ editor: { bottom: 845 }, viewportHeight: 844 })).not.toThrow()
  expect(() => expectEditorFitsViewport({ editor: { bottom: 845.001 }, viewportHeight: 844 })).toThrow()
})
