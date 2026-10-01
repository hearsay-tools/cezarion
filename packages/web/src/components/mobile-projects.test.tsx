import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { AppShell } from '@/components/app-shell'
import { elsewhereSignal, menuButtonLabel, type MobileProjectNav } from '@/components/mobile-projects'
import { ThemeProvider } from '@/components/theme-provider'
import type { ProjectSignal } from '@/lib/project-signal'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const project = (id: string, name = id): ProjectListEntry => ({
  id,
  name,
  root: `/home/me/${id}`,
  addedAt: '2026-07-01T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T12:00:00.000Z',
  source: 'local',
  status: 'ok',
  branch: 'main',
})

const signal = (overrides: Partial<ProjectSignal> = {}): ProjectSignal => ({
  needsYou: 0,
  failedUnread: 0,
  inMotion: 0,
  finishedUnread: 0,
  ...overrides,
})

const PROJECTS = ['cezarion', 'toolkit-dev', 'api-platform', 'mvp-unveiled', 'ops-monitor'].map((id) => project(id))
const SIGNALS = new Map<string, ProjectSignal>([
  ['cezarion', signal({ needsYou: 1, inMotion: 3, finishedUnread: 1 })],
  ['toolkit-dev', signal({ needsYou: 1, inMotion: 2 })],
  ['api-platform', signal({ failedUnread: 1 })],
  ['mvp-unveiled', signal({ finishedUnread: 1 })],
])

const nav = (overrides: Partial<MobileProjectNav> = {}): MobileProjectNav => ({
  projects: PROJECTS,
  signals: SIGNALS,
  truncated: new Set(),
  singleProject: false,
  ...overrides,
})

function Probe(): ReactNode {
  return <span data-testid="location">{useLocation().pathname}</span>
}

// The current project's row carries the shared project menu (#621), which reads health, the
// registry and runs from the query cache. Seeded, never fetched: a pending fetch stays pending.
function renderShell(entry: string, mobileProjects: MobileProjectNav | null, props: Partial<React.ComponentProps<typeof AppShell>> = {}, localHandoff = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { bootProject: 'cezarion', repo: { name: 'cezarion', root: '/home/me/cezarion', branch: 'main' }, capabilities: { localHandoff } })
  client.setQueryData(workspaceQueryKeys.projects, { bootProject: 'cezarion', projects: PROJECTS })
  client.setQueryData(queryKeys.runs.list(), [])
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShell repo={{ name: 'cezarion', branch: 'main' }} version="0.14.9" mobileProjects={mobileProjects} {...props}>
            <Probe />
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const menuButton = () => screen.getByRole('button', { name: /^Open projects/ })
const drawer = () => document.querySelector('[data-slot="mobile-nav-drawer"]') as HTMLElement
const rows = () => [...drawer().querySelectorAll<HTMLElement>('[data-slot="drawer-project"]')]
const segs = (root: Element, position: 'top' | 'bottom') =>
  [...(root.querySelector(`[data-slot="rail-pill-${position}"]`)?.querySelectorAll('[data-segment]') ?? [])].map((el) => `${el.getAttribute('data-segment')}:${el.textContent}`)

describe('elsewhereSignal / menuButtonLabel', () => {
  it('sums every project but the current one, all four counts', () => {
    expect(elsewhereSignal(nav(), 'cezarion')).toEqual({ needsYou: 1, failedUnread: 1, inMotion: 2, finishedUnread: 1 })
    // A global route has no current project, so every project is elsewhere.
    expect(elsewhereSignal(nav(), null)).toEqual({ needsYou: 2, failedUnread: 1, inMotion: 5, finishedUnread: 2 })
  })

  it('is unknown, not zero, until the runs index has loaded', () => {
    expect(elsewhereSignal(nav({ signals: null }), 'cezarion')).toBeNull()
    expect(elsewhereSignal(null, 'cezarion')).toBeNull()
  })

  it('spells the aggregate out, and says plain "Open projects" when all four are zero', () => {
    expect(menuButtonLabel(signal({ needsYou: 1, failedUnread: 1, inMotion: 2, finishedUnread: 1 }))).toBe(
      'Open projects. Elsewhere: 1 needs you, 1 failed, 2 working, 1 finished',
    )
    expect(menuButtonLabel(signal())).toBe('Open projects')
    expect(menuButtonLabel(null)).toBe('Open projects')
  })
})

