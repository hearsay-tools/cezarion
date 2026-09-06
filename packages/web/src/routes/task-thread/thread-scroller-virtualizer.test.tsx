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

  it('enables reverse-infinite scroll compensation for older pages', () => {
    const controls = renderHook(() => useThreadScroll('r1')).result.current

    render(
      <main data-slot="main">
        <ThreadRows runId="r1" rows={rows(400)} mode="virtual" controls={controls} />
      </main>,
    )

    expect(virtualizerProbe.props?.shift).toBe(true)
  })
})
