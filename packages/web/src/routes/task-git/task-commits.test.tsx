import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, ChangesPayload, RunCommitsResponse } from '@open-mercato/cezar-api-client'

import { TaskCommitsRoute } from './task-commits'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const RUN: ApiRun = {
  id: 'r1',
  title: 'Do the thing',
  workflow: 'quick-task',
  task: 'Do the thing.',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' }],
}

const COMMITS: RunCommitsResponse = {
  commits: [
    { sha: 'a'.repeat(40), subject: 'Add the notes', author: 'Agent', when: '2 hours ago' },
    { sha: 'b'.repeat(40), subject: 'Start the task', author: 'Agent', when: '3 hours ago' },
  ],
}

const CHANGES: ChangesPayload = {
  files: [{ path: 'notes.md', status: 'added', adds: 1, dels: 0, binary: false, patch: '' }],
  stat: { adds: 1, dels: 0, files: 1 },
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function renderCommits(run: ApiRun, commits: RunCommitsResponse) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace('?archived=recent', '')
    if (path === '/api/v1/runs/r1') return json(run)
    if (path === '/api/v1/runs/r1/commits') return json(commits)
    if (path === '/api/v1/runs/r1/changes') return json(CHANGES)
    if (path === '/api/v1/run-summaries') return json([])
    return json({})
  }))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1/commits']}>
        <Routes>
          <Route path="/tasks/:id/commits" element={<TaskCommitsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the Commits tab route', () => {
  it('lists the task commits, each linking to its diff, and the files they changed', async () => {
    renderCommits(RUN, COMMITS)
    await waitFor(() => expect(screen.getByRole('heading', { name: '2 commits in this task' })).toBeTruthy())
    const links = [...document.querySelectorAll('[data-slot="task-commits"] a')].map((a) => a.getAttribute('href'))
    expect(links).toEqual([`/tasks/r1/commits/${'a'.repeat(40)}`, `/tasks/r1/commits/${'b'.repeat(40)}`])
    await waitFor(() => expect(screen.getByRole('heading', { name: '1 changed files' })).toBeTruthy())
  })

  // A usage-limit hold has no session, so the engine does not own it (`engineOwnsRun`): the tab
  // reads it like any parked run.
  it('lists the commits of a usage-limit hold', async () => {
    renderCommits({ ...RUN, status: 'waiting', autoResumeAt: '2026-07-15T10:00:00.000Z' }, COMMITS)
    await waitFor(() => expect(screen.getByRole('heading', { name: '2 commits in this task' })).toBeTruthy())
  })

  it('says so when the task has not committed yet', async () => {
    renderCommits(RUN, { commits: [] })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'No commits yet' })).toBeTruthy())
  })
})
