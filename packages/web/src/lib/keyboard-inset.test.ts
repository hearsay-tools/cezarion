import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  keyboardAwareCollisionPadding,
  keyboardInset,
  keyboardOpen,
  useKeyboardOpen,
  useViewportInsets,
  viewportInsets,
  watchKeyboardInset,
  watchViewportInsets,
  type KeyboardViewport,
  type KeyboardWindow,
  type ViewportInsets,
} from './keyboard-inset'

/** A drivable visualViewport: tests resize it and fire the listeners, like Safari does. */
class StubViewport implements KeyboardViewport {
  listeners = new Map<'resize' | 'scroll', Set<() => void>>()
  constructor(
    public height: number,
    public offsetTop = 0,
    public scale = 1,
  ) {}
  addEventListener(type: 'resize' | 'scroll', listener: () => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: 'resize' | 'scroll', listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }
  fire(type: 'resize' | 'scroll') {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

const win = (viewport: KeyboardViewport | null, innerHeight = 800): KeyboardWindow => ({
  innerHeight,
  visualViewport: viewport,
})

describe('keyboardInset — the --kb math', () => {
  it.each([
    // [innerHeight, vv.height, vv.offsetTop, expected]
    [800, 800, 0, 0], // keyboard closed
    [800, 460, 0, 340], // iOS keyboard open, viewport not panned
    [800, 460, 100, 240], // panned down: the pan eats into the overlap
    [800, 810, 0, 0], // URL-bar collapse makes vv taller — NOT a keyboard, clamped
    [800, 799.4, 0, 1], // fractional Safari values round, not truncate
  ])('inner %d, vv %d @ %d → %d', (innerHeight, height, offsetTop, expected) => {
    expect(keyboardInset(win(new StubViewport(height, offsetTop), innerHeight))).toBe(expected)
  })

  it('is 0 without a visualViewport (older engines)', () => {
    expect(keyboardInset(win(null))).toBe(0)
  })
})

describe('viewportInsets — the collision-padding math', () => {
  it.each([
    // [innerHeight, vv.height, vv.offsetTop, expected top, expected bottom]
    [800, 800, 0, 0, 0], // keyboard closed
    [800, 460, 0, 0, 340], // keyboard open, not panned
    [800, 460, 100, 100, 240], // panned down: top hidden behind the pan, bottom behind the keys
    [800, 810, 0, 0, 0], // URL-bar collapse — nothing hidden, both clamp at 0
  ])('inner %d, vv %d @ %d → top %d / bottom %d', (innerHeight, height, offsetTop, top, bottom) => {
    expect(viewportInsets(win(new StubViewport(height, offsetTop), innerHeight))).toEqual({ top, bottom })
  })

  it('is {0,0} without a visualViewport (older engines, jsdom)', () => {
    expect(viewportInsets(win(null))).toEqual({ top: 0, bottom: 0 })
  })
})

describe('keyboardAwareCollisionPadding', () => {
  const insets: ViewportInsets = { top: 100, bottom: 340 }

  it('defaults to the insets alone (Radix default padding is 0)', () => {
    expect(keyboardAwareCollisionPadding(insets)).toEqual({ top: 100, right: 0, bottom: 340, left: 0 })
  })

  it('adds a uniform number padding to every side, insets on top/bottom only', () => {
    expect(keyboardAwareCollisionPadding(insets, 8)).toEqual({ top: 108, right: 8, bottom: 348, left: 8 })
  })

  it('merges a partial per-side object', () => {
    expect(keyboardAwareCollisionPadding({ top: 0, bottom: 0 }, { left: 12 })).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 12,
    })
  })
})

describe('watchViewportInsets — the stubbed adapter', () => {
  it('applies on install and tracks resize and pan events', () => {
    const viewport = new StubViewport(800)
    const applied: ViewportInsets[] = []
    watchViewportInsets(win(viewport), (insets) => applied.push(insets))
    expect(applied).toEqual([{ top: 0, bottom: 0 }])

    viewport.height = 460
    viewport.fire('resize')
    viewport.offsetTop = 120
    viewport.fire('scroll')
    expect(applied).toEqual([
      { top: 0, bottom: 0 },
      { top: 0, bottom: 340 },
      { top: 120, bottom: 220 },
    ])
  })

  it('cleanup detaches the listeners', () => {
    const viewport = new StubViewport(800)
    const applied: ViewportInsets[] = []
    const stop = watchViewportInsets(win(viewport), (insets) => applied.push(insets))
    stop()
    viewport.height = 460
    viewport.fire('resize')
    expect(applied).toEqual([{ top: 0, bottom: 0 }])
  })

  it('degrades to a one-shot {0,0} without a visualViewport', () => {
    const applied: ViewportInsets[] = []
    const stop = watchViewportInsets(win(null), (insets) => applied.push(insets))
    expect(applied).toEqual([{ top: 0, bottom: 0 }])
    stop() // must not throw
  })
})

