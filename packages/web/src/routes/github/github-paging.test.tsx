import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LOAD_AHEAD_PX, resolveListScrollOwner, useLoadMoreSentinel } from './github-paging'

/** jsdom has no IntersectionObserver; this one records each observer's root, margin and target
 *  and lets a test say "the sentinel scrolled into view". */
let observers: { target: Element | null; root: Element | null; rootMargin?: string | undefined; fire: (visible: boolean) => void }[]
beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void, opts: { root?: Element | null | undefined; rootMargin?: string | undefined }) {
      const record = { target: null as Element | null, root: opts.root ?? null, rootMargin: opts.rootMargin, fire: (v: boolean) => cb([{ isIntersecting: v }]) }
      observers.push(record)
      this.observe = (el: Element) => { record.target = el }
      this.disconnect = () => { record.target = null }
    }
    observe: (el: Element) => void
    disconnect: () => void
    unobserve() {}
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const live = () => observers.filter((o) => o.target !== null)

describe('resolveListScrollOwner', () => {
  it('is the list when it scrolls itself, else the shell main, else the list', () => {
    const main = document.createElement('main')
    main.dataset.slot = 'main'
    const list = document.createElement('section')
    main.append(list)
    document.body.append(main)
    expect(resolveListScrollOwner(list)).toBe(main)
    list.style.overflowY = 'auto'
    expect(resolveListScrollOwner(list)).toBe(list)
    list.style.overflowY = 'scroll'
    expect(resolveListScrollOwner(list)).toBe(list)
    const loose = document.createElement('section')
    document.body.append(loose)
    expect(resolveListScrollOwner(loose)).toBe(loose)
    main.remove()
    loose.remove()
  })
})

function Probe({ enabled, root, loadMore }: { enabled: boolean; root: HTMLElement | null; loadMore: () => void }) {
  const ref = useLoadMoreSentinel(enabled, root, loadMore)
  return <div ref={ref} data-testid="sentinel" />
}

describe('useLoadMoreSentinel', () => {
  it('observes against gh-list when it scrolls, and the viewport when main scrolls', () => {
    const list = document.createElement('section')
    list.dataset.slot = 'gh-list'
    const main = document.createElement('main')
    main.dataset.slot = 'main'
    const { rerender, getByTestId } = render(<Probe enabled root={list} loadMore={() => {}} />)
    expect(live()).toHaveLength(1)
    expect(live()[0]).toMatchObject({ root: list, rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px`, target: getByTestId('sentinel') })
    rerender(<Probe enabled root={main} loadMore={() => {}} />)
    expect(live()).toHaveLength(1)
    expect(live()[0]!.root).toBeNull()
  })

  it('loads only on an intersection and never while disabled', () => {
    const list = document.createElement('section')
    const loadMore = vi.fn()
    const { rerender } = render(<Probe enabled root={list} loadMore={loadMore} />)
    act(() => live()[0]!.fire(false))
    expect(loadMore).not.toHaveBeenCalled()
    act(() => live()[0]!.fire(true))
    expect(loadMore).toHaveBeenCalledTimes(1)
    rerender(<Probe enabled={false} root={list} loadMore={loadMore} />)
    expect(live()).toHaveLength(0)
    rerender(<Probe enabled root={null} loadMore={loadMore} />)
    expect(live()).toHaveLength(0)
  })
})
