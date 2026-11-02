import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { ReportsRoute } from './reports'

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), removed: false, failed: false }))
const queryKey = ['test', 'reports', 'deep']
vi.mock('@/api/reports', () => ({
  useReports: () => useInfiniteQuery({
    queryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      fixture.fetch(pageParam)
      if (pageParam === 1 && fixture.failed) throw new Error('Next page unavailable')
      const reports = pageParam === 0 ? Array.from({ length: 50 }, (_, i) => entry(String(i))) : fixture.removed ? [] : [entry('deep')]
      return { reports, nextCursor: pageParam === 0 ? 1 : null }
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: Infinity,
    retry: false,
  }),
}))
function entry(id: string) {
  return { id, runId: 'source', title: `Report ${id}`, name: `${id}.html`, taskTitle: 'Source', createdAt: '2026-11-01T12:00:00Z' }
}
function Reader() {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>Reader Back</button>
}
afterEach(() => { cleanup(); vi.clearAllMocks(); fixture.removed = false; fixture.failed = false })

it.each([false, true])('restores a page-two selection after cache removal (row removed: %s)', async removed => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/shop/reports?q=deep-${removed}`]}><Routes>
    <Route path="/p/:projectId/reports" element={<ReportsRoute />} />
    <Route path="/p/:projectId/tasks/:id/report" element={<Reader />} />
  </Routes></MemoryRouter></QueryClientProvider>)
  await screen.findByRole('link', { name: 'Report 0' })
  fireEvent.click(screen.getByRole('button', { name: 'Load more reports' }))
  const row = await screen.findByRole('link', { name: 'Report deep' })
  const list = document.querySelector<HTMLDivElement>('[data-slot="reports-list"]')!
  list.scrollTop = 1700
  fireEvent.click(row)
  await screen.findByRole('button', { name: 'Reader Back' })
  client.removeQueries({ queryKey, exact: true }) // Simulate inactive query GC without a timer.
  fixture.fetch.mockClear(); fixture.removed = removed
  fireEvent.click(screen.getByRole('button', { name: 'Reader Back' }))
  await waitFor(() => expect(fixture.fetch.mock.calls.map(call => call[0])).toEqual([0, 1]))
  await waitFor(() => {
    const restored = document.querySelector<HTMLDivElement>('[data-slot="reports-list"]')!
    expect(restored.scrollTop).toBe(removed ? 0 : 1700)
    if (!removed) expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Report deep' }))
    else expect(screen.queryByRole('link', { name: 'Report deep' })).toBeNull()
  })
  client.clear()
})

it('latches a failed deep-page restore at the top and leaves Load more as a manual retry', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/p/shop/reports?q=failed-restore']}><Routes>
    <Route path="/p/:projectId/reports" element={<ReportsRoute />} />
    <Route path="/p/:projectId/tasks/:id/report" element={<Reader />} />
  </Routes></MemoryRouter></QueryClientProvider>)
  await screen.findByRole('link', { name: 'Report 0' })
  fireEvent.click(screen.getByRole('button', { name: 'Load more reports' }))
  const row = await screen.findByRole('link', { name: 'Report deep' })
  document.querySelector<HTMLDivElement>('[data-slot="reports-list"]')!.scrollTop = 1700
  fireEvent.click(row)
  await screen.findByRole('button', { name: 'Reader Back' })
  client.removeQueries({ queryKey, exact: true })
  fixture.fetch.mockClear(); fixture.failed = true
  fireEvent.click(screen.getByRole('button', { name: 'Reader Back' }))
  await waitFor(() => expect(client.getQueryState(queryKey)?.fetchFailureCount).toBe(1))
  const list = document.querySelector<HTMLDivElement>('[data-slot="reports-list"]')!
  expect(list.scrollTop).toBe(0)
  // A successful manual retry must keep the user's new position, not restore the old selection.
  list.scrollTop = 200; fixture.failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Load more reports' }))
  await screen.findByRole('link', { name: 'Report deep' })
  expect(list.scrollTop).toBe(200)
  expect(document.activeElement).not.toBe(screen.getByRole('link', { name: 'Report deep' }))
  expect(fixture.fetch.mock.calls.map(call => call[0])).toEqual([0, 1, 1])
  client.clear()
})