describe('useViewportInsets — the React binding', () => {
  const setViewport = (viewport: KeyboardViewport | null) =>
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })

  afterEach(() => setViewport(null))

  it('tracks the real window.visualViewport while mounted', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    const viewport = new StubViewport(800)
    setViewport(viewport)
    const { result, unmount } = renderHook(() => useViewportInsets())
    expect(result.current).toEqual({ top: 0, bottom: 0 })

    act(() => {
      viewport.height = 460
      viewport.offsetTop = 100
      viewport.fire('resize')
    })
    expect(result.current).toEqual({ top: 100, bottom: 240 })

    unmount()
    act(() => {
      viewport.height = 800
      viewport.fire('resize')
    })
    expect(viewport.listeners.get('resize')?.size ?? 0).toBe(0) // unsubscribed
  })

  it('stays {0,0} without a visualViewport (jsdom, desktop engines)', () => {
    const { result } = renderHook(() => useViewportInsets())
    expect(result.current).toEqual({ top: 0, bottom: 0 })
  })
})

describe('watchKeyboardInset — the stubbed adapter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies on install, tracks every viewport event, settles once after the burst', () => {
    const viewport = new StubViewport(800)
    const applied: number[] = []
    const settled: number[] = []
    watchKeyboardInset(win(viewport), (px) => applied.push(px), (px) => settled.push(px), 250)

    expect(applied).toEqual([0]) // the install-time apply

    // Safari streams resize events through the keyboard animation.
    viewport.height = 700
    viewport.fire('resize')
    viewport.height = 540
    viewport.fire('resize')
    viewport.height = 460
    viewport.fire('resize')
    expect(applied).toEqual([0, 100, 260, 340]) // the composer tracked the animation…

    expect(settled).toEqual([]) // …but nothing settled yet
    vi.advanceTimersByTime(249)
    expect(settled).toEqual([])
    vi.advanceTimersByTime(1)
    expect(settled).toEqual([340]) // one settle, at the final inset, after the debounce
  })

  it('viewport pans (scroll events) re-derive the inset too', () => {
    const viewport = new StubViewport(460)
    const applied: number[] = []
    watchKeyboardInset(win(viewport), (px) => applied.push(px))
    viewport.offsetTop = 120
    viewport.fire('scroll')
    expect(applied).toEqual([340, 220])
  })

  it('cleanup removes the listeners, cancels the pending settle, and resets to 0', () => {
    const viewport = new StubViewport(800)
    const applied: number[] = []
    const settled: number[] = []
    const stop = watchKeyboardInset(win(viewport), (px) => applied.push(px), (px) => settled.push(px))

    viewport.height = 460
    viewport.fire('resize')
    stop()

    expect(applied).toEqual([0, 340, 0]) // the reset — a stale --kb must not outlive the view
    vi.runAllTimers()
    expect(settled).toEqual([]) // the in-flight settle died with the watcher
    viewport.fire('resize')
    expect(applied).toEqual([0, 340, 0]) // detached
  })

  it('degrades to a no-op apply(0) without a visualViewport', () => {
    const applied: number[] = []
    const stop = watchKeyboardInset(win(null), (px) => applied.push(px))
    expect(applied).toEqual([0])
    stop() // must not throw
  })
})

