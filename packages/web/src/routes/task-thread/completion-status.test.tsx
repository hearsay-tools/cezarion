import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { archiveInComposer } from './run-actions'
import { CompletionStatus } from './completion-status'

const run: ApiRun = {
  id: 'run', title: 'Ship', task: 'Ship', status: 'done', workflow: 'quick-task', createdAt: '', steps: [], tokensUsed: 0, archived: false,
  autoMergePr: true, completionAction: { id: '00000000-0000-4000-8000-000000000001', phase: 'pending' },
}
const mount = (record: ApiRun) => render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><CompletionStatus run={record} /></MemoryRouter></QueryClientProvider>)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['pending', 'blocked'] as const)('exposes the %s reason as a polite status with a safe PR link', phase => {
  mount({ ...run, pullRequestUrl: 'https://github.com/owner/repo/pull/42', completionAction: { ...run.completionAction!, phase, message: 'Waiting for the current head.' } })
  const status = screen.getByRole('status')
  expect(status.getAttribute('aria-live')).toBe('polite')
  expect(status.getAttribute('aria-atomic')).toBe('true')
  expect(status.textContent).toContain(`Completion ${phase}`)
  expect(status.textContent).toContain('Waiting for the current head.')
  const link = screen.getByRole('link', { name: 'Open PR' })
  expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/pull/42')
  expect(link.getAttribute('rel')).toContain('noopener')
})

it('disables auto-merge through PATCH and invalidates run queries', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  mount(run)
  fireEvent.click(screen.getByRole('button', { name: 'Disable auto-merge' }))
  await waitFor(() => expect(fetch).toHaveBeenCalled())
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ autoMergePr: false })
})

it('keeps a useful fallback for missing reasons and omits unsafe PR URLs', () => {
  mount({ ...run, pullRequestUrl: 'javascript:0' })
  expect(screen.getByRole('status').textContent).toContain('Checking completion actions.')
  expect(screen.queryByRole('link')).toBeNull()
})

it.each([undefined, { ...run.completionAction!, phase: 'complete' as const }])('omits absent or finished completion work', completionAction => {
  mount({ ...run, completionAction })
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows the shared archive blocker with scoped task, PR and manual Archive actions', () => {
  const record = { ...run, completionAction: undefined, archiveBlocker: {
    message: 'A worker still has an open PR.', runId: 'worker', pullRequestUrl: 'https://github.com/owner/repo/pull/43',
  } }
  render(<QueryClientProvider client={createQueryClient()}><ProjectScopeProvider projectId="project"><MemoryRouter><CompletionStatus run={record} /></MemoryRouter></ProjectScopeProvider></QueryClientProvider>)
  expect(screen.getByRole('status').textContent).toContain('A worker still has an open PR.')
  expect(screen.getByRole('link', { name: 'Open blocking task' }).getAttribute('href')).toBe('/p/project/tasks/worker')
  expect(screen.getByRole('link', { name: 'Open blocking PR' }).getAttribute('href')).toBe('https://github.com/owner/repo/pull/43')
  expect(screen.getByRole('button', { name: 'Archive task' })).toBeTruthy()
  expect(archiveInComposer(record)).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Archive task' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('Archive task?')
})
