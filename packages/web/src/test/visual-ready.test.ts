import { afterEach, expect, it, vi } from 'vitest'
import * as readiness from '../../e2e/visual-ready'
import type { AgentBrowser } from '../../e2e/agent-browser'
import { hoverVisiblePoint } from '../../e2e/contrast'
const { visualSampleExpression } = readiness

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })
Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
// jsdom has no renderer; tests supply the native Chrome visibility result.
Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value: () => true })
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

// #795 deterministic reproduction: reading a skipped subtree can force layout and
// change checkVisibility. A readiness probe must observe visibility FIRST.
it('rejects a skipped target before any geometry read can render it', () => {
  document.body.innerHTML = '<main><code>lazy fence</code></main>'
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } })
  const visible = vi.spyOn(Element.prototype, 'checkVisibility').mockReturnValue(false)
  const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
    visible.mockReturnValue(true)
    return { x: 0, y: 0, width: 200, height: 100 } as DOMRect
  })
  expect(sample()).toBeNull()
  expect(geometry).not.toHaveBeenCalled()
  expect(visible).toHaveBeenCalledWith({ contentVisibilityAuto: true })
})

it('does not force geometry for skipped descendants or hidden controls', () => {
  document.body.innerHTML = '<main><p>visible</p><code>skipped</code><button hidden>hidden</button></main>'
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } })
  vi.spyOn(Element.prototype, 'checkVisibility').mockImplementation(function (this: Element) {
    return !this.matches('code, [hidden]')
  })
  const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('code, [hidden]')) throw new Error('forced skipped layout')
    return { x: 0, y: 0, width: 200, height: 100 } as DOMRect
  })
  expect(sample()).not.toBeNull()
  expect(geometry.mock.instances.every(el => !(el as Element).matches('code, [hidden]'))).toBe(true)
})

it('keeps focus identity and geometry in the held signature, independent of a false assertion sample', () => {
  document.body.innerHTML = '<main><button id="a">A</button><button id="b">B</button></main>'
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } })
  vi.spyOn(Element.prototype, 'checkVisibility').mockReturnValue(true)
  let x = 0
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x, y: 0, width: 200, height: 100 } as DOMRect))
  expect(readiness).toHaveProperty('settledSampleExpression')
  const expression = readiness.settledSampleExpression('false', 'main')
  document.querySelector<HTMLButtonElement>('#a')?.focus()
  const first = window.eval(expression)
  document.querySelector<HTMLButtonElement>('#b')?.focus()
  const movedFocus = window.eval(expression)
  expect(first.value).toBe(false)
  expect(movedFocus.value).toBe(false)
  expect(movedFocus).not.toEqual(first)
  x = 20
  expect(window.eval(expression)).not.toEqual(movedFocus)
  expect(window.eval(expression)).toEqual(window.eval(expression))
})

// #795/#758: scrolling a lazy inline link requests rendering on a later frame.
// A forced rect in the scrolling task can report the intrinsic placeholder box.
it('scrolls a skipped hover target and waits for native rendering before rects', () => {
  document.body.innerHTML = '<main><a href="#">lazy link</a></main>'
  const target = document.querySelector('a')!
  let rendered = false
  const visibility = vi.spyOn(Element.prototype, 'checkVisibility').mockImplementation(() => rendered)
  const scroll = vi.fn()
  Object.defineProperty(target, 'scrollIntoView', { configurable: true, value: scroll })
  const rects = vi.spyOn(target, 'getClientRects').mockImplementation(() => {
    if (!rendered) throw new Error('forced skipped hover layout')
    return [{ left: 20, top: 20, width: 20, height: 20 }] as unknown as DOMRectList
  })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
  const points: Array<[number, number]> = []
  const browser = {
    moveTo: (x: number, y: number) => points.push([x, y]),
    waitForValue: (expression: string, matcher: (sample: unknown) => boolean) => {
      const first = window.eval(expression)
      expect(first).toBeNull()
      expect(matcher(first)).toBe(false)
      expect(rects).not.toHaveBeenCalled()
      expect(scroll).toHaveBeenCalledOnce()
      rendered = true // the next rendered frame, independent of hit-area expectations
      const accepted = window.eval(expression)
      expect(matcher(accepted)).toBe(true)
      return accepted
    },
  } as unknown as AgentBrowser
  hoverVisiblePoint(browser, 'a')
  expect(visibility).toHaveBeenCalledWith({ contentVisibilityAuto: true })
  expect(points).toEqual([[0, 0], [25, 25]])
})
