import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  preview: true,
  agentLive: false,
  agentReads: [] as Array<string | undefined>,
  runs: {} as Record<string, Record<string, unknown>>,
  requests: [] as unknown[],
  paneMounts: [] as string[],
}))

vi.mock('@/api/queries', () => ({
  useRun: (id: string) => ({ data: state.runs[id] ?? { id, worktreePath: '/w', previewServers: [] } }),
  useHealth: () => ({ data: { capabilities: { preview: state.preview } } }),
}))

vi.mock('./use-preview-server-states', () => ({ usePreviewServerStates: () => new Map() }))
vi.mock('./use-agent-page-live', () => ({
  useAgentPageLive: (id: string | undefined) => {
    state.agentReads.push(id)
    return state.agentLive
  },
}))

vi.mock('./preview-pane', () => ({
  PreviewPane: ({ run, onClose, onTarget, request }: { run: { id: string }; onClose: () => void; onTarget?: (target: unknown) => void; request?: unknown }) => {
    state.requests.push(request)
    useEffect(() => void state.paneMounts.push(run.id), [])
    return (
      <>
        <button type="button" onClick={onClose}>pane</button>
        <button type="button" onClick={() => onTarget?.({ url: 'http://localhost:3000/docs' })}>show url</button>
      </>
    )
  },
}))

