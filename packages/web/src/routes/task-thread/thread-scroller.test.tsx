import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearThreadScrollCaches, saveThreadScroll } from './thread-scroll'
import { JumpToLatestPill, ThreadRows, useThreadScroll, type ThreadRow } from './thread-scroller'

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
  vi.useRealTimers()
  cleanup()
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
