import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell, type AppShellProps } from '@/components/app-shell'
import type { MobileProjectNav } from '@/components/mobile-projects'
import { ThemeProvider } from '@/components/theme-provider'

/**
 * Guards for the shell's chrome that no other shell test pins: the props that reach the desktop
 * breadcrumb, the sidebar slots, the update footer and drawer row, the mobile title and the tab
 * bar's More sheet. They pin today's output so the AppShell split (hearsay-tools/cezarion#1774)
 * cannot drop a prop on the way down without a test noticing.
 */

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function renderShell(entry: string, props: Partial<AppShellProps> = {}) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <AppShell {...props}><p>route</p></AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  )
}

const projects: MobileProjectNav = {
  projects: [
    { id: 'cezarion', name: 'Cezarion', root: '/r/c', addedAt: '2026-07-01T00:00:00.000Z', lastOpenedAt: '2026-07-01T00:00:00.000Z', source: 'local', status: 'ok', branch: 'main' },
  ],
  signals: new Map([['cezarion', { needsYou: 0, failedUnread: 0, inMotion: 0, finishedUnread: 0 }]]),
  singleProject: false,
}

const slot = (name: string, root: ParentNode = document) => root.querySelector(`[data-slot="${name}"]`) as HTMLElement | null
const sidebar = () => slot('sidebar') as HTMLElement
const openDrawer = () => fireEvent.click(screen.getByRole('button', { name: /^Open projects/ }))
const drawer = () => slot('mobile-nav-drawer')

describe('desktop breadcrumb', () => {
  it('prefers the breadcrumb prop over the repo chip', () => {
    renderShell('/p/demo/skills', {
      repo: { name: 'demo', branch: 'main' },
      breadcrumb: { project: 'Workspace', page: 'Tasks / Fix', branch: 'Isolated worktree' },
    })
    expect(slot('desktop-breadcrumb')?.textContent).toBe('Workspace/Tasks / FixIsolated worktree')
  })

  it('falls back to the repo for a breadcrumb that names no project or branch', () => {
    renderShell('/p/demo/skills', { repo: { name: 'demo', branch: 'main' }, breadcrumb: { project: null, page: 'Skills' } })
    expect(slot('desktop-breadcrumb')?.textContent).toBe('demo/Skillsmain')
  })

  it('names the active view, and Cezarion where no view is active', () => {
    renderShell('/skills')
    expect(slot('desktop-breadcrumb')?.textContent).toBe('Skills')
    cleanup()
    renderShell('/tools')
    expect(slot('desktop-breadcrumb')?.textContent).toBe('Cezarion')
  })
})

describe('mobile top bar title', () => {
  it('keeps the route title for screen readers only beside a repo', () => {
    renderShell('/p/demo/skills', { repo: { name: 'demo', branch: 'main' } })
    const title = slot('mobile-route-title', slot('mobile-top-bar') as HTMLElement)
    expect(title?.textContent).toBe('Skills')
    expect(title?.className).toContain('sr-only')
  })

  it('holds the search button right with a spacer where no view is active and no repo is known', () => {
    renderShell('/tools')
    const bar = slot('mobile-top-bar') as HTMLElement
    expect(slot('mobile-route-title', bar)).toBeNull()
    expect(bar.querySelectorAll(':scope > div > span.flex-1')).toHaveLength(1)
  })

  it('renders neither a title nor a spacer beside a repo where no view is active', () => {
    renderShell('/tools', { repo: { name: 'demo', branch: 'main' } })
    const bar = slot('mobile-top-bar') as HTMLElement
    expect(slot('mobile-route-title', bar)).toBeNull()
    expect(bar.querySelectorAll(':scope > div > span.flex-1')).toHaveLength(0)
  })
})

describe('desktop sidebar slots', () => {
  it('renders the project header, session scope and view sidebar in place of their defaults', () => {
    renderShell('/', {
      repo: { name: 'demo', branch: 'main' },
      projectHeader: <span data-testid="project-header">header</span>,
      sessionScope: <span data-testid="session-scope">scope</span>,
      sidebarList: <span data-testid="view-sidebar">view</span>,
      taskQuickList: <span data-testid="quick-list">quick</span>,
    })
    const header = slot('sidebar-header', sidebar()) as HTMLElement
    expect(header.querySelector('[data-testid="project-header"]')).not.toBeNull()
    expect(header.textContent).toBe('header')
    expect(sidebar().querySelector('[data-testid="session-scope"]')).not.toBeNull()
    const navigation = slot('project-task-navigation', sidebar()) as HTMLElement
    expect(navigation.querySelector('[data-testid="view-sidebar"]')).not.toBeNull()
    expect(slot('task-quick-list', sidebar())).toBeNull()
    expect(sidebar().querySelector('[data-testid="quick-list"]')).toBeNull()
  })

  it('marks Tasks while tasks need you', () => {
    renderShell('/skills', { needsYou: true })
    expect(slot('nav-needs-you-dot', sidebar())).not.toBeNull()
    cleanup()
    renderShell('/skills', { needsYou: false })
    expect(slot('nav-needs-you-dot', sidebar())).toBeNull()
  })
})

describe('update props reach the sidebar footer and the drawer row', () => {
  const newer = { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'idle', supported: true } as const, onApplyUpdate: vi.fn() }
  const footerFeedback = () => slot('application-update-feedback', slot('sidebar-footer') as HTMLElement)
  const drawerRow = () => slot('drawer-update', drawer() as HTMLElement)

  it('says the connection is lost in both places while offline', () => {
    renderShell('/', { ...newer, applicationUpdateOffline: true })
    expect(footerFeedback()?.textContent).toBe('Connection lost. Reconnect to continue.')
    openDrawer()
    expect(drawerRow()?.textContent).toContain('Connection lost. Reconnect to continue.')
  })

  it('says the update is preparing in both places while busy', () => {
    renderShell('/', { ...newer, applicationUpdateBusy: true })
    expect(footerFeedback()?.textContent).toBe('Preparing update.')
    openDrawer()
    expect(drawerRow()?.textContent).toContain('Preparing update.')
  })

  it('shows the update error in both places', () => {
    renderShell('/', { ...newer, applicationUpdateError: 'Network down.' })
    expect(footerFeedback()?.textContent).toContain('Network down.')
    openDrawer()
    expect(drawerRow()?.textContent).toContain('Network down.')
  })
})

describe('mobile tab bar More sheet', () => {
  const openMore = () => fireEvent.click(document.querySelector('[data-tab="more"]') as HTMLElement)

  it('names the registry project, else the repo', () => {
    renderShell('/p/cezarion/', { mobileProjects: projects, repo: { name: 'repo-name', branch: 'main' } })
    openMore()
    expect(slot('more-project')?.textContent).toBe('Cezarion')
    cleanup()
    renderShell('/p/cezarion/', { repo: { name: 'repo-name', branch: 'main' } })
    openMore()
    expect(slot('more-project')?.textContent).toBe('repo-name')
  })
})
