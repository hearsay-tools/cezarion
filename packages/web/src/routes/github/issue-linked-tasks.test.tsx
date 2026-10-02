import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { IssueLinkedTasks } from './issue-linked-tasks'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('reads only the active project’s runs and links back to that project', async () => {
  const client = createQueryClient()
  client.setQueryData(['default', 'runs', 'list'], [{ id: 'wrong-project', issueNumber: 750 }])
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== '/api/v1/p/second/runs') throw new Error(`Unexpected request: ${String(input)}`)
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
  expect((await screen.findByRole('link', { name: /Diagnose navigation/ })).getAttribute('href'))
    .toBe('/p/second/tasks/diagnosis')
  expect(screen.queryByText('wrong-project')).toBeNull()
})
