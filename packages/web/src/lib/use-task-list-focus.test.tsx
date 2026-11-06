import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useTaskListFocusState } from './use-task-list-focus'

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
