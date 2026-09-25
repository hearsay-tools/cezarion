import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorktreeInfo, WorktreesResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { WorktreesPanel } from './worktrees-panel'

/**
 * Settings → Resources: the worktrees management panel (#483). Renders rows,
 * per-row Delete and "Reclaim now" call their routes (behind a confirm), and the
 * empty state shows when there is nothing on disk. #566: footer, Reclaim now,
 * and the empty-reclaim toast share the reclaimable-vs-keep budget.
 */

let requests: Array<{ method: string; url: string }> = []

function serve(data: WorktreesResponse, reclaim: { reclaimed: string[] } = { reclaimed: ['r1'] }) {
  requests = []
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url })
      if (url === '/api/v1/open-targets') return json({ targets: [{ id: 'finder', label: 'Files', icon: 'folder' }] })
      if (url.endsWith('/open-in') && method === 'POST') return json({ opened: true, path: '/tmp/worktree' })
      if (url === '/api/v1/worktrees' && method === 'GET') return json(data)
      if (url === '/api/v1/worktrees/reclaim' && method === 'POST') return json(reclaim)
      if (/\/api\/v1\/runs\/.+\/remove-worktree$/.test(url) && method === 'POST') return json({ removed: true })
      return new Promise<never>(() => {})
    }),
  )
}

function renderPanel() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <WorktreesPanel />
      <Toaster />
    </QueryClientProvider>,
  )
}

const rows = () => document.querySelectorAll('[data-slot="worktree-row"]')
const posts = (match: RegExp) => requests.filter((r) => r.method === 'POST' && match.test(r.url))
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-action="worktrees-confirm"]')
const reclaimNow = () => document.querySelector<HTMLButtonElement>('[data-action="worktrees-reclaim-now"]')
const footer = () => document.querySelector('[data-slot="worktrees-footer"]')

function worktree(partial: Partial<WorktreeInfo> & Pick<WorktreeInfo, 'runId' | 'title'>): WorktreeInfo {
  return {
    status: 'done',
    branch: `cez/${partial.runId.slice(0, 8)}`,
    sizeBytes: 1024,
    finishedAt: '2026-07-01T00:00:00Z',
    reclaimable: false,
    ...partial,
  }
}

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const sample: WorktreesResponse = {
  worktrees: [
    {
      runId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      title: 'fix the login bug',
      status: 'done',
      branch: 'cez/aaaaaaaa',
      sizeBytes: 5 * 1024 * 1024,
      finishedAt: '2026-07-01T00:00:00Z',
      reclaimable: true,
    },
    {
      runId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      title: 'review dialog',
      status: 'review',
      branch: 'cez/bbbbbbbb',
      sizeBytes: null,
      finishedAt: null,
      reclaimable: false,
    },
  ],
  totalBytes: null,
  keep: 10,
}

/** Two reclaimable finished rows plus one spared review — over a keep of 1. */
const overKeep: WorktreesResponse = {
  worktrees: [
    sample.worktrees[0]!,
    worktree({
      runId: 'cccccccc-3333-4333-8333-cccccccccccc',
      title: 'older finished task',
      reclaimable: true,
      finishedAt: '2026-06-01T00:00:00Z',
    }),
    sample.worktrees[1]!,
  ],
  totalBytes: 20 * 1024 * 1024,
  keep: 1,
}

/**
 * Honesty fixture (#566): the listing marks 23 finished-looking worker rows
 * not reclaimable. Footer/button follow those flags, not on-disk count.
 */
const workerMajority: WorktreesResponse = {
  worktrees: [
    ...Array.from({ length: 23 }, (_, i) =>
      worktree({
        runId: `worker-${String(i + 1).padStart(2, '0')}`,
        title: `finished worker ${i + 1}`,
      }),
    ),
    ...Array.from({ length: 7 }, (_, i) =>
      worktree({
        runId: `done-${i + 1}`,
        title: `finished parent ${i + 1}`,
        reclaimable: true,
      }),
    ),
    worktree({
      runId: 'running-root',
      title: 'live investigation',
      status: 'running',
      finishedAt: null,
    }),
  ],
  totalBytes: Math.round(8.1 * 1024 ** 3),
  keep: 8,
}