describe('keyboardOpen — what hides the phone tab bar', () => {
  it.each([
    // [innerHeight, vv.height, vv.offsetTop, vv.scale, expected]
    [800, 800, 0, 1, false], // closed
    [800, 460, 0, 1, true], // iOS keyboard
    [800, 740, 0, 1, false], // 60px of browser chrome is not a keyboard
    [800, 500, 0, 2.5, false], // pinch-zoomed: shorter visual viewport, no keyboard
    [800, 500, 0, 1.02, true], // rounding noise around 1 still counts as 1
  ])('inner %d, vv %d @ %d, scale %d → %s', (innerHeight, height, offsetTop, scale, expected) => {
    expect(keyboardOpen(win(new StubViewport(height, offsetTop, scale), innerHeight))).toBe(expected)
  })

  it('is false without a visualViewport', () => {
    expect(keyboardOpen(win(null))).toBe(false)
  })
})

describe('keyboardOpen — resizes-content keyboard (layout viewport shrinks)', () => {
  const textarea = { tagName: 'TEXTAREA' }
  const button = { tagName: 'BUTTON' }
  /** vv tracks innerHeight, so the inset stays 0 — the Chromium resizes-content shape. */
  const resized = (h: number, focused: unknown = null, w = 400): KeyboardWindow => ({
    innerHeight: h,
    innerWidth: w,
    visualViewport: new StubViewport(h),
    document: { activeElement: focused },
  })
  // One window per case; the baseline is per window, so each starts closed at 800.
  const withClosed = (focused: unknown) => {
    const w = resized(800, focused)
    keyboardOpen(w)
    return w
  }

  it('height drop + focused textarea → open', () => {
    const w = withClosed(textarea)
    w.innerHeight = 480
    expect(keyboardOpen(w)).toBe(true)
  })

  it('height drop + focused text input / contenteditable → open; checkbox → closed', () => {
    for (const el of [{ tagName: 'INPUT', type: 'email' }, { tagName: 'DIV', isContentEditable: true }]) {
      const w = withClosed(el)
      w.innerHeight = 480
      expect(keyboardOpen(w)).toBe(true)
    }
    const w = withClosed({ tagName: 'INPUT', type: 'checkbox' })
    w.innerHeight = 480
    expect(keyboardOpen(w)).toBe(false)
  })

  it('height drop without a focused field → closed (narrow desktop window resized)', () => {
    const w = withClosed(button)
    w.innerHeight = 480
    expect(keyboardOpen(w)).toBe(false)
  })

  it('focus without a height drop → closed (hardware keyboard)', () => {
    const w = withClosed(textarea)
    expect(keyboardOpen(w)).toBe(false)
  })

  it('a drop under the minimum is not a keyboard', () => {
    const w = withClosed(textarea)
    w.innerHeight = 740
    expect(keyboardOpen(w)).toBe(false)
  })

  it('closes again when the height returns', () => {
    const w = withClosed(textarea)
    w.innerHeight = 480
    expect(keyboardOpen(w)).toBe(true)
    w.innerHeight = 800
    expect(keyboardOpen(w)).toBe(false)
  })

  it('rotation (width change) resets the baseline', () => {
    const w = withClosed(textarea)
    w.innerWidth = 800 // landscape: shorter, but a new baseline
    w.innerHeight = 400
    expect(keyboardOpen(w)).toBe(false)
  })
})

describe('useKeyboardOpen — the React binding', () => {
  it('follows window resize + focus and removes every listener on unmount', () => {
    const originalHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
    Object.defineProperty(window, 'visualViewport', { value: null, configurable: true })
    const area = document.createElement('textarea')
    document.body.append(area)
    const add = vi.spyOn(window, 'addEventListener')
    const addDoc = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const removeDoc = vi.spyOn(document, 'removeEventListener')

    const { result, unmount } = renderHook(() => useKeyboardOpen())
    expect(result.current).toBe(false)
    act(() => {
      area.focus()
      ;(window as { innerHeight: number }).innerHeight = 480
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBe(true)
    act(() => {
      area.blur()
      document.dispatchEvent(new Event('focusout'))
    })
    expect(result.current).toBe(false)

    unmount()
    for (const [spy, type] of [[remove, 'resize'], [removeDoc, 'focusin'], [removeDoc, 'focusout']] as const) {
      expect(spy.mock.calls.some((c) => c[0] === type)).toBe(true)
    }
    expect(add.mock.calls.some((c) => c[0] === 'resize')).toBe(true)
    expect(addDoc.mock.calls.some((c) => c[0] === 'focusin')).toBe(true)
    vi.restoreAllMocks()
    area.remove()
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true, writable: true })
  })
})
