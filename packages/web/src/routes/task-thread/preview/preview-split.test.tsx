import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PreviewSplit } from './preview-split'
import { usePreviewPaneState } from './preview-state'

function PendingRunSplit() {
  const state = usePreviewPaneState()
  return (
    <PreviewSplit run={undefined} state={state}>
      <button type="button" onClick={() => state.openPane({})}>Open preview</button>
      <p>Task transcript</p>
    </PreviewSplit>
  )
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** jsdom has no layout: provide the scrolling shell's measured height. */
function scrollingShell(height: () => number): HTMLElement {
  const main = document.createElement('main')
  main.dataset.slot = 'main'
  Object.defineProperty(main, 'clientHeight', { get: height })
  document.body.append(main)
  return main
}

describe('PreviewSplit scrolling shell', () => {
  it('measures the shell, follows its resizes and stops observing on unmount', () => {
    let height = 640
    const main = scrollingShell(() => height)
    const observe = vi.fn()
    const disconnect = vi.fn()
    let resize = () => undefined as void
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe = observe
      disconnect = disconnect
    })
    const view = render(<PendingRunSplit />, { container: main })
    const split = main.querySelector<HTMLElement>('[data-slot="task-split"]')!
    expect(split.style.getPropertyValue('--preview-h')).toBe('640px')
    expect(observe).toHaveBeenCalledExactlyOnceWith(main)
    height = 480
    act(() => resize())
    expect(split.style.getPropertyValue('--preview-h')).toBe('480px')
    height = 0
    act(() => resize())
    expect(split.style.getPropertyValue('--preview-h')).toBe('')
    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('still measures the shell when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const main = scrollingShell(() => 720)
    render(<PendingRunSplit />, { container: main })
    expect(main.querySelector<HTMLElement>('[data-slot="task-split"]')?.style.getPropertyValue('--preview-h')).toBe('720px')
    expect(screen.getByText('Task transcript')).toBeTruthy()
  })

  it('renders without a scrolling shell and does not create an observer', () => {
    const observer = vi.fn()
    vi.stubGlobal('ResizeObserver', observer)
    const { container } = render(<PendingRunSplit />)
    expect(container.querySelector<HTMLElement>('[data-slot="task-split"]')?.style.getPropertyValue('--preview-h')).toBe('')
    expect(observer).not.toHaveBeenCalled()
    expect(screen.getByText('Task transcript')).toBeTruthy()
  })

  it('keeps the transcript visible when the pane opens before the run loads', () => {
    render(<PendingRunSplit />)
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    expect(screen.getByText('Task transcript').closest('[data-slot="task-main"]')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('[data-slot="task-split"]')?.getAttribute('data-pane')).toBe('closed')
    expect(screen.queryByRole('separator')).toBeNull()
    expect(document.querySelector('[data-slot="preview-pane"]')).toBeNull()
  })
})
