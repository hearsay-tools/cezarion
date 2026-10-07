import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell, type AppShellProps } from '@/components/app-shell'
import { ThemeProvider } from '@/components/theme-provider'
import type { MobileProjectNav } from '@/components/mobile-projects'

const insets = vi.hoisted(() => ({ bottom: 0 }))
vi.mock('@/lib/keyboard-inset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/keyboard-inset')>()),
  useViewportInsets: () => ({ top: 0, bottom: insets.bottom }),
  useKeyboardOpen: () => insets.bottom > 80,
}))

beforeEach(() => {
  insets.bottom = 0
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const projects: MobileProjectNav = {
  projects: [
    { id: 'cezarion', name: 'Cezarion', root: '/r/c', addedAt: '2026-07-01T00:00:00.000Z', lastOpenedAt: '2026-07-01T00:00:00.000Z', source: 'local', status: 'ok', branch: 'main' },
    { id: 'other', name: 'Other', root: '/r/o', addedAt: '2026-07-01T00:00:00.000Z', lastOpenedAt: '2026-07-01T00:00:00.000Z', source: 'local', status: 'ok', branch: 'main' },
  ],
  signals: new Map([
    ['cezarion', { needsYou: 2, failedUnread: 0, inMotion: 1, finishedUnread: 0 }],
    ['other', { needsYou: 7, failedUnread: 0, inMotion: 0, finishedUnread: 0 }],
  ]),
  singleProject: false,
}

function renderShell(entry: string, props: Partial<AppShellProps> = {}) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <AppShell mobileProjects={projects} {...props}><p>route</p></AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  )
}

const tabBar = () => document.querySelector('[data-slot="mobile-tab-bar"]')
const fab = () => document.querySelector('[data-slot="mobile-new-task"]')

describe('AppShell mobile tab bar (#621)', () => {
  it('renders the tab bar and New task button in the composer row on list routes', () => {
    renderShell('/p/cezarion/')
    const row = document.querySelector('[data-slot="composer"]')!
    expect(row.contains(tabBar())).toBe(true)
    expect(row.contains(fab())).toBe(true)
    expect(row.className).toContain('pb-[max(env(safe-area-inset-bottom),var(--kb,0px))]')
  })

  it('badges Tasks with the CURRENT project, not the elsewhere total', () => {
    renderShell('/p/cezarion/')
    expect(tabBar()!.querySelector('[data-segment="amber"]')!.getAttribute('data-count')).toBe('2')
  })

  it('gates the GitHub tab on the forge', () => {
    renderShell('/p/cezarion/', { forgeAvailable: false })
    expect(tabBar()!.querySelector('[data-tab="/github"]')).toBeNull()
    expect(tabBar()!.querySelectorAll('[data-tab]')).toHaveLength(3)
  })

  it.each(['/p/cezarion/tasks/abc', '/p/cezarion/tasks/abc/changes', '/tasks/abc/files', '/p/cezarion/compare/g1', '/compare/g1'])(
    'hides the tab bar and New task button on pushed route %s',
    (entry) => {
      renderShell(entry)
      expect(tabBar()).toBeNull()
      expect(fab()).toBeNull()
    },
  )

  it.each(['/p/cezarion/git?view=repo', '/p/cezarion/git/not-landed', '/p/cezarion/git/cleanup', '/git/branches'])(
    'hides the tab bar on the pushed Git section screen %s (issue 08)',
    (entry) => {
      renderShell(entry)
      expect(tabBar()).toBeNull()
    },
  )

  it('keeps the tab bar on the Git screen itself, which is a list', () => {
    renderShell('/p/cezarion/git')
    expect(tabBar()).not.toBeNull()
  })

  it('keeps them on the tasks overview, which is a list', () => {
    renderShell('/p/cezarion/tasks')
    expect(tabBar()).not.toBeNull()
  })

  it('hides the tab bar and the button while the on-screen keyboard is open', () => {
    insets.bottom = 300
    renderShell('/p/cezarion/')
    expect(tabBar()).toBeNull()
    expect(fab()).toBeNull()
    // The row itself stays: it is what lifts the composer by --kb.
    expect(document.querySelector('[data-slot="composer"]')).not.toBeNull()
  })

  it('keeps the tab bar but drops the New task button on /new', () => {
    renderShell('/p/cezarion/new')
    expect(tabBar()).not.toBeNull()
    expect(fab()).toBeNull()
  })

  it('pads main clear of the New task button while it is shown, and only then', () => {
    renderShell('/p/cezarion/')
    expect(document.querySelector('[data-slot="main"]')?.className).toContain('max-md:pb-20')
    cleanup()
    renderShell('/p/cezarion/new')
    expect(document.querySelector('[data-slot="main"]')?.className).not.toContain('max-md:pb-20')
    cleanup()
    renderShell('/p/cezarion/tasks/r1')
    expect(document.querySelector('[data-slot="main"]')?.className).not.toContain('max-md:pb-20')
  })
})
