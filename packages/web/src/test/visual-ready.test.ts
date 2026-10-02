import { afterEach, expect, it, vi } from 'vitest'
import { visualSampleExpression } from '../../e2e/visual-ready'

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })
Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
const sample = (options = {}) => window.eval(visualSampleExpression('main', options))
it('waits for the target, intended appearance and fonts rather than just elapsed time', () => {
  expect(sample()).toBeNull()
  document.body.innerHTML = '<main>Loaded route</main>'
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 1, y: 2, width: 200, height: 100, top: 2, left: 1, right: 201, bottom: 102, toJSON() {} })
  vi.spyOn(Element.prototype, 'getAnimations').mockReturnValue([])
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading' } })
  expect(sample()).toBeNull()
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } })
  expect(sample({ theme: 'light' })).toBeNull()
  document.documentElement.classList.add('light')
  expect(sample({ theme: 'light' })).toMatchObject({ text: 'Loaded route' })
})
it('waits out finite animations but permits a deliberately held request and infinite spinners', () => {
  document.body.innerHTML = '<main>Loading</main>'
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 20, height: 20 } as DOMRect)
  const animations = vi.spyOn(Element.prototype, 'getAnimations')
  animations.mockReturnValue([{ playState: 'running', effect: { getComputedTiming: () => ({ iterations: 1 }) } }] as unknown as Animation[])
  expect(sample()).toBeNull()
  animations.mockReturnValue([{ playState: 'running', effect: { getComputedTiming: () => ({ iterations: Infinity }) } }] as unknown as Animation[])
  ;(window as unknown as { __cezIdle: boolean }).__cezIdle = false
  expect(sample({ idle: true })).toBeNull()
  expect(sample({ idle: false })).not.toBeNull()
})

it('holds layout around a spinner without requiring its intentionally moving ink to stop', () => {
  document.body.innerHTML = '<main><span class="spinner"><i></i></span><p>Loading</p></main>'
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } })
  let frame = 0
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const moving = this.matches('.spinner, .spinner *')
    return { x: moving ? frame++ : 0, y: 0, width: 20, height: 20 } as DOMRect
  })
  vi.spyOn(Element.prototype, 'getAnimations').mockImplementation(function (this: Element) {
    return this.matches('.spinner') ? [{ playState: 'running', effect: { getComputedTiming: () => ({ iterations: Infinity }) } }] as unknown as Animation[] : []
  })
  expect(sample()).toEqual(sample())
})
