import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivitySummary } from './activity-summary'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** Controlled layout exercises the real measurement and ResizeObserver path. Browser QA
 * checks intrinsic font widths separately. Every value here is 40px, with a 10px gap. */
function layout(scale = 1) {
  let width = 400
  let resize = () => {}
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { width: this.hasAttribute('data-summary-item') ? 40 * scale : width } as DOMRect
  })
  vi.stubGlobal('getComputedStyle', () => ({ columnGap: '10px', width: `${width / scale}px` }))
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  return (next: number) => { width = next; act(() => resize()) }
}

const visible = () => [...document.querySelectorAll('[data-summary-item][data-hidden="false"]')].map(el => el.textContent)

it('removes usage values in order, then restores them when space returns', () => {
  const resize = layout()
  render(<ActivitySummary items={[
    { id: 'provider', priority: 2, content: 'openai' },
    { id: 'model', priority: 4, content: 'gpt-6' },
    { id: 'effort', priority: 3, content: 'high' },
    { id: 'cost', priority: 1, content: '$26' },
    { id: 'tokens', priority: 0, content: 'IN 668 · OUT 197.5k' },
  ]} />)
  expect(visible()).toEqual(['openai', 'gpt-6', 'high', '$26', 'IN 668 · OUT 197.5k'])
  resize(239)
  expect(visible()).toEqual(['openai', 'gpt-6', 'high', '$26'])
  resize(189)
  expect(visible()).toEqual(['openai', 'gpt-6', 'high'])
  resize(139)
  expect(visible()).toEqual(['gpt-6', 'high'])
  resize(89)
  expect(visible()).toEqual(['gpt-6'])
  resize(39)
  expect(visible()).toEqual([])
  expect(document.querySelector('[data-summary-item="model"]')?.getAttribute('aria-hidden')).toBe('true')
  expect(document.querySelector('[data-summary-item="model"]')?.hasAttribute('inert')).toBe(true)
  resize(240)
  expect(visible()).toEqual(['openai', 'gpt-6', 'high', '$26', 'IN 668 · OUT 197.5k'])
})

it('keeps session status longest and drops the reference chips first', () => {
  const resize = layout()
  render(<ActivitySummary items={[
    { id: 'status', priority: 5, content: 'Waiting for CI' },
    { id: 'runner', priority: 2, content: 'claude' },
    { id: 'model', priority: 4, content: 'opus' },
    { id: 'effort', priority: 3, content: 'high' },
    { id: 'cost', priority: 1, content: '$26' },
    { id: 'chips', priority: 0, content: 'PR #1422 · Issue #1333' },
  ]} />)
  resize(289)
  expect(visible()).toEqual(['Waiting for CI', 'claude', 'opus', 'high', '$26'])
  resize(239)
  expect(visible()).toEqual(['Waiting for CI', 'claude', 'opus', 'high'])
  resize(189)
  expect(visible()).toEqual(['Waiting for CI', 'opus', 'high'])
  resize(139)
  expect(visible()).toEqual(['Waiting for CI', 'opus'])
  resize(89)
  expect(visible()).toEqual(['Waiting for CI'])
  resize(39)
  expect(visible()).toEqual([])
})

it('counts scaled gaps at 200% zoom before keeping a value', () => {
  const resize = layout(2)
  render(<ActivitySummary items={[
    { id: 'model', priority: 1, content: 'opus' },
    { id: 'cost', priority: 0, content: '$26' },
  ]} />)
  resize(179)
  expect(visible()).toEqual(['opus'])
  resize(180)
  expect(visible()).toEqual(['opus', '$26'])
})
