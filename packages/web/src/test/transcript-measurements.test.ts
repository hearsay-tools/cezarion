import { afterEach, expect, it, vi } from 'vitest'
import { assistantWidthExpression, messageClockExpression } from '../../e2e/transcript-measurements'
import { settledSampleExpression } from '../../e2e/visual-ready'

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value: () => true })

function lazyFixture() {
  document.body.innerHTML = '<article id="card"><div data-slot="assistant-message"><time data-slot="message-time"></time></div></article>'
  Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loaded' } })
  let rendered = false
  const visibility = vi.spyOn(Element.prototype, 'checkVisibility').mockImplementation(function (this: Element) {
    return !this.closest('article') || rendered
  })
  const skippedReads: Element[] = []
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.closest('article') && !rendered) {
      skippedReads.push(this)
      return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0 } as DOMRect
    }
    return { x: 0, y: 0, width: 317, height: 100, top: this.matches('time') ? 8 : 0, right: this.matches('time') ? 309 : 317 } as DOMRect
  })
  const scroll = vi.fn()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  const sample = (expression: string) => window.eval(settledSampleExpression(expression))
  return { sample, scroll, skippedReads, visibility, render: () => { rendered = true } }
}

// Review's actual failure: body readiness succeeds, but measured lazy targets are
// excluded from its signature and can still produce stable/vacuous all-zero values.
it('does not accept zero assistant width from a skipped target while body is ready', () => {
  const fixture = lazyFixture()
  expect(fixture.sample(assistantWidthExpression())).toBeNull()
  expect(fixture.skippedReads).toEqual([])
  fixture.render()
  expect(fixture.sample(assistantWidthExpression()).value).toBe(317)
  expect(fixture.scroll).not.toHaveBeenCalled() // preserve the live tail
})

it('chooses a rendered assistant instead of measuring the first skipped one', () => {
  const fixture = lazyFixture()
  document.body.insertAdjacentHTML('beforeend', '<div data-slot="assistant-message">rendered tail</div>')
  expect(fixture.sample(assistantWidthExpression()).value).toBe(317)
  expect(fixture.skippedReads).toEqual([])
  expect(fixture.scroll).not.toHaveBeenCalled()
})

it('scrolls an individual skipped card and waits for rendering before clock/card boxes', () => {
  const fixture = lazyFixture()
  expect(fixture.sample(messageClockExpression('#card'))).toBeNull()
  expect(fixture.scroll).toHaveBeenCalledOnce()
  expect(fixture.skippedReads).toEqual([])
  expect(fixture.visibility).toHaveBeenCalledWith({ contentVisibilityAuto: true })
  fixture.render()
  expect(fixture.sample(messageClockExpression('#card')).value).toMatchObject({ top: 8, right: 8, overflow: false })
})

it('returns an already-rendered zero width for the width assertion to reject', () => {
  const fixture = lazyFixture()
  fixture.render()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { x: 0, y: 0, width: this.matches('[data-slot="assistant-message"]') ? 0 : 317, height: 100 } as DOMRect
  })
  const width = fixture.sample(assistantWidthExpression()).value
  expect(width).toBe(0) // rendering is readiness; never poll until width exceeds 200
  expect(() => expect(width).toBeGreaterThan(200)).toThrow()
})