describe('mobile top bar', () => {
  it('is 56px, drops the wordmark, and keeps the project button and search', () => {
    renderShell('/p/cezarion/', nav())
    const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
    expect(bar.firstElementChild?.className).toContain('h-[56px]')
    expect(bar.firstElementChild?.className).toContain('px-[8px]')
    expect(within(bar).queryByText('Cezarion')).toBeNull()
    expect(within(bar).getByRole('button', { name: 'Search' })).toBeTruthy()
    const picker = within(bar).getByRole('button', { name: 'Switch project: cezarion' })
    expect(picker.textContent).toContain('cezarion')
    expect(picker.textContent).toContain('main')
  })

  it('stacks the OTHER projects’ two pills on the menu button and spells them out', () => {
    renderShell('/p/cezarion/', nav())
    const button = menuButton()
    expect(button.getAttribute('aria-label')).toBe('Open projects. Elsewhere: 1 needs you, 1 failed, 2 working, 1 finished')
    expect(segs(button, 'top')).toEqual(['amber:1', 'red:1'])
    expect(segs(button, 'bottom')).toEqual(['violet:2', 'green:1'])
    const top = button.querySelector('[data-slot="rail-pill-top"]') as HTMLElement
    const bottom = button.querySelector('[data-slot="rail-pill-bottom"]') as HTMLElement
    expect(top.className).toContain('top-[3px]')
    expect(top.className).toContain('right-[2px]')
    expect(bottom.className).toContain('top-[24px]')
    // The cut-out ring is the top bar's own colour.
    expect(top.className).toContain('border-card')
    // 64px wide, 44px tall, in px rather than spacing steps: density scales the steps, and the
    // ultra scale shrank this to 48px and pushed the button off the top of the bar.
    expect(button.className).toContain('w-[64px]')
    expect(button.className).toContain('h-[44px]')
  })

  it('never lets a split pill reach the menu icon, whatever the counts', () => {
    // 20px icon at left 10px ends at x=30; a 64px button leaves 34px, less the 2px inset and
    // the pill's own 2px borders: two segments must stay 14px each (32px in all).
    const big = new Map<string, ProjectSignal>([['toolkit-dev', signal({ needsYou: 12, failedUnread: 30, inMotion: 99, finishedUnread: 10 })]])
    renderShell('/p/cezarion/', nav({ signals: big }))
    const widths = [...menuButton().querySelectorAll<HTMLElement>('[data-segment]')].map((el) => el.style.width)
    expect(widths).toEqual(['14px', '14px', '14px', '14px'])
    expect(segs(menuButton(), 'top')).toEqual(['amber:9+', 'red:9+'])
  })

  it('carries no pills and a plain label while activity is unknown or nothing is elsewhere', () => {
    renderShell('/p/cezarion/', nav({ signals: null }))
    expect(menuButton().getAttribute('aria-label')).toBe('Open projects')
    expect(menuButton().querySelector('[data-segment]')).toBeNull()
    cleanup()
    renderShell('/p/cezarion/', nav({ projects: [PROJECTS[0]!] }))
    expect(menuButton().getAttribute('aria-label')).toBe('Open projects')
  })

  it('lets a long project name truncate instead of widening the shell', () => {
    renderShell('/p/cezarion/', nav(), { repo: { name: 'cezar-e2e-new-task-a-very-long-project-name', branch: 'main' } })
    const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
    // A grid item sizes its column to its min-content, so both levels must be allowed to shrink.
    expect(bar.className).toContain('min-w-0')
    expect(bar.firstElementChild?.className).toContain('min-w-0')
  })

  it('never puts a count on the project button', () => {
    renderShell('/p/cezarion/', nav())
    const picker = document.querySelector('[data-slot="mobile-project-picker"]') as HTMLElement
    expect(picker.querySelector('[data-segment]')).toBeNull()
    expect(picker.textContent).not.toMatch(/\d/)
  })
})

