import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'
import { InboxRoute } from './inbox'
afterEach(cleanup)
it('explains retained-file export and links to ordinary task creation without a queue', () => {
  render(<MemoryRouter><InboxRoute /></MemoryRouter>)
  expect(screen.getByRole('heading', { name: 'Inbox has been removed' })).toBeTruthy()
  expect(screen.getByText('cp .ai/cezar/todos.json ./cezar-followups-export.json')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'New task' }).getAttribute('href')).toBe('/new')
  expect(screen.queryByRole('button')).toBeNull()
})
