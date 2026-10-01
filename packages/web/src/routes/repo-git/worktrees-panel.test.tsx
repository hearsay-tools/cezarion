import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorktreeInfo, WorktreesResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { WorktreesPanel } from './worktrees-panel'

/**
 * Git → Cleanup (moved from Settings by issue 06 §3, reworked by issue 08 §C): the worktrees
 * management panel (#483). Renders rows with their retention state, the per-row Reclaim calls
 * the directory-only route (never the branch-deleting one), "Reclaim N now" calls the enforcer
 * behind a confirm, and the empty state shows when there is nothing on disk. #566: the button and
 * the empty-reclaim toast follow the listing's own flags (`reclaimable`, `pastKeep`).
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
      const one = /^\/api\/v1\/worktrees\/([^/]+)\/reclaim$/.exec(url)
      if (one && one[1] !== 'reclaim' && method === 'POST') return json({ runId: one[1], worktreeReclaimedAt: '2026-09-30T00:00:00Z' })
      return new Promise<never>(() => {})
    }),
  )
}

function renderPanel() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <WorktreesPanel />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => document.querySelectorAll('[data-slot="worktree-row"]')
const posts = (match: RegExp) => requests.filter((r) => r.method === 'POST' && match.test(r.url))
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-action="worktrees-confirm"]')
const reclaimNow = () => document.querySelector<HTMLButtonElement>('[data-action="worktrees-reclaim-now"]')
const states = () => [...document.querySelectorAll<HTMLElement>('[data-slot="worktree-state"]')].map((el) => el.textContent)

function worktree(partial: Partial<WorktreeInfo> & Pick<WorktreeInfo, 'runId' | 'title'>): WorktreeInfo {
  return {
    status: 'done',
    branch: `cez/${partial.runId.slice(0, 8)}`,
    sizeBytes: 1024,
    finishedAt: '2026-07-01T00:00:00Z',
    reclaimable: false,
    pastKeep: false,
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
      pastKeep: false,
    },
    {
      runId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      title: 'review dialog',
      status: 'review',
      branch: 'cez/bbbbbbbb',
      sizeBytes: null,
      finishedAt: null,
      reclaimable: false,
      pastKeep: false,
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
      pastKeep: true,
      sizeBytes: 15 * 1024 * 1024,
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

describe('Git → Cleanup: worktrees panel (#483)', () => {
  it('opens a worktree through the discovered local folder target', async () => {
    serve(sample)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder for review dialog' }))
    await waitFor(() => expect(posts(/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb\/open-in$/)).toHaveLength(1))
  })

  it('renders a row per worktree with size (or — when unavailable) and its retention state', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(document.body.textContent).toContain('fix the login bug')
    expect(document.body.textContent).toContain('5 MB')
    expect(document.body.textContent).toContain('—') // null size
    // A reclaimable row inside the keep limit is kept; a review row is in use.
    expect(states()).toEqual(['kept · newest 10', 'in use'])
    expect(document.querySelector('[data-slot="worktrees-retention"]')?.textContent).toContain('Retention keeps the newest 10 finished checkouts')
  })

  it('labels the rows past the keep limit reclaimable and sizes the button from exactly those', async () => {
    serve(overKeep)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(states()).toEqual(['kept · newest 1', 'reclaimable', 'in use'])
    expect(reclaimNow()?.textContent).toBe('Reclaim 15 MB now')
  })

  it('per-row Reclaim calls the directory-only route and never the branch-deleting one', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    // The review row is in use: no action at all.
    const reclaimButtons = document.querySelectorAll<HTMLButtonElement>('[data-action="worktree-reclaim"]')
    expect(reclaimButtons).toHaveLength(1)
    expect(document.querySelector('[data-action="worktree-delete"]')).toBeNull()
    fireEvent.click(reclaimButtons[0]!)
    await waitFor(() => expect(posts(/\/worktrees\/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\/reclaim$/)).toHaveLength(1))
    expect(posts(/remove-worktree$/)).toHaveLength(0)
    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe('Reclaimed the worktree of fix the login bug (branch kept)'))
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
    expect(document.querySelector('[data-slot="worktrees-retention"]')?.textContent).toContain('Retention is unlimited')
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
    // Workers the listing does not mark reclaimable read as in use, never as reclaimable.
    expect(states().filter((state) => state === 'in use')).toHaveLength(24)
    expect(states().filter((state) => state === 'kept · newest 8')).toHaveLength(7)
    expect(reclaimNow()?.disabled).toBe(true)
  })

  it('counts finished workers toward Reclaim now when the listing puts them past the keep limit (#575)', async () => {
    serve({
      ...workerMajority,
      worktrees: workerMajority.worktrees.map((row) =>
        row.runId.startsWith('worker-') ? { ...row, reclaimable: true, pastKeep: true } : row,
      ),
    })
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(31))
    expect(states().filter((state) => state === 'reclaimable')).toHaveLength(23)
    expect(reclaimNow()?.disabled).toBe(false)
    expect(reclaimNow()?.textContent).toBe('Reclaim 23 kB now')
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
    // The rows past keep=1 are still listed; the server kept them (dirty or in use), so say so.
    expect(message).toBe('Nothing was reclaimed — the worktrees past the keep limit have uncommitted work or are in use')
    expect(document.querySelector('[data-slot="toast"]')?.className).toContain('text-contrast-foreground')
  })

  it('a partial reclaim names how many past-keep rows the server kept', async () => {
    // Two rows past the limit; the server reclaims one and keeps the other (dirty).
    const twoPast = { ...overKeep, worktrees: overKeep.worktrees.map((row) => (row.reclaimable ? { ...row, pastKeep: true } : row)) }
    const past = twoPast.worktrees.filter((row) => row.pastKeep)
    expect(past.length).toBeGreaterThan(1)
    serve(twoPast, { reclaimed: [past[0]!.runId] })
    renderPanel()
    await waitFor(() => expect(reclaimNow()?.disabled).toBe(false))
    fireEvent.click(reclaimNow()!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).not.toBeNull())
    const message = document.querySelector('[data-slot="toast"]')?.textContent ?? ''
    expect(message).toBe(`Reclaimed 1 worktree (branch kept) · ${past.length - 1} kept: uncommitted work or in use`)
  })
})
