import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { WorkspaceToolsRoute } from './workspace-tools'

const mocks = vi.hoisted(() => ({ refetch: vi.fn(), copy: vi.fn(), singleProject: false }))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { version: '1.2.3', repoRoot: '/local/repo', checks: [{ name: 'git', available: true, version: '2.50' }, { name: 'codex', available: false }], capabilities: { singleProject: mocks.singleProject } }, refetch: mocks.refetch, isFetching: false, isError: false }),
  useProjects: () => ({ data: { projectsDir: '/local/projects' } }),
}))
vi.mock('@/components/add-project-dialog', () => ({ AddProjectDialog: () => <div role="dialog" aria-label="Choose local folder" /> }))
vi.mock('@/components/clone-project-dialog', () => ({ CloneProjectDialog: () => <div role="dialog" aria-label="Clone repository" /> }))
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.singleProject = false; vi.unstubAllGlobals() })

describe('Workspace tools', () => {
  it('opens both existing project flows from the shared workspace page', () => {
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Open local folder' }))
    expect(screen.getByRole('dialog', { name: 'Choose local folder' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clone from GitHub' }))
    expect(screen.getByRole('dialog', { name: 'Clone repository' })).toBeTruthy()
  })

  it('rechecks the real tool inventory and copies only the reported diagnostics', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.copy.mockResolvedValue(undefined) } })
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Recheck tools' }))
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1))
    expect(JSON.parse(mocks.copy.mock.calls[0]![0])).toEqual({ version: '1.2.3', checks: [{ name: 'git', available: true, version: '2.50' }, { name: 'codex', available: false }] })
    expect(screen.getByText('Not installed')).toBeTruthy()
  })

  it('respects single-project mode without hiding diagnostics', () => {
    mocks.singleProject = true
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'Clone from GitHub' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Recheck tools' })).toBeTruthy()
  })
})
