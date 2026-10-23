import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { RetainedVariantsRoute } from './compare-variants'

const runs = ['A', 'B'].map(variant => ({
  id: `run-${variant}`, variant, title: `Improve notes (${variant})`, status: 'done',
  archived: variant === 'B', tokensUsed: 0, diffStat: '', handoffExcerpt: '',
}))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup(response = () => json({ groupId: 'old-group', runs })) {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).includes('/groups/') ? response() : json([]))
  vi.stubGlobal('fetch', fetch)
  render(<QueryClientProvider client={createQueryClient()}>
    <MemoryRouter initialEntries={['/compare/old-group']}><Routes>
      <Route path="/compare/:groupId" element={<RetainedVariantsRoute />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>)
  return fetch
}

describe('old comparison links', () => {
  it('opens retained tasks, including archived results, with migration guidance and no pick action', async () => {
    const fetch = setup()
    expect(await screen.findByRole('heading', { name: 'Retained results' })).toBeTruthy()
    expect(screen.getByText(/collect their results and compare their diffs/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open task A' }).getAttribute('href')).toBe('/tasks/run-A')
    expect(screen.getByRole('link', { name: 'Open task B' }).getAttribute('href')).toBe('/tasks/run-B')
    expect(screen.getByText(/archived/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /pick/i })).toBeNull()
    expect(document.querySelector('[data-slot="compare-columns"]')).toBeNull()
    expect(fetch.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method || (init as RequestInit).method === 'GET')).toBe(true)
  })

  it('shows an actionable migration page when a group is no longer retained', async () => {
    setup(() => json({ error: 'not found' }, 404))
    expect(await screen.findByRole('heading', { name: 'No retained results for this group' })).toBeTruthy()
    expect(screen.getByText(/Open Tasks to find individual results/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/')
  })

  it('retries a failed historical read on the same URL', async () => {
    let failing = true
    setup(() => failing ? json({ error: 'Offline' }, 503) : json({ groupId: 'old-group', runs }))
    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 })
    failing = false
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByRole('link', { name: 'Open task A' })).toBeTruthy())
  })

  it('has a loading state without offering winner selection', () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/compare/old-group']}>
      <Routes><Route path="/compare/:groupId" element={<RetainedVariantsRoute />} /></Routes>
    </MemoryRouter></QueryClientProvider>)
    expect(screen.getByText('Loading retained results…')).toBeTruthy()
  })
})