import { TaskPreviewLayout } from './task-preview-layout'
import { usePreviewPane } from './preview-state'
import { PANE_WIDTH_STORAGE_KEY, PREVIEW_MEMORY_STORAGE_KEY, readPreviewMemory, rememberPreview } from './preview-memory'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** Below 1180 px the dock query fails: the pane takes the main area. */
function setDocked(docked: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 1180px') ? docked : false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

const mounts = vi.fn()

function Tab({ name }: { name: string }) {
  const pane = usePreviewPane()
  const navigate = useNavigate()
  useEffect(() => mounts(), [])
  return (
    <div>
      <span data-testid="tab">{name}</span>
      {pane ? <button type="button" onClick={() => pane.openPane({})}>toggle</button> : <span>no pane</span>}
      {pane ? <button type="button" onClick={() => pane.openPane({ port: 5173 })}>open 5173</button> : null}
      {pane ? <span data-testid="removed">{String(pane.worktreeRemoved)}</span> : null}
      {pane ? <span data-testid="open">{String(pane.open)}</span> : null}
      {pane ? <span data-testid="agent">{String(pane.agentLive)}</span> : null}
      <button type="button" onClick={() => navigate('/tasks/r2')}>other task</button>
    </div>
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskPreviewLayout />}>
          <Route index element={<Tab name="session" />} />
          <Route path="changes" element={<Tab name="changes" />} />
          <Route path="files" element={<Tab name="files" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('TaskPreviewLayout', () => {
  beforeEach(() => {
    state.runs = {}
    state.agentLive = false
    state.agentReads = []
    state.requests = []
    state.paneMounts = []
    mounts.mockClear()
  })

  it.each([
    ['no worktree path', { worktreePath: undefined }, true],
    ['a reclaimed worktree', { worktreeReclaimedAt: '2026-10-02T12:00:00.000Z' }, true],
    ['a destroyed worker whose worktree is gone', { delegation: { role: 'worker', destroy: { phase: 'complete', remaining: [] } } }, true],
    ['a worker mid-destroy', { delegation: { role: 'worker', destroy: { phase: 'cleaning', remaining: ['worktree', 'branch'] } } }, false],
    ['a live worktree', {}, false],
  ])('tells the cards the worktree is removed for %s', (_name, patch, removed) => {
    state.preview = true
    state.runs.r1 = { id: 'r1', worktreePath: '/w', previewServers: [], ...patch }
    renderAt('/tasks/r1')
    expect(screen.getByTestId('removed').textContent).toBe(String(removed))
  })

  it('another task keeps the tab mounted and starts with the pane closed', async () => {
    state.preview = true
    renderAt('/tasks/r1')
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect(screen.getByTestId('open').textContent).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'other task' }))
    expect(screen.getByTestId('open').textContent).toBe('false')
    expect(mounts).toHaveBeenCalledTimes(1)
  })

  it.each(['/tasks/r1', '/tasks/r1/changes', '/tasks/r1/files'])('offers the pane to %s', path => {
    state.preview = true
    renderAt(path)
    expect(screen.getByRole('button', { name: 'toggle' })).toBeTruthy()
  })

  it('docks the pane next to whichever tab opened it', async () => {
    state.preview = true
    renderAt('/tasks/r1/changes')
    expect(document.querySelector('[data-slot="preview-pane"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    fireEvent.click(await screen.findByRole('button', { name: 'pane' }))
    expect(screen.getByTestId('tab').textContent).toBe('changes')
    expect(document.querySelector('[data-slot="preview-pane"]')).toBeNull()
  })

  it('offers nothing with the feature off', () => {
    state.preview = false
    renderAt('/tasks/r1')
    expect(screen.getByText('no pane')).toBeTruthy()
    // Off, the task view never reads its events for the agent's page.
    expect(state.agentReads).toEqual([])
  })

  it("tells the toggle whether the agent's page is live (hearsay-tools/cezarion#784)", () => {
    state.preview = true
    state.agentLive = true
    renderAt('/tasks/r1/files')
    expect(screen.getByTestId('agent').textContent).toBe('true')
    expect(state.agentReads).toContain('r1')
  })

  it('leaves the task view exactly as it was with the feature off: no split around the tab', () => {
    state.preview = false
    renderAt('/tasks/r1')
    expect(screen.getByTestId('tab').textContent).toBe('session')
    expect(document.querySelector('[data-slot="task-split"]')).toBeNull()
    expect(document.querySelector('[data-slot="task-main"]')).toBeNull()
  })

  describe('remembers the pane per task (hearsay-tools/cezarion#2077)', () => {
    const server = { port: 5173, command: 'npm run dev', label: 'web', registeredAt: '2026-10-28T10:00:00.000Z', answeredAtRegistration: true }
    const divider = () => document.querySelector('[data-slot="preview-divider"]')
    const pane = () => document.querySelector<HTMLElement>('[data-slot="preview-pane"]')

    beforeEach(() => {
      state.preview = true
      state.runs.r1 = { id: 'r1', worktreePath: '/w', previewServers: [server] }
    })

    it('reopens the pane on the server it showed, after a reload, without asking to run it', async () => {
      const first = renderAt('/tasks/r1')
      fireEvent.click(screen.getByRole('button', { name: 'open 5173' }))
      await screen.findByRole('button', { name: 'pane' })
      first.unmount()
      state.requests = []
      renderAt('/tasks/r1')
      expect(screen.getByTestId('open').textContent).toBe('true')
      await screen.findByRole('button', { name: 'pane' })
      expect(state.requests.at(-1)).toEqual({ port: 5173, restored: true })
    })

    it('reopens a typed URL the pane reported', async () => {
      const first = renderAt('/tasks/r1')
      fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
      fireEvent.click(await screen.findByRole('button', { name: 'show url' }))
      first.unmount()
      renderAt('/tasks/r1')
      await screen.findByRole('button', { name: 'pane' })
      expect(state.requests.at(-1)).toEqual({ url: 'http://localhost:3000/docs', restored: true })
    })

    it('reopened on the chooser after a close, a reload comes back to the chooser, not the old server', async () => {
      rememberPreview('r1', { open: false, target: { port: 5173 } }, 1)
      const first = renderAt('/tasks/r1')
      fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
      await screen.findByRole('button', { name: 'pane' })
      first.unmount()
      state.requests = []
      renderAt('/tasks/r1')
      await screen.findByRole('button', { name: 'pane' })
      expect(state.requests.at(-1)).toEqual({ restored: true })
    })

    it('asked for the chooser while it shows a server, it keeps that server saved', async () => {
      renderAt('/tasks/r1')
      fireEvent.click(screen.getByRole('button', { name: 'open 5173' }))
      await screen.findByRole('button', { name: 'pane' })
      fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
      expect(readPreviewMemory('r1')).toEqual({ open: true, target: { port: 5173 } })
    })

    it("moving between two tasks with open panes gives the second its own pane, never the first one's target", async () => {
      state.runs.r2 = { id: 'r2', worktreePath: '/w', previewServers: [server] }
      rememberPreview('r2', { open: true }, 1)
      renderAt('/tasks/r1')
      fireEvent.click(screen.getByRole('button', { name: 'open 5173' }))
      await screen.findByRole('button', { name: 'pane' })
      fireEvent.click(screen.getByRole('button', { name: 'other task' }))
      await screen.findByRole('button', { name: 'pane' })
      expect(state.paneMounts).toEqual(['r1', 'r2'])
      expect(state.requests.at(-1)).toEqual({ restored: true })
      expect(readPreviewMemory('r2')).toEqual({ open: true })
    })

    it('stays closed after a reload when the owner closed it', async () => {
      const first = renderAt('/tasks/r1')
      fireEvent.click(screen.getByRole('button', { name: 'open 5173' }))
      fireEvent.click(await screen.findByRole('button', { name: 'pane' }))
      first.unmount()
      renderAt('/tasks/r1')
      expect(screen.getByTestId('open').textContent).toBe('false')
      expect(pane()).toBeNull()
    })

    it("keeps each task's pane apart", async () => {
      rememberPreview('r2', { open: false, target: { agent: true }, percent: 40 }, 1)
      renderAt('/tasks/r1')
      fireEvent.click(screen.getByRole('button', { name: 'open 5173' }))
      await screen.findByRole('button', { name: 'pane' })
      fireEvent.keyDown(divider()!, { key: 'ArrowLeft' })
      fireEvent.click(screen.getByRole('button', { name: 'other task' }))
      expect(screen.getByTestId('open').textContent).toBe('false')
      expect(readPreviewMemory('r2')).toEqual({ open: false, target: { agent: true }, percent: 40 })
      expect(readPreviewMemory('r1')).toEqual({ open: true, target: { port: 5173 }, percent: 60 })
    })

    it('opens a task on its own width, and a task with none on the last width set', async () => {
      localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '44')
      rememberPreview('r1', { open: true, target: { port: 5173 }, percent: 66 }, 1)
      const first = renderAt('/tasks/r1')
      await screen.findByRole('button', { name: 'pane' })
      expect(divider()?.getAttribute('aria-valuenow')).toBe('66')
      first.unmount()
      state.runs.r3 = { id: 'r3', worktreePath: '/w', previewServers: [server] }
      renderAt('/tasks/r3')
      fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
      await screen.findByRole('button', { name: 'pane' })
      expect(divider()?.getAttribute('aria-valuenow')).toBe('44')
    })

    it('clamps a saved width outside the limits', async () => {
      localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify({ r1: { open: true, target: { port: 5173 }, percent: 99, at: 1 } }))
      renderAt('/tasks/r1')
      await screen.findByRole('button', { name: 'pane' })
      expect(divider()?.getAttribute('aria-valuenow')).toBe('75')
    })

    it('on a smaller screen brings the task back first, with the pane one toggle away', async () => {
      setDocked(false)
      rememberPreview('r1', { open: true, target: { port: 5173 } }, 1)
      renderAt('/tasks/r1')
      await screen.findByRole('button', { name: 'pane', hidden: true })
      expect(pane()?.hidden).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-slot="task-main"]')?.hidden).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
      expect(pane()?.hidden).toBe(false)
    })

    it('does not bring the pane back on a task whose worktree is gone, and keeps what was saved', () => {
      state.runs.r1 = { id: 'r1', worktreePath: undefined, previewServers: [server] }
      rememberPreview('r1', { open: true, target: { port: 5173 } }, 1)
      renderAt('/tasks/r1')
      expect(screen.getByTestId('open').textContent).toBe('false')
      expect(pane()).toBeNull()
      expect(readPreviewMemory('r1')).toEqual({ open: true, target: { port: 5173 } })
    })
  })
})