describe('mobile drawer', () => {
  it('opens on the identity row, then one row per project, then workspace and global rows', () => {
    renderShell('/p/cezarion/', nav())
    fireEvent.click(menuButton())
    const identity = drawer().querySelector('[data-slot="drawer-identity"]') as HTMLElement
    expect(identity.textContent).toContain('Cezarion')
    expect(identity.textContent).toContain('v0.14.9')
    expect(within(identity).getByRole('button', { name: 'Close menu' })).toBeTruthy()

    expect(rows().map((row) => row.getAttribute('data-project-id'))).toEqual(PROJECTS.map((entry) => entry.id))
    for (const row of rows()) expect(row.className).toContain('h-[64px]')
    // `flex-1` belongs to the current row alone (beside its `…`): on the plain rows, in a flex
    // column, it collapsed the 64px height to 40px in a real browser.
    expect(rows().filter((row) => row.className.includes('flex-1')).map((row) => row.getAttribute('aria-current'))).toEqual(['page'])
    // A long nightly version truncates instead of pushing Close out of the identity row.
    const version = identity.querySelector('[data-slot="drawer-version"]') as HTMLElement
    expect(version.className).toContain('truncate')
    expect(version.getAttribute('title')).toBe('v0.14.9')

    const order = [...drawer().querySelectorAll('[data-slot="drawer-identity"], [data-slot="drawer-projects"], [data-slot="drawer-workspace"], [data-slot="drawer-global"]')].map((el) => el.getAttribute('data-slot'))
    expect(order).toEqual(['drawer-identity', 'drawer-projects', 'drawer-workspace', 'drawer-global'])
  })

  it('marks the current project, and paints each row’s pills and coloured state words', () => {
    renderShell('/p/cezarion/', nav())
    fireEvent.click(menuButton())
    const [current, toolkit, failed, finished, idle] = rows() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    expect(current.getAttribute('aria-current')).toBe('page')
    expect((current.closest('[data-slot="drawer-project-current"]') as HTMLElement).className).toContain('bg-sidebar-row-selected')
    expect(current.querySelector('svg[data-design-icon="check"]')).not.toBeNull()
    expect(toolkit.getAttribute('aria-current')).toBeNull()

    expect(segs(current, 'top')).toEqual(['amber:1'])
    expect(segs(current, 'bottom')).toEqual(['violet:3', 'green:1'])
    expect(segs(failed, 'top')).toEqual(['red:1'])
    expect(segs(idle, 'top')).toEqual([])
    expect((toolkit.querySelector('[data-slot="rail-pill-bottom"]') as HTMLElement).className).toContain('top-[29px]')

    const words = (row: HTMLElement) => [...row.querySelectorAll('[data-tone]')].map((el) => `${el.getAttribute('data-tone')}:${el.textContent}`)
    expect(words(current)).toEqual(['amber:1 needs you', 'violet:3 working', 'green:1 finished'])
    expect(words(failed)).toEqual(['red:1 failed'])
    expect(words(finished)).toEqual(['green:1 finished'])
    expect(idle.querySelector('[data-slot="drawer-project-state"]')?.textContent).toBe('idle')
    // The state words' own text inks (#711), shared with the expanded rail: the pills' fills
    // (`--danger`, `--pending-strong`) fail 4.5:1 as 11px text on the selected row.
    expect(current.querySelector('[data-tone="amber"]')?.className).toContain('text-signal-word-amber')
    expect(failed.querySelector('[data-tone="red"]')?.className).toContain('text-signal-word-red')
    expect(current.querySelector('[data-tone="amber"]')?.className).not.toContain('text-pending-strong')
    expect(failed.querySelector('[data-tone="red"]')?.className).not.toContain('text-danger')
    // The neutral words step up on the selected row, where `--soft-foreground` is under 4.5:1.
    expect(current.querySelector('[data-slot="drawer-project-state"]')?.className).toContain('text-muted-foreground')
    expect(idle.querySelector('[data-slot="drawer-project-state"]')?.className).toContain('text-soft-foreground')
    expect(current.querySelector('[data-tone="violet"]')?.className).toContain('text-status-running')
    expect(finished.querySelector('[data-tone="green"]')?.className).toContain('text-success')
  })

  it('says the activity is unknown rather than idle before the index loads', () => {
    renderShell('/p/cezarion/', nav({ signals: null }))
    fireEvent.click(menuButton())
    expect(rows()[1]!.querySelector('[data-slot="drawer-project-state"]')?.textContent).toBe('activity unknown')
  })

  it('opens a project on tap and closes the drawer', async () => {
    renderShell('/p/cezarion/', nav())
    fireEvent.click(menuButton())
    fireEvent.click(rows()[1]!)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/toolkit-dev/'))
    await waitFor(() => expect(drawer()).toBeNull())
  })

  it('shows All projects and Add project with the capability off, even for one project', () => {
    renderShell('/p/cezarion/', nav({ projects: [PROJECTS[0]!] }))
    fireEvent.click(menuButton())
    expect(within(drawer()).getByRole('link', { name: 'All projects · task overview' }).getAttribute('href')).toBe('/tasks')
    expect(within(drawer()).getByRole('button', { name: 'Add project' })).toBeTruthy()
  })

  it('drops both workspace rows and their divider with CEZ_SINGLE_PROJECT=1', () => {
    renderShell('/p/cezarion/', nav({ projects: [PROJECTS[0]!], singleProject: true }))
    fireEvent.click(menuButton())
    expect(rows()).toHaveLength(1)
    expect(within(drawer()).queryByRole('link', { name: /All projects/ })).toBeNull()
    expect(within(drawer()).queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(drawer().querySelector('[data-slot="drawer-workspace"]')).toBeNull()
  })

  it('keeps Global settings and the theme cycle at the bottom', () => {
    renderShell('/p/cezarion/', nav())
    fireEvent.click(menuButton())
    const global = drawer().querySelector('[data-slot="drawer-global"]') as HTMLElement
    expect(within(global).getByRole('link', { name: 'Global settings' }).getAttribute('href')).toBe('/settings/global/appearance')
    const theme = within(global).getByRole('button', { name: /^Theme:/ })
    // The test provider starts on dark; the row cycles like the toggle does (dark → system).
    expect(theme.textContent).toBe('Theme · Dark')
    fireEvent.click(theme)
    expect(theme.textContent).toBe('Theme · System')
  })

  it('no longer renders the sidebar content: nav, quick list and New task moved out (#621)', () => {
    renderShell('/p/cezarion/', nav(), { taskQuickList: <a href="/p/cezarion/tasks/x">A task</a> })
    fireEvent.click(menuButton())
    expect(drawer().querySelector('[data-slot="sidebar-content"]')).toBeNull()
    expect(within(drawer()).queryByRole('navigation', { name: 'Main' })).toBeNull()
    expect(within(drawer()).queryByRole('link', { name: 'A task' })).toBeNull()
    expect(within(drawer()).queryByRole('link', { name: /New task/ })).toBeNull()
  })

  describe('Tools row', () => {
    const tools = () => drawer().querySelector('[data-slot="drawer-tools"]') as HTMLElement

    it('opens /tools directly, above Global settings, and closes the drawer', async () => {
      renderShell('/p/cezarion/', nav(), { toolsStatus: { blocked: false, note: null } })
      fireEvent.click(menuButton())
      const global = drawer().querySelector('[data-slot="drawer-global"]') as HTMLElement
      expect([...global.children].map((el) => el.getAttribute('data-slot'))).toEqual(['drawer-tools', 'drawer-global-settings', 'theme-toggle'])
      expect(tools().getAttribute('href')).toBe('/tools')
      expect(tools().className).toContain('h-[48px]')
      fireEvent.click(tools())
      await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tools'))
      await waitFor(() => expect(drawer()).toBeNull())
    })

    it('carries the amber dot only when something blocks starting a task', () => {
      renderShell('/p/cezarion/', nav(), { toolsStatus: { blocked: true, note: null } })
      fireEvent.click(menuButton())
      const dot = tools().querySelector('[data-slot="drawer-tools-dot"]')
      expect(dot).not.toBeNull()
      expect(dot?.className).toContain('pending')
      expect(dot?.className).toContain('ring-[1.5px]')
      expect(dot?.className).toContain('ring-sidebar')
      expect(dot?.className).toContain('size-[7px]')
      expect(tools().getAttribute('aria-label')).toBe('Tools, needs setup')
      cleanup()
      renderShell('/p/cezarion/', nav(), { toolsStatus: { blocked: false, note: null } })
      fireEvent.click(menuButton())
      expect(tools().querySelector('[data-slot="drawer-tools-dot"]')).toBeNull()
      expect(tools().hasAttribute('aria-label')).toBe(false)
    })

    it('still announces the forge note when the row is blocked and labelled', () => {
      renderShell('/p/cezarion/', nav(), { toolsStatus: { blocked: true, note: 'No GitHub remote detected — the GitHub tab is hidden.' } })
      fireEvent.click(menuButton())
      const note = tools().querySelector('[data-slot="drawer-tools-note"]')!
      expect(tools().getAttribute('aria-label')).toBe('Tools, needs setup')
      expect(note.id).not.toBe('')
      expect(tools().getAttribute('aria-describedby')).toBe(note.id)
    })

    it('shows the forge note as the row’s second line, and only when there is one', () => {
      renderShell('/p/cezarion/', nav(), { toolsStatus: { blocked: false, note: 'No GitHub remote detected — the GitHub tab is hidden.' } })
      fireEvent.click(menuButton())
      expect(tools().querySelector('[data-slot="drawer-tools-note"]')?.textContent).toBe('No GitHub remote detected — the GitHub tab is hidden.')
      cleanup()
      renderShell('/p/cezarion/', nav(), { toolsStatus: { blocked: false, note: null } })
      fireEvent.click(menuButton())
      expect(tools().querySelector('[data-slot="drawer-tools-note"]')).toBeNull()
    })

    it('renders no row before health has answered', () => {
      renderShell('/p/cezarion/', nav())
      fireEvent.click(menuButton())
      expect(drawer().querySelector('[data-slot="drawer-tools"]')).toBeNull()
    })
  })

  describe('update row', () => {
    const update = { applicationUpdate: { supported: true, status: 'idle' } as never, onApplyUpdate: async () => {} }

    it('is absent when up to date: the identity row alone shows the version', () => {
      renderShell('/p/cezarion/', nav(), { latestVersion: '0.14.9', ...update })
      fireEvent.click(menuButton())
      expect(drawer().querySelector('[data-slot="drawer-update"]')).toBeNull()
    })

    it('sits directly under the identity row with the 44px Update button', () => {
      renderShell('/p/cezarion/', nav(), { latestVersion: '0.15.0', ...update })
      fireEvent.click(menuButton())
      const row = drawer().querySelector('[data-slot="drawer-update"]') as HTMLElement
      expect(drawer().querySelector('[data-slot="drawer-identity"]')?.nextElementSibling).toBe(row)
      expect(row.textContent).toContain('Update available · v0.15.0')
      expect(within(row).getByRole('button', { name: 'Update application' }).className).toContain('size-11')
    })

    it.each([
      ['preparing', 'Preparing update…'],
      ['ready', 'Restart to finish updating'],
      ['restarting', 'Restart to finish updating'],
    ])('labels the %s state honestly when the version gap is already closed', (status, label) => {
      renderShell('/p/cezarion/', nav(), { latestVersion: '0.14.9', applicationUpdate: { supported: true, status } as never, onRestart: async () => {} })
      fireEvent.click(menuButton())
      expect(drawer().querySelector('[data-slot="drawer-update"]')?.textContent).toContain(label)
    })

    it('says Preparing, not Restart, while a newer version is still downloading', () => {
      renderShell('/p/cezarion/', nav(), { latestVersion: '0.15.0', applicationUpdate: { supported: true, status: 'preparing' } as never })
      fireEvent.click(menuButton())
      const text = drawer().querySelector('[data-slot="drawer-update"]')?.textContent ?? ''
      expect(text).toContain('Preparing update…')
      expect(text).not.toContain('Restart to finish')
    })

    it('offers Restart, and hosts the feedback line, inside the row', () => {
      renderShell('/p/cezarion/', nav(), { latestVersion: '0.15.0', applicationUpdate: { supported: true, status: 'ready' } as never, onRestart: async () => {}, applicationUpdateError: 'Update failed.' })
      fireEvent.click(menuButton())
      const row = drawer().querySelector('[data-slot="drawer-update"]') as HTMLElement
      expect(within(row).getByRole('button', { name: 'Restart application' })).toBeTruthy()
      expect(row.textContent).toContain('Update failed.')
    })
  })

  describe('current project menu', () => {
    const trigger = () => within(document.querySelector('[data-slot="drawer-project-current"]') as HTMLElement).getByRole('button', { name: 'Project menu' })
    const open = () => fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false })

    it('puts a 44px … beside the current row only, never inside its link', () => {
      renderShell('/p/cezarion/', nav())
      fireEvent.click(menuButton())
      expect(document.querySelectorAll('[data-slot="project-menu-trigger"]')).toHaveLength(1)
      expect(trigger().className).toContain('size-[44px]')
      expect(rows()[0]!.contains(trigger())).toBe(false)
      expect(rows()[0]!.parentElement).toBe(trigger().parentElement)
      // Other rows stay bare links.
      expect(rows()[1]!.parentElement?.getAttribute('data-slot')).toBe('drawer-projects-group')
    })

    it('opens the shared menu: Mark all read, Open in, Copy path, Project settings', async () => {
      renderShell('/p/cezarion/', nav())
      fireEvent.click(menuButton())
      open()
      expect(await screen.findByRole('menuitem', { name: /Mark all read/ })).toBeTruthy()
      expect(screen.getByRole('menuitem', { name: /Open in/ })).toBeTruthy()
      expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeTruthy()
      expect(screen.getByRole('menuitem', { name: 'Project settings' }).getAttribute('href')).toBe('/p/cezarion/settings')
    })

    it('keeps the same localHandoff gate: no host actions remotely', async () => {
      renderShell('/p/cezarion/', nav(), {}, false)
      fireEvent.click(menuButton())
      open()
      await screen.findByRole('menuitem', { name: /Mark all read/ })
      expect(screen.queryByRole('menuitem', { name: 'Copy path' })).toBeNull()
      expect(screen.queryByRole('menuitem', { name: /Open in/ })).toBeNull()
      expect(screen.getByRole('menuitem', { name: 'Project settings' })).toBeTruthy()
    })

    it('closes the drawer when Project settings navigates', async () => {
      renderShell('/p/cezarion/', nav())
      fireEvent.click(menuButton())
      open()
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Project settings' }))
      await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/cezarion/settings'))
      await waitFor(() => expect(drawer()).toBeNull())
    })
  })

  it('renders without project data, keeping identity and global rows', () => {
    renderShell('/settings/global', null, { repo: null })
    fireEvent.click(menuButton())
    expect(drawer().querySelector('[data-slot="drawer-projects"]')).toBeNull()
    expect(drawer().querySelector('[data-slot="drawer-identity"]')).not.toBeNull()
    expect(drawer().querySelector('[data-slot="drawer-global"]')).not.toBeNull()
  })
})
