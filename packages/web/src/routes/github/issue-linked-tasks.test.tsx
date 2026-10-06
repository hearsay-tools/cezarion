import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { summaryOf } from '@/test/run-summary-fixture'
import { IssueLinkedTasks } from './issue-linked-tasks'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('reads only the active project’s runs and links back to that project', async () => {
  const client = createQueryClient()
  client.setQueryData(['default', 'runs', 'list'], [{ id: 'wrong-project', issueNumber: 750 }])
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).replace('?archived=recent', '') !== '/api/v1/p/second/run-summaries') throw new Error(`Unexpected request: ${String(input).replace('?archived=recent', '')}`)
    return new Response(JSON.stringify([{
      id: 'diagnosis', title: 'Diagnose navigation', task: 'Diagnose navigation',
      issueNumber: 750, workflow: 'quick-task', status: 'done', archived: true,
      createdAt: '2026-10-01T12:00:00Z', tokensUsed: 0, steps: [],
    }]), { headers: { 'content-type': 'application/json' } })
  }))
  render(
    <ProjectScopeProvider projectId="second">
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/second/github/issues/750']}>
          <IssueLinkedTasks number={750} repo="acme/demo" />
        </MemoryRouter>
      </QueryClientProvider>
    </ProjectScopeProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Linked tasks (1)' }))
  expect((await screen.findByRole('link', { name: /Diagnose navigation/ })).getAttribute('href'))
    .toBe('/p/second/tasks/diagnosis')
  expect(screen.queryByText('wrong-project')).toBeNull()
})


it.each(['issue', 'repo', 'project'] as const)('collapses on %s identity changes, including returning to an earlier identity', async (identity) => {
  const client = createQueryClient()
  client.setQueryData(['first', 'runs', 'list'], [])
  client.setQueryData(['second', 'runs', 'list'], [])
  const tree = (changed: boolean) => (
    <ProjectScopeProvider projectId={changed && identity === 'project' ? 'second' : 'first'}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IssueLinkedTasks number={changed && identity === 'issue' ? 788 : 787} repo={changed && identity === 'repo' ? 'other/repo' : 'acme/demo'} />
        </MemoryRouter>
      </QueryClientProvider>
    </ProjectScopeProvider>
  )
  const view = render(tree(false))
  const toggle = () => screen.getByRole('button', { name: 'Linked tasks (0)' })
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('No linked tasks yet.')).toBeNull()
  fireEvent.click(toggle())
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('No linked tasks yet.')).toBeTruthy()
  view.rerender(tree(true))
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  view.rerender(tree(false))
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
})

it('keeps collapsed counts live and shows an empty state when only workers match', async () => {
  const client = createQueryClient()
  const worker = { id: 'worker', issueNumber: 787, delegation: { role: 'worker' } }
  client.setQueryData(['default', 'runs', 'list'], [worker])
  render(<QueryClientProvider client={client}><MemoryRouter><IssueLinkedTasks number={787} /></MemoryRouter></QueryClientProvider>)
  const toggle = screen.getByRole('button', { name: 'Linked tasks (0)' })
  expect(screen.queryByText('No linked tasks yet.')).toBeNull()
  fireEvent.click(toggle)
  expect(screen.getByText('No linked tasks yet.')).toBeTruthy()
  fireEvent.click(toggle)
  const parent = { id: 'parent', title: 'Parent task', task: 'Parent task', issueNumber: 787, status: 'done', createdAt: '2026-10-01T12:00:00Z', archived: true }
  act(() => client.setQueryData(['default', 'runs', 'list'], [worker, parent]))
  const updated = await screen.findByRole('button', { name: 'Linked tasks (1)' })
  expect(updated.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('link')).toBeNull()
  fireEvent.click(updated)
  expect(screen.getByRole('link', { name: /Parent task/ }).textContent).toContain('Archived')
  expect(document.getElementById(updated.getAttribute('aria-controls')!)?.contains(screen.getByRole('link'))).toBe(true)
})

it('finds a linked task older than the run list\'s archived window (#864)', async () => {
  const client = createQueryClient()
  const archived = summaryOf({
    id: 'old-diagnosis', title: 'Old diagnosis', task: 'Old diagnosis', issueNumber: 750, workflow: 'quick-task',
    status: 'done', archived: true, createdAt: '2025-01-01T12:00:00Z', tokensUsed: 0, steps: [],
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url === '/api/v1/p/second/run-summaries?archived=recent'
      ? []
      : url === '/api/v1/p/second/run-summaries/archived?limit=200&q=%23750'
        ? { runs: [archived], nextCursor: null, total: 1 }
        : undefined
    if (body === undefined) throw new Error(`Unexpected request: ${url}`)
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }))
  render(
    <ProjectScopeProvider projectId="second">
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/second/github/issues/750']}>
          <IssueLinkedTasks number={750} repo="acme/demo" />
        </MemoryRouter>
      </QueryClientProvider>
    </ProjectScopeProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Linked tasks (1)' }))
  expect((await screen.findByRole('link', { name: /Old diagnosis/ })).getAttribute('href')).toBe('/p/second/tasks/old-diagnosis')
})
