import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearThreadScrollCaches, saveThreadScroll } from './thread-scroll'
import { JumpToLatestPill, ThreadRows, useThreadScroll, type ThreadRow } from './thread-scroller'

const isCockpitE2e = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/lib/e2e-mode', () => ({ isCockpitE2e: () => isCockpitE2e() }))

beforeEach(() => {
  // virtua measures with a ResizeObserver; jsdom has none and never lays anything out.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  isCockpitE2e.mockReturnValue(false)
  delete window.__cezThreadScrollTo
  vi.useRealTimers()
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  clearThreadScrollCaches()
})

const rows = (count: number): ThreadRow[] =>
  Array.from({ length: count }, (_, index) => ({ key: `row-${index}`, node: <p>row {index}</p> }))

/** The mode is the caller's (threadRenderMode is pinned in thread-scroll.test.ts) — these
 *  tests pin what each mode RENDERS: the flat path keeps every row in the DOM with the
 *  content-visibility hint; the virtua path hands the same wrappers to the virtualizer. */
describe('ThreadRows — the threshold-switched renderer', () => {
  const controls = () => renderHook(() => useThreadScroll('r1')).result.current

  it('flat mode renders every row, marked and content-visibility-hinted', () => {
    render(<ThreadRows runId="r1" rows={rows(5)} mode="flat" controls={controls()} />)
    const region = document.querySelector('[data-slot="thread-rows"]')!
    expect(region.getAttribute('data-virtualized')).toBe('false')
    const rendered = document.querySelectorAll('[data-slot="thread-row"]')
    expect(rendered).toHaveLength(5)
    expect(rendered[0]!.className).toContain('[content-visibility:auto]')
    // Bubbles rely on flex alignment inside their row — every wrapper is a flex column.
    expect(rendered[0]!.className).toContain('flex-col')
    expect(rendered[0]!.className).toContain('w-full')
  })

  it('virtual mode mounts the virtua container instead', () => {
    render(<ThreadRows runId="r1" rows={rows(400)} mode="virtual" controls={controls()} />)
    const region = document.querySelector('[data-slot="thread-rows"]')!
    expect(region.getAttribute('data-virtualized')).toBe('true')
    // jsdom gives virtua a 0-height viewport, so it mounts a window, not the full list —
    // the honest jsdom-visible half of "the DOM stays bounded" (the real-browser half is
    // thread-scroll.e2e.ts's).
    const rendered = document.querySelectorAll('[data-slot="thread-row"]')
    expect(rendered.length).toBeLessThan(400)
    for (const row of rendered) expect(row.className).toContain('w-full')
  })

  it('flat rows keep their content in render order', () => {
    render(<ThreadRows runId="r1" rows={rows(3)} mode="flat" controls={controls()} />)
    const texts = [...document.querySelectorAll('[data-slot="thread-row"]')].map((el) => el.textContent)
    expect(texts).toEqual(['row 0', 'row 1', 'row 2'])
  })

  it.each(['flat', 'virtual'] as const)(
    '%s rows disable native overflow anchoring so a prepend cannot fight restoration',
    (mode) => {
      render(<ThreadRows runId="r1" rows={rows(mode === 'flat' ? 5 : 400)} mode={mode} controls={controls()} />)
      const region = document.querySelector('[data-slot="thread-rows"]')!
      expect(region.className).toContain('[overflow-anchor:none]')
    },
  )

  it('disables conversation overflow anchoring outside the phone-only media query', () => {
    const css = readFileSync(resolve(import.meta.dirname, 'session-layout.css'), 'utf8')
    const ungated = css.replace(/@media[^{]+\{[\s\S]*?\n\}/g, '')
    expect(ungated).toMatch(/\[data-slot='session-conversation'\][^\{]*\{[^}]*overflow-anchor:\s*none/)
  })
})

describe('useThreadScroll — outside a shell scroller (jsdom, tests, storybook-ish hosts)', () => {
  it('observes transcript, header, and dock growth that can move the live tail', () => {
    const observed: Element[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe(element: Element) { observed.push(element) }
      disconnect() {}
    })
    const Harness = () => {
      const controls = useThreadScroll('r1')
      return (
        <main data-slot="main">
          <section data-route="task-thread">
            <header data-slot="run-header" />
            <div data-slot="thread-rows" ref={controls.attachContent} />
            <footer data-slot="thread-dock" />
          </section>
        </main>
      )
    }

    render(<Harness />)

    expect(observed.map((element) => element.getAttribute('data-slot'))).toEqual([
      'thread-rows',
      'run-header',
      'thread-dock',
    ])
  })

  it('keeps jump-to-latest intent when refreshing history remounts the transcript', async () => {
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
    })
    scroller.scrollTo = vi.fn()
    const content = document.createElement('div')
    scroller.append(content)
    saveThreadScroll('refreshing-run', { top: 120, atBottom: false })
    let refreshed!: () => void
    const refresh = new Promise<void>((resolve) => { refreshed = resolve })
    const before = renderHook(() => useThreadScroll('refreshing-run', { onJumpToLatest: () => refresh }))
    act(() => before.result.current.attachContent(content))
    expect(scroller.scrollTop).toBe(120)
    act(() => before.result.current.jumpToLatest())
    before.unmount()
    const after = renderHook(() => useThreadScroll('refreshing-run'))
    act(() => after.result.current.attachContent(content))
    expect(scroller.scrollTop).toBe(600)
    await act(async () => { refreshed(); await refresh })
    after.unmount()
    scroller.remove()
  })

  it.each([false, true])('jumps to a correlated message without repinning to the tail (virtual: %s)', (virtual) => {
    const { result } = renderHook(() => useThreadScroll('correlation'))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'request-row'
    row.getBoundingClientRect = () => ({ top: -1200 } as DOMRect)
    content.append(row)
    scroller.append(content)
    document.body.append(scroller)
    act(() => result.current.attachContent(content))
    const scrollToIndex = vi.fn()
    if (virtual) result.current.virtualizerRef.current = { scrollToIndex } as never
    act(() => result.current.jumpToRow('request-row', 3))
    if (virtual) expect(scrollToIndex).toHaveBeenCalledWith(3, { align: 'start' })
    else expect(scroller.scrollTop).toBe(400)
    expect(result.current.pillVisible).toBe(true)
    expect(document.activeElement).toBe(row)
    act(() => result.current.restickIfStuck())
    if (!virtual) expect(scroller.scrollTop).toBe(400)
    scroller.remove()
  })

  it('keeps a jumped-to message below sticky header chrome', () => {
    const { result } = renderHook(() => useThreadScroll('sticky'))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } })
    const header = document.createElement('header')
    header.dataset.slot = 'run-header'
    header.style.position = 'sticky'
    header.getBoundingClientRect = () => ({ height: 150 } as DOMRect)
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.rowKey = 'request'
    row.getBoundingClientRect = () => ({ top: -1200 } as DOMRect)
    content.append(row)
    scroller.append(header, content)
    act(() => result.current.attachContent(content))
    act(() => result.current.jumpToRow('request', 0))
    expect(scroller.scrollTop).toBeLessThanOrEqual(250)
  })

  it('waits for an unmeasured virtual row to become focusable', async () => {
    const { result } = renderHook(() => useThreadScroll('unmeasured'))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    const content = document.createElement('div')
    scroller.append(content)
    document.body.append(scroller)
    act(() => result.current.attachContent(content))
    result.current.virtualizerRef.current = { scrollToIndex: () => {} } as never
    act(() => result.current.jumpToRow('request', 0))
    const row = document.createElement('div')
    row.dataset.rowKey = 'request'
    row.style.visibility = 'hidden'
    await act(async () => { content.append(row) })
    expect(document.activeElement).not.toBe(row)
    await act(async () => { row.style.visibility = 'visible' })
    expect(document.activeElement).toBe(row)
    scroller.remove()
  })

  it('does not retain pointer down-intent after a correlation jump near the tail', () => {
    const { result } = renderHook(() => useThreadScroll('pointer-jump'))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.rowKey = 'reply'
    row.getBoundingClientRect = () => ({ top: 1470 } as DOMRect)
    content.append(row)
    scroller.append(content)
    act(() => result.current.attachContent(content))
    scroller.scrollTop = 100
    fireEvent.pointerDown(content)
    act(() => result.current.jumpToRow('reply', 0))
    fireEvent.scroll(scroller)
    act(() => result.current.restickIfStuck())
    expect(scroller.scrollTop).toBe(1570)
  })

  it('exposes an e2e scroll seam that unpins and uses the product offset', () => {
    isCockpitE2e.mockReturnValue(true)
    const Harness = () => {
      const controls = useThreadScroll('r1')
      return (
        <main data-slot="main">
          <div ref={controls.attachContent} />
        </main>
      )
    }
    render(<Harness />)
    const scroller = document.querySelector<HTMLElement>('[data-slot="main"]')!
    Object.defineProperties(scroller, {
      scrollTop: { value: 900, writable: true, configurable: true },
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_300 },
    })
    expect(typeof window.__cezThreadScrollTo).toBe('function')
    act(() => window.__cezThreadScrollTo?.(0))
    expect(scroller.scrollTop).toBe(0)
  })

  it('attaches without a [data-slot=main] ancestor and stays inert', () => {
    const { result } = renderHook(() => useThreadScroll('r1'))
    const el = document.createElement('div')
    // No scroller to find — the controls must not throw, now or on use.
    act(() => result.current.attachContent(el))
    expect(result.current.scrollElRef.current).toBeNull()
    result.current.jumpToLatest()
    result.current.restickIfStuck()
    expect(result.current.pillVisible).toBe(false)
  })

  it('consumes one multi-event wheel gesture even when the page request settles quickly', async () => {
    vi.useFakeTimers()
    const onLoadOlder = vi.fn().mockResolvedValue(undefined)
    const Harness = () => {
      const controls = useThreadScroll('r1', { onLoadOlder })
      return <main data-slot="main"><div ref={controls.attachContent} /></main>
    }
    render(<Harness />)
    const scroller = document.querySelector<HTMLElement>('[data-slot="main"]')!
    Object.defineProperties(scroller, {
      scrollTop: { value: 0, writable: true },
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
    })

    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: -120 })
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: -80 })
      await Promise.resolve()
    })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(181))
    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: -120 })
      await Promise.resolve()
    })
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })

  it('does not re-pin to the live tail after an explicit older-page load', async () => {
    let resize: (() => void) | undefined
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver)
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    let loadOlder: (() => void) | undefined
    const Harness = () => {
      const controls = useThreadScroll('r1', { onLoadOlder })
      loadOlder = controls.loadOlder
      return (
        <main
          ref={(element) => {
            if (element) {
              Object.defineProperties(element, {
                scrollTop: { value: 600, writable: true, configurable: true },
                clientHeight: { value: 400, configurable: true },
                scrollHeight: { value: 1_000, configurable: true },
              })
            }
          }}
          data-slot="main"
        >
          <div ref={controls.attachContent} />
        </main>
      )
    }

    render(<Harness />)
    const scroller = document.querySelector<HTMLElement>('[data-slot="main"]')!
    scroller.scrollTop = 0
    act(() => loadOlder?.())
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveLoad()
      await Promise.resolve()
    })
    act(() => resize?.())

    expect(scroller.scrollTop).toBe(0)
  })

  it('does not restore a history anchor on fetch settlement — only after committed rowKeys', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'turn-seq-2777:user'
    row.getBoundingClientRect = () => ({
      top: 80, bottom: 160, left: 0, right: 800, width: 800, height: 80, x: 0, y: 80, toJSON() {},
    })
    content.append(row)
    scroller.append(content)
    const hook = renderHook(
      ({ rowKeys }: { rowKeys: string[] }) => useThreadScroll('hist-run', { onLoadOlder, rowKeys }),
      { initialProps: { rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    const handle = { scrollTo: vi.fn(), scrollToIndex: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    await act(async () => { resolveLoad(); await Promise.resolve() })
    act(() => { while (frames.length) frames.shift()?.(0) })
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    expect(handle.scrollTo).not.toHaveBeenCalled()

    act(() => hook.rerender({ rowKeys: ['task', 'older', 'turn-seq-2777:user'] }))
    expect(handle.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start', offset: -80 })
    hook.unmount()
    scroller.remove()
  })

  it('does not restore a stale history anchor after a failed older-page load when live rows arrive', async () => {
    let rejectLoad!: (error: Error) => void
    const onLoadOlder = vi.fn(() => new Promise<void>((_, reject) => { rejectLoad = reject }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'turn-seq-2777:user'
    row.getBoundingClientRect = () => ({
      top: 80, bottom: 160, left: 0, right: 800, width: 800, height: 80, x: 0, y: 80, toJSON() {},
    })
    content.append(row)
    scroller.append(content)
    const hook = renderHook(
      ({ rowKeys }: { rowKeys: string[] }) => useThreadScroll('hist-run', { onLoadOlder, rowKeys }),
      { initialProps: { rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    const handle = { scrollTo: vi.fn(), scrollToIndex: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    await act(async () => {
      rejectLoad(new Error('history failed'))
      await Promise.resolve()
    })
    act(() => hook.rerender({ rowKeys: ['task', 'turn-seq-2777:user', 'turn-seq-2778:assistant'] }))
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    expect(handle.scrollTo).not.toHaveBeenCalled()
    hook.unmount()
    scroller.remove()
  })

  it('does not restore a stale history anchor after a no-op older-page load when live rows arrive', async () => {
    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'turn-seq-2777:user'
    row.getBoundingClientRect = () => ({
      top: 80, bottom: 160, left: 0, right: 800, width: 800, height: 80, x: 0, y: 80, toJSON() {},
    })
    content.append(row)
    scroller.append(content)
    const hook = renderHook(
      ({ rowKeys }: { rowKeys: string[] }) => useThreadScroll('hist-run', { onLoadOlder, rowKeys }),
      { initialProps: { rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    const handle = { scrollTo: vi.fn(), scrollToIndex: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    await act(async () => { resolveLoad(); await Promise.resolve() })
    act(() => hook.rerender({ rowKeys: ['task', 'turn-seq-2777:user', 'turn-seq-2778:assistant'] }))
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    expect(handle.scrollTo).not.toHaveBeenCalled()
    hook.unmount()
    scroller.remove()
  })

  it('does not restore a previous task\'s history anchor after navigating away mid-load', async () => {
    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'turn-seq-2777:user'
    row.getBoundingClientRect = () => ({
      top: 80, bottom: 160, left: 0, right: 800, width: 800, height: 80, x: 0, y: 80, toJSON() {},
    })
    content.append(row)
    scroller.append(content)
    const hook = renderHook(
      ({ viewKey, rowKeys }: { viewKey: string; rowKeys: string[] }) =>
        useThreadScroll(viewKey, { onLoadOlder, rowKeys }),
      { initialProps: { viewKey: 'run-a:main', rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    const handle = { scrollTo: vi.fn(), scrollToIndex: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    act(() => hook.rerender({ viewKey: 'run-b:main', rowKeys: ['task', 'other'] }))
    await act(async () => { resolveLoad(); await Promise.resolve() })
    act(() => hook.rerender({ viewKey: 'run-b:main', rowKeys: ['task', 'older', 'turn-seq-2777:user'] }))
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    hook.unmount()
    scroller.remove()
  })

  it('does not restore a history anchor if the reader jumps away before the page commits', async () => {
    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'turn-seq-2777:user'
    row.getBoundingClientRect = () => ({
      top: 80, bottom: 160, left: 0, right: 800, width: 800, height: 80, x: 0, y: 80, toJSON() {},
    })
    content.append(row)
    scroller.append(content)
    const hook = renderHook(
      ({ rowKeys }: { rowKeys: string[] }) => useThreadScroll('hist-run', { onLoadOlder, rowKeys }),
      { initialProps: { rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    const handle = { scrollTo: vi.fn(), scrollToIndex: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    await act(async () => { resolveLoad(); await Promise.resolve() })
    act(() => hook.result.current.jumpToLatest())
    handle.scrollToIndex.mockClear()
    act(() => hook.rerender({ rowKeys: ['task', 'older', 'turn-seq-2777:user'] }))
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    hook.unmount()
    scroller.remove()
  })

  it('does not restore a history anchor after navigating away and back to the same task mid-load', async () => {
    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'turn-seq-2777:user'
    row.getBoundingClientRect = () => ({
      top: 80, bottom: 160, left: 0, right: 800, width: 800, height: 80, x: 0, y: 80, toJSON() {},
    })
    content.append(row)
    scroller.append(content)
    const hook = renderHook(
      ({ viewKey, rowKeys }: { viewKey: string; rowKeys: string[] }) =>
        useThreadScroll(viewKey, { onLoadOlder, rowKeys }),
      { initialProps: { viewKey: 'run-a:main', rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    const handle = { scrollTo: vi.fn(), scrollToIndex: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    act(() => hook.rerender({ viewKey: 'run-b:main', rowKeys: ['task', 'other'] }))
    act(() => hook.rerender({ viewKey: 'run-a:main', rowKeys: ['task', 'turn-seq-2777:user'] }))
    await act(async () => { resolveLoad(); await Promise.resolve() })
    handle.scrollToIndex.mockClear()
    act(() => hook.rerender({ viewKey: 'run-a:main', rowKeys: ['task', 'older', 'turn-seq-2777:user'] }))
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    hook.unmount()
    scroller.remove()
  })

  it('does not restore a history anchor if the reader moves toward the tail before the fetch settles', async () => {
    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.slot = 'thread-row'
    row.dataset.rowKey = 'turn-seq-2777:user'
    row.getBoundingClientRect = () => ({
      top: 80, bottom: 160, left: 0, right: 800, width: 800, height: 80, x: 0, y: 80, toJSON() {},
    })
    content.append(row)
    scroller.append(content)
    const hook = renderHook(
      ({ rowKeys }: { rowKeys: string[] }) => useThreadScroll('hist-run', { onLoadOlder, rowKeys }),
      { initialProps: { rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    const handle = { scrollTo: vi.fn(), scrollToIndex: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    act(() => { fireEvent.wheel(scroller, { deltaY: 120 }) })
    await act(async () => { resolveLoad(); await Promise.resolve() })
    handle.scrollToIndex.mockClear()
    act(() => hook.rerender({ rowKeys: ['task', 'older', 'turn-seq-2777:user'] }))
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    hook.unmount()
    scroller.remove()
  })

  it('releases the older-page lock when a superseded in-flight request settles', async () => {
    let resolveLoad!: () => void
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {},
    })
    const content = document.createElement('div')
    scroller.append(content)
    const hook = renderHook(
      ({ rowKeys }: { rowKeys: string[] }) => useThreadScroll('hist-run', { onLoadOlder, rowKeys }),
      { initialProps: { rowKeys: ['task', 'turn-seq-2777:user'] } },
    )
    act(() => hook.result.current.attachContent(content))
    scroller.scrollTop = 80

    act(() => hook.result.current.loadOlder())
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    act(() => { fireEvent.wheel(scroller, { deltaY: 120 }) })
    await act(async () => { resolveLoad(); await Promise.resolve() })
    act(() => hook.result.current.loadOlder())
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
    hook.unmount()
    scroller.remove()
  })
})

describe('useThreadScroll — jump to latest', () => {
  function attachScroller(options: Parameters<typeof useThreadScroll>[1] = {}) {
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    const content = document.createElement('div')
    scroller.append(content)
    const hook = renderHook(() => useThreadScroll('jump-run', options))
    act(() => hook.result.current.attachContent(content))
    scroller.scrollTop = 80
    return { scroller, scrollTo, hook }
  }

  it('pins the viewport through the programmatic offset path, not native smooth scroll', async () => {
    const { scroller, scrollTo, hook } = attachScroller()

    await act(async () => {
      hook.result.current.jumpToLatest()
      await Promise.resolve()
    })

    expect(scrollTo).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(600)
    hook.unmount()
    scroller.remove()
  })

  it('re-pins after the refreshed tail grows past the first animation frame', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const { scroller, hook } = attachScroller({ onJumpToLatest: () => Promise.resolve() })

    act(() => { hook.result.current.jumpToLatest() })
    await act(async () => { await Promise.resolve() })
    expect(frames).toHaveLength(1)

    act(() => { frames.shift()?.(0) })
    expect(scroller.scrollTop).toBe(600)

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2_400 })
    expect(frames).toHaveLength(1)
    act(() => { frames.shift()?.(0) })
    expect(scroller.scrollTop).toBe(2_000)

    hook.unmount()
    scroller.remove()
  })

  it('does not steal a restored offset when the row list changes', () => {
    saveThreadScroll('jump-run', { top: 220, atBottom: false })
    const scroller = document.createElement('main')
    scroller.dataset.slot = 'main'
    Object.defineProperties(scroller, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
    })
    const content = document.createElement('div')
    scroller.append(content)
    const hook = renderHook(
      ({ rowKeys }: { rowKeys: string[] }) => useThreadScroll('jump-run', { rowKeys }),
      { initialProps: { rowKeys: ['older', 'mid'] } },
    )
    act(() => hook.result.current.attachContent(content))
    expect(scroller.scrollTop).toBe(220)

    act(() => hook.rerender({ rowKeys: ['older', 'mid', 'live'] }))
    expect(scroller.scrollTop).toBe(220)
    hook.unmount()
  })

  it('pins through virtua\'s handle when the thread is virtualized', async () => {
    const { scroller, scrollTo, hook } = attachScroller()
    const handle = { scrollTo: vi.fn() }
    hook.result.current.virtualizerRef.current = handle as never

    await act(async () => {
      hook.result.current.jumpToLatest()
      await Promise.resolve()
    })

    expect(scrollTo).not.toHaveBeenCalled()
    expect(handle.scrollTo).toHaveBeenCalledWith(600)
    hook.unmount()
    scroller.remove()
  })
})

describe('JumpToLatestPill', () => {
  it('keeps a ≥44px target', () => {
    render(<JumpToLatestPill onJump={() => {}} />)
    expect(document.querySelector('[data-slot="jump-to-latest"]')!.className).toContain('min-h-11')
  })
})

describe('useThreadScroll — route arrival (#761)', () => {
  function ArrivalHarness({ viewKey }: { viewKey: string }) {
    const controls = useThreadScroll(viewKey)
    return (
      <main
        ref={(element) => {
          if (element) {
            Object.defineProperties(element, {
              scrollTop: { value: element.scrollTop, writable: true, configurable: true },
              clientHeight: { value: 500, configurable: true },
              scrollHeight: { value: 2_000, configurable: true },
            })
          }
        }}
        data-slot="main"
      >
        <div ref={controls.attachContent} />
      </main>
    )
  }

  it('restores an away-from-tail destination before passive effects observe it', () => {
    saveThreadScroll('run-a:main', { top: 640, atBottom: false })

    render(<ArrivalHarness viewKey="run-a:main" />)

    expect((document.querySelector('[data-slot="main"]') as HTMLElement).scrollTop).toBe(640)
  })

  it('lands a live-tail destination at the bottom before passive effects observe it', () => {
    saveThreadScroll('run-b:main', { top: 120, atBottom: true })

    render(<ArrivalHarness viewKey="run-b:main" />)

    expect((document.querySelector('[data-slot="main"]') as HTMLElement).scrollTop).toBe(1_500)
  })

  it('re-applies the destination owner when the task id changes in place', () => {
    saveThreadScroll('run-a:main', { top: 640, atBottom: false })
    saveThreadScroll('run-b:main', { top: 920, atBottom: false })
    const view = render(<ArrivalHarness viewKey="run-a:main" />)

    view.rerender(<ArrivalHarness viewKey="run-b:main" />)

    expect((document.querySelector('[data-slot="main"]') as HTMLElement).scrollTop).toBe(920)
  })
})
