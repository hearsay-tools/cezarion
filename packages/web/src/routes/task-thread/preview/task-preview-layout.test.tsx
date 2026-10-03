import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  preview: true,
  runs: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('@/api/queries', () => ({
  useRun: (id: string) => ({ data: state.runs[id] ?? { id, worktreePath: '/w', previewServers: [] } }),
  useHealth: () => ({ data: { capabilities: { preview: state.preview } } }),
}))

vi.mock('./use-preview-server-states', () => ({ usePreviewServerStates: () => new Map() }))

vi.mock('./preview-pane', () => ({
  PreviewPane: ({ onClose }: { onClose: () => void }) => <button type="button" onClick={onClose}>pane</button>,
}))

import { TaskPreviewLayout } from './task-preview-layout'
import { usePreviewPane } from './preview-state'

afterEach(() => cleanup())

const mounts = vi.fn()

function Tab({ name }: { name: string }) {
  const pane = usePreviewPane()
  const navigate = useNavigate()
  useEffect(() => mounts(), [])
  return (
    <div>
      <span data-testid="tab">{name}</span>
      {pane ? <button type="button" onClick={() => pane.openPane({})}>toggle</button> : <span>no pane</span>}
      {pane ? <span data-testid="removed">{String(pane.worktreeRemoved)}</span> : null}
      {pane ? <span data-testid="open">{String(pane.open)}</span> : null}
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
  })

  it('leaves the task view exactly as it was with the feature off: no split around the tab', () => {
    state.preview = false
    renderAt('/tasks/r1')
    expect(screen.getByTestId('tab').textContent).toBe('session')
    expect(document.querySelector('[data-slot="task-split"]')).toBeNull()
    expect(document.querySelector('[data-slot="task-main"]')).toBeNull()
  })
})
