import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTaskListFocus, useTaskListFocusState } from './use-task-list-focus'

afterEach(cleanup)
function List({ group, layout = 'summary' }: { group: string; layout?: string }) {
  const focus = useTaskListFocusState(layout, group)
  return <div {...focus.props}>
    <div data-run-id="same" data-project="first"><button data-task-control="resources">First</button></div>
    <div key={`${group}/${layout}`} data-run-id="same" data-project="second"><button data-task-control="resources">Second</button></div>
  </div>
}
it('restores the focused control after its run moves group without a layout change', () => {
  const view = render(<List group="working" />)
  const before = view.getByText('Second')
  act(() => before.focus())
  view.rerender(<List group="finished" />)
  expect(before.isConnected).toBe(false)
  expect(document.activeElement).toBe(view.getByText('Second'))
})
it('includes the project in identity when equal run ids remount on a layout change', () => {
  const view = render(<List group="working" />)
  act(() => view.getByText('Second').focus())
  view.rerender(<List group="working" layout="cards" />)
  expect(document.activeElement).toBe(view.getByText('Second'))
})

it('retries when a mounted virtual control becomes focusable after measurement', async () => {
  const nativeFocus = HTMLElement.prototype.focus
  const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
    if (this.style.visibility !== 'hidden') nativeFocus.call(this, options)
  })
  function Deferred({ layout, hidden = false }: { layout: string; hidden?: boolean }) {
    const state = useTaskListFocusState(layout, 'same')
    return <div {...state.props}><div key={layout} data-run-id="run"><button style={{ visibility: hidden ? 'hidden' : 'visible' }}>Target</button></div></div>
  }
  try {
    const view = render(<Deferred layout="desktop" />)
    act(() => view.getByRole('button').focus())
    view.rerender(<Deferred layout="phone" hidden />)
    expect(document.activeElement).toBe(document.body)
    view.rerender(<Deferred layout="phone" />)
    await act(async () => {})
    expect(document.activeElement).toBe(view.getByRole('button'))
  } finally { focus.mockRestore() }
})

function PendingList({ layout, members = ['run'], show = true, revision = 0 }: { layout: string; members?: string[]; show?: boolean; revision?: number }) {
  const focus = useTaskListFocus(layout, revision, undefined, key => members.includes(key))
  return <div data-testid="boundary" {...focus}>{show && <div key={layout} data-run-id="run"><button>Pending target</button></div>}<span data-testid="unrelated" /></div>
}
it('clears an absent run and stops scanning on unrelated style changes and later revisions', async () => {
  const view = render(<PendingList layout="desktop" />)
  act(() => view.getByRole('button').focus())
  view.rerender(<PendingList layout="phone" members={[]} show={false} />)
  const scan = vi.spyOn(view.getByTestId('boundary'), 'querySelectorAll')
  for (let revision = 1; revision <= 3; revision++) {
    view.rerender(<PendingList layout="phone" members={[]} show={false} revision={revision} />)
    view.getByTestId('unrelated').style.height = `${revision}px`
    await act(async () => {})
  }
  expect(scan).not.toHaveBeenCalled()
  view.rerender(<PendingList layout="phone" />)
  await act(async () => {})
  expect(document.activeElement).toBe(document.body)
})
it('cancels a pending restore on an empty-space pointer press before matching rows mount', async () => {
  const view = render(<PendingList layout="desktop" />)
  act(() => view.getByRole('button').focus())
  view.rerender(<PendingList layout="phone" show={false} />)
  fireEvent.pointerDown(document.body)
  view.rerender(<PendingList layout="phone" />)
  await act(async () => {})
  expect(document.activeElement).toBe(document.body)
})
