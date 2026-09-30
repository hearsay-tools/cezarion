import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { WorkspaceToolsRoute } from './workspace-tools'

const mocks = vi.hoisted(() => ({ refetch: vi.fn(), copy: vi.fn(), singleProject: false, allAvailable: false }))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { version: '1.2.3', repoRoot: '/local/repo', checks: [{ name: 'git', available: true, version: '2.50' }, mocks.allAvailable ? { name: 'codex', available: true, version: '0.9' } : { name: 'codex', available: false, hint: 'Install the Codex CLI' }], capabilities: { singleProject: mocks.singleProject } }, refetch: mocks.refetch, isFetching: false, isError: false }),
  useProjects: () => ({ data: { projectsDir: '/local/projects' } }),
}))
vi.mock('@/components/add-project-dialog', () => ({ AddProjectDialog: () => <div role="dialog" aria-label="Choose local folder" /> }))
vi.mock('@/components/clone-project-dialog', () => ({ CloneProjectDialog: () => <div role="dialog" aria-label="Clone repository" /> }))
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.singleProject = false; mocks.allAvailable = false; vi.unstubAllGlobals() })

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
    expect(JSON.parse(mocks.copy.mock.calls[0]![0])).toEqual({ version: '1.2.3', checks: [{ name: 'git', available: true, version: '2.50' }, { name: 'codex', available: false, hint: 'Install the Codex CLI' }] })
    expect(screen.getByText('Not installed')).toBeTruthy()
  })

  it('respects single-project mode without hiding diagnostics', () => {
    mocks.singleProject = true
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'Clone from GitHub' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Recheck tools' })).toBeTruthy()
  })

  it('marks each tool with a status dot and explains the missing one', () => {
    const { container } = render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    const git = container.querySelector('[data-slot="tool-row"][data-tool="git"]')!
    const codex = container.querySelector('[data-slot="tool-row"][data-tool="codex"]')!
    expect(git.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(git.textContent).toContain('Installed')
    expect(codex.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(codex.textContent).toContain('Not installed')
    expect(codex.querySelector('[data-slot="tool-hint"]')?.textContent).toBe('Install the Codex CLI')
    expect(git.querySelector('[data-slot="tool-hint"]')).toBeNull()
  })

  it('keeps every row a valid definition list: only dt/dd inside, the link inside the state dd, the hint indented past the dot', () => {
    const { container } = render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    for (const row of container.querySelectorAll('[data-slot="tool-row"]')) {
      expect([...row.children].every((el) => el.tagName === 'DT' || el.tagName === 'DD')).toBe(true)
    }
    const codex = container.querySelector('[data-slot="tool-row"][data-tool="codex"]')!
    expect(codex.querySelector('[data-slot="tool-setup"]')?.parentElement?.tagName).toBe('DD')
    expect(codex.querySelector('[data-slot="tool-hint"]')?.className).toContain('pl-[15px]')
  })

  it('offers "Set up ›" only on unavailable rows, and both links go to Agents settings', () => {
    // /tools is mounted at the workspace level only: the links carry no scope and
    // LegacyPathRedirect sends them to the boot project, as the desktop menu's link does.
    const { container } = render(<MemoryRouter initialEntries={['/tools']}><WorkspaceToolsRoute /></MemoryRouter>)
    const setups = screen.getAllByRole('link', { name: 'Set up ›' })
    expect(setups).toHaveLength(1)
    expect(container.querySelector('[data-tool="codex"] [data-slot="tool-setup"]')).toBe(setups[0])
    expect(setups[0]!.getAttribute('href')).toBe('/settings/agents')
    expect(screen.getByRole('link', { name: 'Tool settings ›' }).getAttribute('href')).toBe('/settings/agents')
  })

  it('has no "Set up" link when every tool is available', () => {
    mocks.allAvailable = true
    render(<MemoryRouter><WorkspaceToolsRoute /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: /Set up/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Tool settings ›' })).toBeTruthy()
  })
})
