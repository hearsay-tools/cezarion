import { afterEach, expect, it, vi } from 'vitest'
import { expandedRailSampleExpression } from '../../e2e/project-rail-ready'
import { settledSampleExpression } from '../../e2e/visual-ready'

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value: () => true })

function fixture(expanded = false) {
  document.body.innerHTML = `<nav data-slot="project-rail" data-expanded="${expanded}">
    <button data-slot="rail-expand-toggle" aria-expanded="${expanded}"></button>
    <span id="ink" style="opacity:0"><span data-slot="rail-project-name">Other project</span></span>
  </nav>`
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 232, height: 900 } as DOMRect)
  return () => window.eval(settledSampleExpression(expandedRailSampleExpression()))
}

// #795 loaded-after: the old boolean could hold false while the reload still
// mounted the expanded rail. A ready body is not the expansion's semantic commit.
it('waits for the expanded rail commit while the body is already stable', () => {
  const sample = fixture()
  expect(sample()).toBeNull()
})

// Native loaded trace: seven false samples had no rail/toggle/name yet. The
// later capture had expanded semantics but absent text ink; it does not prove why.
it('does not accept a stable loading body before the rail mounts on reload', () => {
  const sample = fixture()
  document.body.innerHTML = '<main>Loading projects</main>'
  expect(sample()).toBeNull()
})

it('waits for the measured name to be natively rendered before measuring boxes', () => {
  const sample = fixture(true)
  vi.spyOn(Element.prototype, 'checkVisibility').mockImplementation(function (this: Element) {
    return !this.matches('[data-slot="rail-project-name"]')
  })
  expect(sample()).toBeNull()
})

it('rejects native-skipped rail geometry before a box read can force rendering', () => {
  fixture(true)
  const rail = document.querySelector('[data-slot="project-rail"]')
  if (!rail) throw new Error('fixture rail missing')
  vi.spyOn(rail, 'checkVisibility').mockReturnValue(false)
  const boxes = vi.spyOn(rail, 'getBoundingClientRect').mockImplementation(() => {
    throw new Error('forced skipped rail geometry')
  })
  expect(window.eval(expandedRailSampleExpression())).toBeNull()
  expect(boxes).not.toHaveBeenCalled()
})

it('keeps finite fade completion independent of the opacity assertion', () => {
  const sample = fixture(true)
  let playState = 'running'
  vi.spyOn(Element.prototype, 'getAnimations').mockImplementation(function (this: Element) {
    return this.id === 'ink' ? [{ playState, effect: { getComputedTiming: () => ({ iterations: 1 }) } }] as unknown as Animation[] : []
  })
  expect(sample()).toBeNull()
  playState = 'finished'
  expect(sample().value).toEqual({ width: 232, opacity: '0' })
})

it('returns wrong settled width and opacity for the unchanged assertions to reject', () => {
  const sample = fixture(true)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { x: 0, y: 0, width: this.matches('[data-slot="project-rail"]') ? 0 : 232, height: 900 } as DOMRect
  })
  const facts = sample().value
  expect(facts).toEqual({ width: 0, opacity: '0' })
  expect(() => expect(facts.width).toBe(232)).toThrow()
  expect(() => expect(facts.opacity).toBe('1')).toThrow()
})
