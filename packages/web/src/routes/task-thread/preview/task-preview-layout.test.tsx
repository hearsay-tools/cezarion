import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ preview: true }))

vi.mock('@/api/queries', () => ({
  useRun: () => ({ data: { id: 'r1', worktreePath: '/w', previewServers: [] } }),
  useHealth: () => ({ data: { capabilities: { preview: state.preview } } }),
}))

vi.mock('./preview-pane', () => ({
  PreviewPane: ({ onClose }: { onClose: () => void }) => <button type="button" onClick={onClose}>pane</button>,
}))

import { TaskPreviewLayout } from './task-preview-layout'
import { usePreviewPane } from './preview-state'

afterEach(() => cleanup())

function Tab({ name }: { name: string }) {
  const pane = usePreviewPane()
  return (
    <div>
      <span data-testid="tab">{name}</span>
      {pane ? <button type="button" onClick={() => pane.openPane({})}>toggle</button> : <span>no pane</span>}
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
})
