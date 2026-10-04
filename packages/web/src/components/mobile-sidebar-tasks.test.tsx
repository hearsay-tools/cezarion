import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { AppShell } from '@/components/app-shell'
import { ListViewProvider } from '@/components/list-view'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { ThemeProvider } from '@/components/theme-provider'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import { resetSwipeStore } from '@/components/use-swipe-to-archive'

const api = vi.hoisted(() => ({ archiveProjectFinished: vi.fn(), archiveProjectRun: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), ...api }))

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  api.archiveProjectFinished.mockResolvedValue({ ids: ['finished'], pinnedIds: [] })
  api.archiveProjectRun.mockResolvedValue({})
})
afterEach(() => { cleanup(); resetToasts(); resetSwipeStore(); localStorage.clear(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function Location() { return <output data-testid="location">{useLocation().pathname}</output> }

function openDrawer(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { bootProject: 'boot', capabilities: {} })
  client.setQueryData(workspaceQueryKeys.projects, { bootProject: 'boot', projects: [] })
  client.setQueryData(queryKeys.runs.list(), [{ id: 'finished', title: 'Finished task', task: 't', workflow: 'w', status: 'done', createdAt: '2026-07-01T00:00:00Z', tokensUsed: 0, archived: false, steps: [] }])
  render(<QueryClientProvider client={client}><ThemeProvider><MemoryRouter initialEntries={[route]}><ListViewProvider>
    <AppShell sidebarProjectId="boot" taskQuickList={<TaskQuickListContainer projectId="boot" boot />}><Location /></AppShell>
    <Toaster />
  </ListViewProvider></MemoryRouter></ThemeProvider></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: /^Open projects/ }))
  return screen.getByRole('dialog', { name: 'Navigation' })
}

describe('mobile sidebar tasks (#811)', () => {
  it.each(['/tasks', '/p/boot/'])('scopes All to the displayed project and closes even at its current destination: %s', async (route) => {
    const drawer = openDrawer(route)
    const all = within(drawer).getByRole('link', { name: 'All' })
    expect(all.getAttribute('href')).toBe('/p/boot/')
    fireEvent.click(all)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/p/boot/')
  })

  it.each(['Archive all', 'swipe'])('releases the modal focus trap so %s Undo is exposed and keyboard reachable', async (action) => {
    const drawer = openDrawer('/tasks')
    if (action === 'Archive all') {
      fireEvent.click(within(drawer).getByRole('button', { name: 'Archive all' }))
    } else {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 47 } as DOMRect)
      const row = drawer.querySelector('[data-run-id="finished"]')!
      fireEvent.pointerDown(row, { pointerId: 1, clientX: 300, clientY: 20, button: 0 })
      fireEvent.pointerMove(row, { pointerId: 1, clientX: 280, clientY: 20 })
      fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 20 })
      fireEvent.pointerUp(row, { pointerId: 1, clientX: 40, clientY: 20 })
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const undo = screen.getByRole('button', { name: 'Undo' })
    expect(undo.closest('[aria-hidden="true"]')).toBeNull()
    act(() => undo.focus())
    expect(document.activeElement).toBe(undo)
    fireEvent.click(undo)
    await waitFor(() => expect(api.archiveProjectRun).toHaveBeenCalledWith('boot', 'finished', false))
    if (action === 'Archive all') expect(api.archiveProjectFinished).toHaveBeenCalledWith('boot', 'unpinned')
    else expect(api.archiveProjectRun).toHaveBeenCalledWith('boot', 'finished', true)
  })
})
