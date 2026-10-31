import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { Counterpart, type CounterpartView } from './counterpart-task'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('@/api/queries', () => ({ useRun: lookup }))
afterEach(() => { cleanup(); lookup.mockReset() })

function nameTask({ title, linkable }: CounterpartView) {
  return linkable ? <a href="/task/other">{title}</a> : <span>{title}</span>
}

it.each([false, true])('uses a known title without a lookup for peer=%s', (peer) => {
  render(<Counterpart id="other" peer={peer} taskTitles={{ other: 'Known task' }}>{nameTask}</Counterpart>)
  expect(screen.getByRole('link').textContent).toBe('Known task')
  expect(lookup).not.toHaveBeenCalled()
})

it('links an unnamed parent without a peer lookup', () => {
  render(<Counterpart id="other" peer={false}>{nameTask}</Counterpart>)
  expect(screen.getByRole('link').textContent).toBe('Task')
  expect(lookup).not.toHaveBeenCalled()
})

it('links a peer after its title arrives', () => {
  lookup.mockReturnValue({ isPending: true })
  const { rerender } = render(<Counterpart id="other" peer>{nameTask}</Counterpart>)
  expect(screen.getByText('Peer task')).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
  expect(lookup).toHaveBeenCalledWith('other')
  lookup.mockReturnValue({ data: { title: 'Original', titleSummary: 'Resolved peer', titleOrigin: 'user' } })
  rerender(<Counterpart id="other" peer>{nameTask}</Counterpart>)
  expect(screen.getByRole('link').textContent).toBe('Resolved peer')
})

it.each([
  [new ApiError(404, 'gone'), 'Deleted task'],
  [new ApiError(503, 'offline'), 'Task unavailable'],
  [new Error('failure'), 'Task unavailable'],
])('does not link a failed lookup (%s)', (error, title) => {
  lookup.mockReturnValue({ isPending: false, error })
  render(<Counterpart id="other" peer>{nameTask}</Counterpart>)
  expect(screen.getByText(title)).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
})
