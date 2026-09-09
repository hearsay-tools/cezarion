import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const virtualizerProbe = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}))

vi.mock('virtua', async () => {
  const React = await vi.importActual<typeof import('react')>('react')

  const Virtualizer = React.forwardRef((props: Record<string, unknown>, ref) => {
    virtualizerProbe.props = props
    React.useImperativeHandle(ref, () => ({
      cache: {} as never,
      scrollOffset: 0,
      scrollSize: 0,
      viewportSize: 0,
      findItemIndex: () => 0,
      getItemOffset: () => 0,
      getItemSize: () => 0,
      scrollToIndex: () => {},
      scrollTo: () => {},
      scrollBy: () => {},
    }), [])
    return React.createElement('div', null, props.children as React.ReactNode)
  })

  return { Virtualizer }
})

import { ThreadRows, useThreadScroll, type ThreadRow } from './thread-scroller'

afterEach(() => cleanup())

const rows = (count: number): ThreadRow[] =>
  Array.from({ length: count }, (_, index) => ({ key: `row-${index}`, node: <p>row {index}</p> }))

describe('virtualized history prepend', () => {
  beforeEach(() => {
    virtualizerProbe.props = undefined
  })

  it('shifts measurements for history prepends, but not live appends', () => {
    const controls = renderHook(() => useThreadScroll('r1')).result.current

    const initial = rows(400)
    const tree = (items: ThreadRow[]) => (
      <main data-slot="main">
        <ThreadRows runId="r1" rows={items} mode="virtual" controls={controls} />
      </main>
    )
    const view = render(tree(initial))

    expect(virtualizerProbe.props?.shift).toBe(false)
    const older = [{ key: 'older', node: <p>older page</p> }, ...initial]
    view.rerender(tree(older))
    expect(virtualizerProbe.props?.shift).toBe(true)
    view.rerender(tree([...older, { key: 'new', node: <p>live tool</p> }]))
    expect(virtualizerProbe.props?.shift).toBe(false)
    // Removing from the end is ordinary forward sizing; evicting an older page shifts.
    view.rerender(tree(older))
    expect(virtualizerProbe.props?.shift).toBe(false)
    view.rerender(tree(initial))
    expect(virtualizerProbe.props?.shift).toBe(true)
    // History can arrive after a stable task prompt: this is a middle insertion,
    // so the prefix must keep its measured size rather than shifting the whole cache.
    view.rerender(tree([initial[0]!, { key: 'middle', node: <p>older page</p> }, ...initial.slice(1)]))
    expect(virtualizerProbe.props?.shift).toBe(false)
    view.rerender(tree([{ key: 'replacement', node: <p>different transcript</p> }]))
    expect(virtualizerProbe.props?.shift).toBe(false)
  })
})