describe('Settings → Resources: worktrees panel (#483)', () => {
  it('opens a worktree through the discovered local folder target', async () => {
    serve(sample)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder for review dialog' }))
    await waitFor(() => expect(posts(/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb\/open-in$/)).toHaveLength(1))
  })

  it('renders a row per worktree with size (or — when unavailable) and the keep footer', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(document.body.textContent).toContain('fix the login bug')
    expect(document.body.textContent).toContain('5 MB')
    // Null size degrades to an em dash; null total degrades the footer.
    expect(footer()?.textContent).toContain('keeping the last 10')
    expect(footer()?.textContent).toContain('size unavailable')
  })

  it('Delete calls the per-run remove-worktree route (after confirming the dialog)', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(document.querySelector('[data-action="worktree-delete"]')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(posts(/\/remove-worktree$/)).toHaveLength(1))
  })

  it('Reclaim now calls the reclaim route (after confirming the dialog)', async () => {
    serve(overKeep)
    renderPanel()
    await waitFor(() => expect(reclaimNow()?.disabled).toBe(false))
    fireEvent.click(reclaimNow()!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(posts(/\/api\/v1\/worktrees\/reclaim$/)).toHaveLength(1))
  })

  it('does not call the route when the confirm dialog is dismissed', async () => {
    serve(overKeep)
    renderPanel()
    await waitFor(() => expect(reclaimNow()?.disabled).toBe(false))
    fireEvent.click(reclaimNow()!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    // "Keep it" (AlertDialogCancel) closes without acting.
    fireEvent.click(document.querySelector('[data-slot="alert-dialog-cancel"]')!)
    await waitFor(() => expect(confirmButton()).toBeNull())
    expect(posts(/reclaim$|remove-worktree$/)).toHaveLength(0)
  })

  it('shows the empty state when nothing is on disk', async () => {
    serve({ worktrees: [], totalBytes: 0, keep: 0 })
    renderPanel()
    await waitFor(() => expect(document.querySelector('[data-slot="worktrees-empty"]')).not.toBeNull())
    expect(footer()?.textContent).toContain('unlimited')
  })

  it('disables Reclaim now when reclaimable finished worktrees are within keep', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(reclaimNow()?.disabled).toBe(true)
  })

  it('pins a finished-worker majority that stays under the keep budget (#566)', async () => {
    serve(workerMajority)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(31))
    expect(footer()?.textContent).toBe('31 worktrees · 8.1 GB on disk · 7 reclaimable, keeping the last 8')
    expect(footer()?.className).toContain('text-soft-foreground')
    expect(reclaimNow()?.disabled).toBe(true)
  })

  it('counts finished workers toward Reclaim now when the listing marks them reclaimable (#575)', async () => {
    serve({
      ...workerMajority,
      worktrees: workerMajority.worktrees.map((row) =>
        row.runId.startsWith('worker-') ? { ...row, reclaimable: true } : row,
      ),
    })
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(31))
    expect(footer()?.textContent).toBe('31 worktrees · 8.1 GB on disk · 30 reclaimable, keeping the last 8')
    expect(reclaimNow()?.disabled).toBe(false)
  })

  it('empty reclaim toast does not claim every worktree is within the limit (#566)', async () => {
    // 3 dirs on disk, 2 reclaimable, keep 1 — total exceeds keep, so the old toast lied.
    serve(overKeep, { reclaimed: [] })
    renderPanel()
    await waitFor(() => expect(reclaimNow()?.disabled).toBe(false))
    fireEvent.click(reclaimNow()!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).not.toBeNull())
    const message = document.querySelector('[data-slot="toast"]')?.textContent ?? ''
    expect(message.toLowerCase()).not.toContain('all worktrees are within the limit')
    expect(message).toBe('Nothing to reclaim — no finished worktrees exceed the keep limit')
    expect(document.querySelector('[data-slot="toast"]')?.className).toContain('text-contrast-foreground')
  })
})
