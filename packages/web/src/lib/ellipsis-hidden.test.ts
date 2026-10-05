import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ellipsisHiddenChildren, useEllipsisHiddenChildren } from './ellipsis-hidden'

/** A 200px line at x=0 holding children with the given right edges (jsdom has no layout). */
function line(rights: number[], { scroll = 260, client = 200 } = {}): HTMLElement {
  const el = document.createElement('div')
  rights.forEach((right, index) => {
    const child = document.createElement('a')
    child.dataset.index = String(index)
    child.getBoundingClientRect = () => ({ right } as DOMRect)
    el.appendChild(child)
  })
  el.getBoundingClientRect = () => ({ left: 0, right: client } as DOMRect)
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scroll })
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => client })
  document.body.appendChild(el)
  return el
}

const indexes = (children: Element[]) => children.map((child) => (child as HTMLElement).dataset.index)

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('ellipsisHiddenChildren', () => {
  it('hides nothing while the content fits', () => {
    expect(ellipsisHiddenChildren(line([60, 120, 210], { scroll: 200 }), 10)).toEqual([])
  })

  it('hides every child that ends past the point where the ellipsis begins', () => {
    // The `…` starts at 190: the chip ending at 189 is painted, the one ending at 195 is not.
    expect(indexes(ellipsisHiddenChildren(line([60, 120, 189, 195, 240]), 10))).toEqual(['3', '4'])
  })

  it('keeps a chip that ends exactly where the ellipsis begins', () => {
    expect(indexes(ellipsisHiddenChildren(line([60, 190, 240]), 10))).toEqual(['2'])
  })
})

describe('useEllipsisHiddenChildren', () => {
  const observers: Array<() => void> = []
  const stubResizeObserver = () => {
    observers.length = 0
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  }

  it('marks the hidden children, follows a resize, and clears the marks on unmount', () => {
    stubResizeObserver()
    const el = line([60, 120, 230])
    const ref = { current: el }
    const { unmount } = renderHook(() => useEllipsisHiddenChildren(ref, true, 'k'))
    const marked = () => Array.from(el.children).filter((child) => child.hasAttribute('data-ellipsis-hidden'))
    expect(indexes(marked())).toEqual(['2'])
    // The column widens and the line fits: nothing stays inert.
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => 200 })
    act(() => observers.forEach((cb) => cb()))
    expect(marked()).toEqual([])
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => 260 })
    act(() => observers.forEach((cb) => cb()))
    expect(indexes(marked())).toEqual(['2'])
    unmount()
    expect(marked()).toEqual([])
  })

  it('does nothing when disabled (inert references are not links)', () => {
    stubResizeObserver()
    const el = line([60, 120, 230])
    renderHook(() => useEllipsisHiddenChildren({ current: el }, false, 'k'))
    expect(el.querySelector('[data-ellipsis-hidden]')).toBeNull()
  })

  it('does nothing without a ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const el = line([60, 120, 230])
    renderHook(() => useEllipsisHiddenChildren({ current: el }, true, 'k'))
    expect(el.querySelector('[data-ellipsis-hidden]')).toBeNull()
  })
})
