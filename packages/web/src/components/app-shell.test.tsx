import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Link as RouterLink, MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell, routeOwnsScrollArrival, type AppShellProps } from './app-shell'
import { NAV_ITEMS } from './nav-items'
import { ThemeProvider } from './theme-provider'

afterEach(() => {
  cleanup()
  // The sidebar width is a real localStorage preference (#788) — one test's drag must not be the
  // next test's starting width.
  localStorage.clear()
})

// jsdom ships no `matchMedia`; the ThemeProvider wrapping the footer toggle needs one.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  )
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
})

/** Mount the shell at a URL, exactly as a cold-loaded deep link would.
 *
 *  jsdom has no layout engine and no media queries: nothing here can (or pretends to) measure a
 *  breakpoint. Responsive behavior is asserted structurally — the elements and the responsive
 *  classes that carry them — and verified for real in the e2e suite at an iPhone viewport.
 */
function renderShell(entry = '/', props: Partial<AppShellProps> = {}, children: ReactNode = <p>route content</p>) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <AppShell {...props}>
          {children}
          <LocationProbe />
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>
  )
}

/** Makes the current URL assertable, so a "the drawer closed" test can also prove the click it
 *  fired actually navigated rather than merely dismissing the drawer. */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

const nav = () => screen.getByRole('navigation', { name: 'Main' })
const sidebar = () => document.querySelector('[data-slot="sidebar"]') as HTMLElement
const footer = () => document.querySelector('[data-slot="sidebar-footer"]') as HTMLElement
const allNavLinks = (root = sidebar()) => Array.from(root.querySelectorAll<HTMLAnchorElement>('nav a'))

describe('AppShell', () => {
  it('keeps optional views in an overflow menu and marks the current overflow view', async () => {
    renderShell('/inbox', { inboxCount: 2 })
    expect(within(nav()).queryByRole('link', { name: 'Inbox' })).toBeNull()
    const more = within(nav()).getByRole('button', { name: 'More views' })
    expect(more.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(more, { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: /Inbox/ })).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Automations' }))
    expect(screen.getByTestId('location').textContent).toBe('/automations')
  })

  it('omits overflow when no optional view is available and keeps version in footer', () => {
    renderShell('/', { inboxAvailable: false, automationsAvailable: true, forgeAvailable: false, version: '1.2.3' })
    expect(within(nav()).queryByRole('button', { name: 'More views' })).toBeNull()
    expect(within(nav()).queryByRole('link', { name: 'GitHub' })).toBeNull()
    expect(footer().querySelector('[data-slot="version-chip"]')?.textContent).toBe('v1.2.3')
  })

  it('shows the running version in the footer and only offers a newer local release', () => {
    renderShell('/', { version: '1.2.9', latestVersion: '1.2.10', applicationUpdate: { status: 'idle', supported: true }, onApplyUpdate: vi.fn() })
    const brand = footer()
    expect(brand?.querySelector('[data-slot="version-chip"]')?.textContent).toBe('v1.2.9')
    expect(within(sidebar()).getByRole('button', { name: /update/i }).getAttribute('title')).toBe('Update from v1.2.9 to v1.2.10')
    cleanup()
    renderShell('/', { version: '1.2.10', latestVersion: '1.2.9', applicationUpdate: { status: 'idle', supported: true }, onApplyUpdate: vi.fn() })
    expect(within(sidebar()).queryByRole('button', { name: /update/i })).toBeNull()
    cleanup()
    renderShell('/', { version: '1.2.10', latestVersion: '1.2.10', applicationUpdate: { status: 'idle', supported: true }, onApplyUpdate: vi.fn() })
    expect(within(sidebar()).queryByRole('button', { name: /update/i })).toBeNull()
    cleanup()
    renderShell('/', { version: '1.2.10', applicationUpdate: { status: 'idle', supported: true }, onApplyUpdate: vi.fn() })
    expect(within(sidebar()).queryByRole('button', { name: /update/i })).toBeNull()
  })

  it('shows the update versions in a keyboard tooltip', async () => {
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'idle', supported: true }, onApplyUpdate: vi.fn() })
    fireEvent.focus(within(sidebar()).getByRole('button', { name: 'Update application' }))
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('Update from v1.0.0 to v2.0.0'))
  })

  it('does not reserve an empty update action or show manual guidance without a newer release', () => {
    renderShell('/', { version: '0.14.8-pr501.7.abcdef', latestVersion: '0.14.8', applicationUpdate: { status: 'idle', supported: false, message: 'Update this installation manually.' } })
    expect(sidebar().querySelector('[data-slot="application-update-action"]')).toBeNull()
    expect(sidebar().querySelector('[data-slot="application-update-feedback"]')).toBeNull()
    expect(within(sidebar()).queryByText('Update this installation manually.')).toBeNull()
  })

  it('explains manual updates beside the version only when a newer release exists', () => {
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'idle', supported: false, message: 'Update this installation manually.' } })
    const header = footer()
    expect(header).not.toBeNull()
    expect(within(header).getByRole('status').textContent).toContain('In-app updates are unavailable for this installation.')
    expect(within(header).getByRole('status').textContent).toContain('Install the newer release using your original installation method, then restart Cezarion.')
    expect(header.querySelector('[data-slot="version-chip"]')?.textContent).toBe('v1.0.0')
    expect(within(sidebar()).queryByRole('button', { name: /update|restart/i })).toBeNull()
  })

  it('keeps update progress and errors with the version in the footer', () => {
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'error', supported: true, message: 'Preparation failed.' }, onApplyUpdate: vi.fn() })
    expect(footer().querySelector('[data-slot="application-update-feedback"]')?.textContent).toContain('Preparation failed.')
  })

  it('keeps ready state until Restart Now is confirmed', async () => {
    const restart = vi.fn().mockResolvedValue(undefined)
    renderShell('/', { version: '1.0.0', applicationUpdate: { status: 'ready', supported: true, targetVersion: '2.0.0' }, onRestart: restart })
    const trigger = within(sidebar()).getByRole('button', { name: /restart/i })
    expect(trigger.getAttribute('title')).toBe('Restart required')
    fireEvent.click(trigger)
    expect(screen.getByRole('alertdialog').textContent).toMatch(/running tasks.*recovered/i)
    fireEvent.click(screen.getByRole('button', { name: 'Restart Later' }))
    expect(restart).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Restart Now' }))
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('keeps the action unavailable when health is unknown or update is unsupported', () => {
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0' })
    expect(within(sidebar()).queryByRole('button', { name: /update|restart/i })).toBeNull()
    cleanup()
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'idle', supported: false, message: 'Use your host’s deployment process.' } })
    expect(within(sidebar()).queryByRole('button', { name: /update|restart/i })).toBeNull()
    expect(within(sidebar()).getByRole('status').textContent).toContain('Use your host’s deployment process.')
    cleanup()
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'ready', supported: false, targetVersion: '2.0.0' }, onRestart: vi.fn() })
    expect(within(sidebar()).queryByRole('button', { name: /update|restart/i })).toBeNull()
    cleanup()
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'ready', supported: true, targetVersion: '2.0.0' } })
    expect((within(sidebar()).getByRole('button', { name: /restart/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows preparation in the reserved action and leaves it unavailable', () => {
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'preparing', supported: true, targetVersion: '2.0.0' }, onApplyUpdate: vi.fn() })
    const action = within(sidebar()).getByRole('button', { name: 'Preparing update' })
    expect(action.getAttribute('aria-busy')).toBe('true')
    expect((action as HTMLButtonElement).disabled).toBe(true)
    expect(within(sidebar()).getByRole('status').textContent).toMatch(/preparing update/i)
  })

  it('shows a visible retry and manual next step after a failed update', () => {
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'error', supported: true, message: 'Preparation failed.' }, onApplyUpdate: vi.fn() })
    const message = within(sidebar()).getByRole('status')
    expect(message.textContent).toMatch(/Preparation failed.*Retry or update manually/i)
    expect(message.className).not.toContain('sr-only')
    expect(message.className).not.toContain('line-clamp')
  })

  it('blocks duplicate update clicks while the first request is pending', () => {
    const apply = vi.fn(() => new Promise<void>(() => {}))
    renderShell('/', { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'idle', supported: true }, onApplyUpdate: apply })
    const action = within(sidebar()).getByRole('button', { name: 'Update application' })
    fireEvent.click(action)
    fireEvent.click(action)
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it('renders the routed view in the main region', () => {
    renderShell('/', {}, <p>route content</p>)
    expect(within(screen.getByRole('main')).getByText('route content')).toBeTruthy()
  })

  it('shows project identity instead of a sidebar wordmark', () => {
    renderShell('/', { repo: { name: 'Demo', branch: 'main' } })
    expect(within(sidebar()).getByText('Demo')).toBeTruthy()
    expect(sidebar().querySelector('[data-slot="brand-wordmark"]')).toBeNull()
  })

  it('shows project identity in light mode', () => {
    localStorage.setItem('cez-theme', 'light')
    renderShell('/', { repo: { name: 'Demo', branch: 'main' } })
    expect(within(sidebar()).getByText('Demo')).toBeTruthy()
  })

  it('resets the main scroller to the top on navigation (#mobile-scroll-top)', () => {
    renderShell('/')
    const main = screen.getByRole('main')
    main.scrollTop = 640
    expect(main.scrollTop).toBe(640) // jsdom kept the write — the reset below is the effect's
    fireEvent.click(within(nav()).getByRole('link', { name: 'GitHub' }))
    expect(screen.getByTestId('location').textContent).toBe('/github')
    expect(main.scrollTop).toBe(0)
  })

  it.each([
    ['/github', '/github/issues/42'],
    ['/github/prs', '/github/prs/43'],
    ['/p/cezar/github', '/p/cezar/github/issues/42'],
  ])('keeps the main scroller on a GitHub item hop from %s to %s (#580)', (from, to) => {
    renderShell(from, {}, <RouterLink to={to}>Open item</RouterLink>)
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(main).getByRole('link', { name: 'Open item' }))

    expect(screen.getByTestId('location').textContent).toBe(to)
    expect(main.scrollTop).toBe(640)
  })

  it('resets the main scroller when leaving GitHub for Tasks (#580)', () => {
    renderShell('/github/issues/42', {}, <RouterLink to="/tasks">Tasks</RouterLink>)
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(main).getByRole('link', { name: 'Tasks' }))

    expect(screen.getByTestId('location').textContent).toBe('/tasks')
    expect(main.scrollTop).toBe(0)
  })

  it('resets the main scroller when GitHub navigation switches projects (#580)', () => {
    renderShell('/p/alpha/github/issues/42', {}, <RouterLink to="/p/beta/github/issues/43">Other project</RouterLink>)
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(main).getByRole('link', { name: 'Other project' }))

    expect(screen.getByTestId('location').textContent).toBe('/p/beta/github/issues/43')
    expect(main.scrollTop).toBe(0)
  })

  it('leaves task-to-task arrival to the destination transcript owner (#761)', () => {
    renderShell(
      '/tasks/source',
      {},
      <RouterLink to="/tasks/destination">Switch task</RouterLink>,
    )
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(main).getByRole('link', { name: 'Switch task' }))

    expect(screen.getByTestId('location').textContent).toBe('/tasks/destination')
    expect(main.scrollTop).toBe(640)
  })

  it.each([
    ['/git?view=repo', '/git'],
    ['/git', '/git?view=repo'],
  ])('resets the main scroller on the Git worktree/repository switch %s to %s', (from, to) => {
    renderShell(from, {}, <RouterLink to={to}>Switch Git view</RouterLink>)
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(main).getByRole('link', { name: 'Switch Git view' }))

    expect(main.scrollTop).toBe(0)
  })

  it('keeps the main scroller for an unrelated Git search change', () => {
    renderShell('/git', {}, <RouterLink to="/git?other=1">Filter</RouterLink>)
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(main).getByRole('link', { name: 'Filter' }))

    expect(main.scrollTop).toBe(640)
  })

  it('restores the generic top reset when leaving a task thread (#761)', () => {
    renderShell('/tasks/source')
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(nav()).getByRole('link', { name: 'GitHub' }))

    expect(screen.getByTestId('location').textContent).toBe('/github')
    expect(main.scrollTop).toBe(0)
  })

  it('grants scroll ownership only to exact scoped and unscoped main task routes', () => {
    expect(routeOwnsScrollArrival('/tasks/run-1')).toBe(true)
    expect(routeOwnsScrollArrival('/p/cezar/tasks/run-1')).toBe(true)
    expect(routeOwnsScrollArrival('/tasks/run-1/changes')).toBe(false)
    expect(routeOwnsScrollArrival('/p/cezar/tasks/run-1/files')).toBe(false)
    expect(routeOwnsScrollArrival('/tasks')).toBe(false)
  })

  it('renders primary views as named router links', () => {
    renderShell()
    const links = allNavLinks()
    expect(links.map(a => a.getAttribute('aria-label'))).toEqual(['Tasks', 'Git', 'GitHub', 'Skills', 'Workflows', 'Settings'])
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/', '/git', '/github', '/skills', '/workflows', '/settings'])
  })

  // R6 Step 1.1: no forge, no GitHub tab — the nav item disappears entirely (spec's
  // degradation table), it does not render disabled.
  it('drops the GitHub item when the forge is unavailable', () => {
    renderShell('/', { forgeAvailable: false })
    const links = allNavLinks()
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/github')
    expect(links).toHaveLength(5)
  })

  // #801: same degradation for the opt-in automations capability — the item disappears, it does
  // not render disabled. The two gates on that item are independent: a forge alone is not enough.
  it('drops the Automations item when the capability is off', () => {
    renderShell('/', { automationsAvailable: false })
    const links = allNavLinks()
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/automations')
    expect(links).toHaveLength(6)
  })

  it('shows Automations in overflow once the capability is on', async () => {
    renderShell('/', { automationsAvailable: true })
    fireEvent.keyDown(within(nav()).getByRole('button', { name: 'More views' }), { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: 'Automations' })).getAttribute('href')).toBe('/automations')
  })

  describe('active nav state follows the current route', () => {
    const cases: Array<[entry: string, active: string]> = [
      ['/', 'Tasks'],
      ['/git', 'Git'],
      ['/skills', 'Skills'],
      // Tasks stays lit while a task thread is open (spec's "Task list & table").
      ['/tasks/abc123', 'Tasks'],
    ]

    for (const [entry, active] of cases) {
      it(`${entry} → ${active}`, () => {
        renderShell(entry)
        const current = within(nav()).getAllByRole('link', { current: 'page' })
        // Exactly one — two lit rows is as wrong as none.
        expect(current).toHaveLength(1)
        expect(current[0]?.textContent).toBe(active)
      })
    }

    it('lights nothing on a full-screen surface like /new', () => {
      renderShell('/new')
      expect(within(nav()).queryAllByRole('link', { current: 'page' })).toHaveLength(0)
    })
  })

  describe('New task button', () => {
    it('links to /new', () => {
      renderShell()
      const link = within(sidebar()).getByRole('link', { name: /New task/ })
      expect(link.getAttribute('href')).toBe('/new')
      expect(link.className).toContain('text-[13px]')
    })

    it('renders the C hint (the browser-usable accelerator; ⌘N only fires in the desktop shell)', () => {
      renderShell()
      const link = within(sidebar()).getByRole('link', { name: /New task/ })
      expect(within(link).getByText('C').tagName).toBe('KBD')
    })
  })

  describe('Add project menu', () => {
    it('lives on the rail rather than in the sidebar', () => {
      renderShell()
      expect(within(sidebar()).queryByRole('button', { name: 'Add project' })).toBeNull()
    })

    it('is omitted in single-project mode while normal navigation remains', () => {
      renderShell('/')
      expect(within(sidebar()).queryByRole('button', { name: 'Add project' })).toBeNull()
      expect(within(nav()).getByRole('link', { name: 'Tasks' })).toBeTruthy()
      expect(within(sidebar()).getByRole('link', { name: /New task/ })).toBeTruthy()
    })
  })

  it('does not duplicate the rail theme toggle in the sidebar', () => {
    renderShell()
    expect(within(footer()).queryByRole('button', { name: /^Theme:/ })).toBeNull()
  })

  describe('sidebar search and footer chrome', () => {
    const controls = () =>
      document.querySelector('[data-slot="sidebar-footer-controls"]') as HTMLElement

    it('keeps the footer controls in one non-wrapping row', () => {
      renderShell()
      expect(footer().className).not.toContain('flex-wrap')
    })

    it('keeps search near the wordmark and outside the footer', () => {
      renderShell('/', { version: '1.2.3' })
      const content = sidebar().querySelector('[data-slot="sidebar-content"]') as HTMLElement
      const search = content.querySelector('[data-slot="command-palette-hint"]') as HTMLElement
      expect(search).toBeTruthy()
      expect(footer().contains(search)).toBe(false)
      expect(footer().firstElementChild?.getAttribute('data-slot')).toBe('sidebar-footer-controls')
    })

    it('keeps tools and version together in the footer', () => {
      renderShell('/', { version: '1.2.3', toolsMenu: <button type="button">Tools</button> })
      expect(within(controls()).getByRole('button', { name: 'Tools' })).toBeTruthy()
      expect(controls().querySelector('[data-slot="version-chip"]')?.textContent).toBe('v1.2.3')
    })

    it('renders search as a full-width launcher that still opens the palette', () => {
      renderShell()
      // Named by its own visible label, not by an aria-label that would diverge from it
      // (WCAG 2.5.3) — jsdom reports no `navigator.platform`, so the chord reads Ctrl+K.
      const search = within(sidebar()).getByRole('button', { name: 'Search…' })
      expect(search.dataset.slot).toBe('command-palette-hint')
      expect(search.className).toContain('w-full')
      expect(search.className).toContain('text-[13px]')
      expect(search.className).not.toContain('text-xs')
      expect(search.textContent).toContain('Search…')
      expect(search.querySelector('kbd')?.textContent).toBe('Ctrl+K')
      expect(search.querySelector('kbd')?.className).toContain('text-[11.5px]')

      const opened = vi.fn()
      window.addEventListener('cezar:open-command-palette', opened)
      fireEvent.click(search)
      window.removeEventListener('cezar:open-command-palette', opened)
      expect(opened).toHaveBeenCalledTimes(1)
    })

    it('shows the version chip update affordance in the header', () => {
      renderShell('/', { version: '1.2.3', latestVersion: '1.3.0' })
      const chip = sidebar().querySelector('[data-slot="version-chip"]') as HTMLElement
      expect(chip.getAttribute('data-update-available')).toBe('true')
      expect(chip.querySelector('[data-slot="status-dot"]')).not.toBeNull()
    })

    /* The two-row footer holds only while something in the controls row can give: every icon
     * button is `shrink-0` (button base class), so a long version string — `0.9.2-nightly.…`,
     * the nightly dist-tag of #876 — used to push the gear and the toggle outside the 264px
     * column entirely. jsdom still measures nothing; what it can pin is which item yields. */
    it('makes the version chip the one control that gives, so a nightly version cannot push the row out', () => {
      renderShell('/', {
        version: '0.9.2-nightly.20260813.1',
        toolsMenu: <button type="button">Tools</button>,
      })
      const chip = sidebar().querySelector('[data-slot="version-chip"]') as HTMLElement
      expect(chip.className).not.toContain('shrink-0')
      expect(chip.className).toContain('min-w-0')
      // The text truncates inside the pill rather than widening it past what the row can hold.
      const label = chip.querySelector('span:not([data-slot])') as HTMLElement
      expect(label.className).toContain('truncate')
      expect(label.textContent).toBe('v0.9.2-nightly.20260813.1')
      // …and the full string stays legible on hover, since the visible one may be clipped.
      expect(chip.getAttribute('title')).toBe('v0.9.2-nightly.20260813.1')
      expect(controls().contains(chip)).toBe(true)
      expect(within(controls()).getByRole('button', { name: 'Tools' })).toBeTruthy()
    })
  })

  describe('data slots stay empty rather than showing invented data', () => {
    it('renders no repo chip, badge or version chip when unfed', () => {
      renderShell()
      expect(document.querySelector('[data-slot="repo-chip"]')).toBeNull()
      expect(document.querySelector('[data-slot="nav-badge"]')).toBeNull()
      expect(document.querySelector('[data-slot="version-chip"]')).toBeNull()
    })

    it('renders the repo chip and version chip from props', () => {
      renderShell('/', { repo: { name: 'cezar', branch: 'main' }, version: '1.2.3' })
      expect(within(sidebar()).getByText('cezar')).toBeTruthy()
      // The chip prefixes the raw semver from /api/v1/health — `v1.2.3`, mono, muted.
      expect(within(sidebar()).getByText('v1.2.3')).toBeTruthy()
    })

    describe('version chip update affordance (#368)', () => {
      const chip = () => document.querySelector('[data-slot="version-chip"]') as HTMLElement

      it('stays plain while the registry has nothing newer', () => {
        renderShell('/', { version: '1.2.3' })
        expect(chip().getAttribute('data-update-available')).toBeNull()
        // A tooltip, but one that claims nothing: the chip truncates, so the full version has to
        // stay reachable on hover even when there is no update to announce.
        expect(chip().getAttribute('title')).toBe('v1.2.3')
        expect(chip().querySelector('[data-slot="status-dot"]')).toBeNull()
      })

      it('stays plain when latestVersion equals the running version', () => {
        renderShell('/', { version: '1.2.3', latestVersion: '1.2.3' })
        expect(chip().getAttribute('data-update-available')).toBeNull()
        expect(chip().querySelector('[data-slot="status-dot"]')).toBeNull()
      })

      it('names the newer version without decorative pulsing', () => {
        renderShell('/', { version: '1.2.3', latestVersion: '1.3.0' })
        expect(chip().getAttribute('data-update-available')).toBe('true')
        expect(chip().getAttribute('title')).toBe('v1.2.3 — update available: v1.3.0')
        const dot = chip().querySelector('[data-slot="status-dot"]') as HTMLElement
        expect(dot.getAttribute('data-tone')).toBe('pending')
        expect(dot.className).not.toContain('animate-pulse')
        // The version shown is still the one actually running.
        expect(chip().textContent).toContain('v1.2.3')
      })
    })

    it('renders the Inbox count in overflow only for a non-zero count', async () => {
      renderShell('/', { inboxCount: 2 })
      expect(sidebar().querySelector('[data-slot="overflow-inbox-dot"]')).not.toBeNull()
      fireEvent.keyDown(within(nav()).getByRole('button', { name: 'More views' }), { key: 'Enter' })
      expect((await screen.findByRole('menuitem', { name: /Inbox/ })).textContent).toBe('Inbox2')
      cleanup()
      renderShell('/', { inboxCount: 0 })
      expect(sidebar().querySelector('[data-slot="overflow-inbox-dot"]')).toBeNull()
    })

    it('renders a quiet accessible Skills update marker in the desktop navigation only', () => {
      renderShell('/', { skillsUpdateAvailable: true })
      const markers = document.querySelectorAll('[data-slot="nav-update-marker"]')
      expect(markers).toHaveLength(1)
      for (const marker of markers) {
        expect(marker.getAttribute('aria-label')).toBe('Skills update available')
        expect(marker.innerHTML).not.toContain('animate-')
      }
      // The phone drawer carries no nav (#621): the marker's mobile home is the tab bar's More.
      fireEvent.click(screen.getByRole('button', { name: /^Open projects/ }))
      expect(document.querySelectorAll('[data-slot="nav-update-marker"]')).toHaveLength(1)
    })

    it('renders no Skills marker without an actionable update', () => {
      renderShell()
      expect(document.querySelector('[data-slot="nav-update-marker"]')).toBeNull()
    })

    it('reserves the quick-list, tools and composer slots for later Steps', () => {
      renderShell()
      for (const slot of ['task-quick-list', 'tools-menu', 'composer']) {
        expect(document.querySelector(`[data-slot="${slot}"]`)).not.toBeNull()
      }
    })
  })

  /** The global banner slot (#391). */
  it('leaves workspace controls to the rail and keeps the current task list scrollable', () => {
    renderShell('/p/shop/git', { taskQuickList: <p>Project tasks</p> })
    expect(sidebar().querySelector('[data-slot="all-tasks-link"]')).toBeNull()
    const scroller = sidebar().querySelector('[data-slot="project-task-navigation"]') as HTMLElement
    expect(scroller.textContent).toContain('Project tasks')
    expect(scroller.className).toContain('overflow-y-auto')
  })

  describe('banner slot', () => {
    it('renders the banner when one is passed', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const slot = document.querySelector('[data-slot="banner-slot"]') as HTMLElement
      expect(slot).not.toBeNull()
      expect(within(slot).getByText('banner content')).toBeTruthy()
    })

    it('renders nothing when absent — no empty slot to push the scroller down', () => {
      renderShell()
      expect(document.querySelector('[data-slot="banner-slot"]')).toBeNull()
    })

    // The regression the slot was born with: as the first child of <main>, a sticky banner sat in
    // the same scrollport as every routed view's own `sticky top-0` header, which parked over it
    // (opaque, later in DOM, equal-or-higher z-index) and swallowed the clicks on its dismiss X.
    // Its own row instead — so the banner is chrome, above the scroller, not scrolled content.
    it('sits outside the scrolling main region, not inside it', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const slot = document.querySelector('[data-slot="banner-slot"]') as HTMLElement
      expect(screen.getByRole('main').contains(slot)).toBe(false)
      expect(slot.className).not.toContain('sticky')
    })

    it('is its own grid row, above the scroller and below the mobile bar', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const slot = document.querySelector('[data-slot="banner-slot"]') as HTMLElement
      const main = screen.getByRole('main')
      const column = main.parentElement as HTMLElement
      expect(column.className).toContain('grid-rows-[auto_auto_1fr_auto]')
      expect(slot.parentElement).toBe(column)
      expect(slot.className).toContain('row-start-2')
      // The scroller keeps the 1fr row, so the banner's height comes out of the shell's own
      // budget rather than making every `min-h-full` route overflow by exactly the banner.
      expect(main.className).toContain('row-start-3')
    })
  })

  /** jsdom cannot evaluate `md:` — so assert the structure and the responsive classes that
   *  encode it, and leave "does it actually reflow at 390px" to the e2e iPhone screenshot. */
  describe('responsive skeleton', () => {
    it('hides the sidebar below md and shows it from md up', () => {
      renderShell()
      expect(sidebar().className).toContain('hidden')
      expect(sidebar().className).toContain('md:flex')
    })

    it('shows the mobile top bar below md only', () => {
      renderShell()
      const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
      expect(bar).not.toBeNull()
      expect(bar.className).toContain('md:hidden')
    })

    it('titles the mobile bar from the active route', () => {
      renderShell('/skills')
      const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
      const title = within(bar).getByText('Skills')
      expect(title.className).not.toContain('sr-only')
    })

  })

  /** The resizable desktop column (#788, option C). jsdom has no layout engine, so these assert
   *  the state machine and the accessibility contract; the drag itself is exercised for real in
   *  `e2e/sidebar-resize.e2e.ts`. */
  describe('resizable sidebar', () => {
    const handle = () => document.querySelector('[data-slot="sidebar-resize-handle"]') as HTMLElement

    /** jsdom implements neither pointer capture nor `PointerEvent`'s coordinates on the synthetic
     *  events React dispatches, so the capture calls are stubbed and the moves are fired as the
     *  mouse events jsdom does construct — React routes `onPointerDown`/`onPointerMove` from
     *  them, which is exactly what a real pointer produces. */
    function drag(from: number, to: number) {
      const el = handle()
      el.setPointerCapture = vi.fn()
      el.releasePointerCapture = vi.fn()
      el.hasPointerCapture = vi.fn(() => true)
      fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from })
      fireEvent.pointerMove(el, { pointerId: 1, clientX: to })
      fireEvent.pointerUp(el, { pointerId: 1, clientX: to })
    }

    it('mounts the project rail beside the sidebar, outside its width, and drags leave it alone (#618)', () => {
      renderShell('/', { projectRail: <nav aria-label="Projects" data-slot="project-rail" /> })
      const rail = document.querySelector('[data-slot="project-rail"]') as HTMLElement
      expect(rail.parentElement).toBe(sidebar().parentElement)
      expect(rail.nextElementSibling).toBe(sidebar())
      expect(sidebar().contains(rail)).toBe(false)
      drag(264, 300)
      expect(sidebar().style.width).toBe('300px')
      expect(rail.style.width).toBe('')
    })

    it('renders no rail when the slot is empty', () => {
      renderShell()
      expect(document.querySelector('[data-slot="project-rail"]')).toBeNull()
    })

    it('starts at the approved 264px when nothing has been stored', () => {
      renderShell()
      expect(sidebar().style.width).toBe('264px')
      // No Tailwind width class left behind to fight the inline one.
      expect(sidebar().className).not.toContain('w-[264px]')
    })

    it('restores the width the browser remembers', () => {
      localStorage.setItem('cez-sidebar-width', '350')
      renderShell()
      // First paint, not an effect: a jump from 264 to 350 would be visible on every load.
      expect(sidebar().style.width).toBe('350px')
    })

    it('is a keyboard-operable separator that reports its range', () => {
      renderShell()
      const el = handle()
      expect(el.getAttribute('role')).toBe('separator')
      expect(el.getAttribute('aria-orientation')).toBe('vertical')
      expect(el.getAttribute('aria-label')).toBe('Resize the sidebar')
      expect(el.tabIndex).toBe(0)
      expect(el.getAttribute('aria-valuenow')).toBe('264')
      expect(el.getAttribute('aria-valuemin')).toBe('264')
      expect(el.getAttribute('aria-valuemax')).toBe('420')
    })

    it('widens on drag and persists what it landed on', () => {
      renderShell()
      drag(264, 344)
      expect(sidebar().style.width).toBe('344px')
      expect(handle().getAttribute('aria-valuenow')).toBe('344')
      expect(localStorage.getItem('cez-sidebar-width')).toBe('344')
    })

    it('clamps a drag at both bounds rather than letting the column collapse or take over', () => {
      renderShell()
      drag(264, 3000)
      expect(sidebar().style.width).toBe('420px')
      drag(420, -3000)
      expect(sidebar().style.width).toBe('264px')
    })

    it('takes focus on grab, so the arrow keys work right after a mouse drag', () => {
      // `preventDefault()` on pointerdown (which stops the drag selecting the sidebar's text)
      // also suppresses the focus a press would otherwise give a tabIndex=0 element.
      renderShell()
      drag(264, 320)
      expect(document.activeElement).toBe(handle())
      fireEvent.keyDown(handle(), { key: 'ArrowRight' })
      expect(sidebar().style.width).toBe('336px')
    })

    it('opts out of browser touch panning, so a touch drag resizes instead of scrolling', () => {
      renderShell()
      expect(handle().className).toContain('touch-none')
    })

    it('ignores a non-primary button, so a right-click on the border resizes nothing', () => {
      renderShell()
      const el = handle()
      el.setPointerCapture = vi.fn()
      fireEvent.pointerDown(el, { button: 2, pointerId: 1, clientX: 264 })
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 400 })
      expect(sidebar().style.width).toBe('264px')
      expect(el.setPointerCapture).not.toHaveBeenCalled()
    })

    it('steps with the arrow keys and jumps to the bounds with Home/End', () => {
      renderShell()
      fireEvent.keyDown(handle(), { key: 'ArrowRight' })
      expect(sidebar().style.width).toBe('280px')
      fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
      expect(sidebar().style.width).toBe('264px')
      fireEvent.keyDown(handle(), { key: 'End' })
      expect(sidebar().style.width).toBe('420px')
      fireEvent.keyDown(handle(), { key: 'Home' })
      expect(sidebar().style.width).toBe('264px')
      expect(localStorage.getItem('cez-sidebar-width')).toBe('264')
    })

    it('leaves every other key to the browser — Tab must still move focus', () => {
      renderShell()
      const event = createEvent.keyDown(handle(), { key: 'Tab' })
      fireEvent(handle(), event)
      expect(event.defaultPrevented).toBe(false)
      expect(sidebar().style.width).toBe('264px')
    })

    it('resets to the default on double-click', () => {
      localStorage.setItem('cez-sidebar-width', '400')
      renderShell()
      expect(sidebar().style.width).toBe('400px')
      fireEvent.doubleClick(handle())
      expect(sidebar().style.width).toBe('264px')
      expect(localStorage.getItem('cez-sidebar-width')).toBe('264')
    })

    it('keeps the drawer independent of desktop resizing and reserves its dismissal strip', () => {
      localStorage.setItem('cez-sidebar-width', '400')
      renderShell('/', { taskQuickList: <p>list</p> })
      fireEvent.click(screen.getByRole('button', { name: /^Open projects/ }))
      const drawer = document.querySelector('[data-slot="mobile-nav-drawer"]') as HTMLElement
      expect(drawer.className).toContain('w-[calc(100%-68px)]')
      expect(drawer.className).toContain('max-w-[334px]')
      expect(drawer.style.width).toBe('')
      expect(within(drawer).queryByRole('separator', { name: 'Resize the sidebar' })).toBeNull()
    })

    it('declares the container the rows size their metadata against', () => {
      // The width-priority rule in `task-quick-list.tsx` drops metadata with an
      // `@min-[…]/sidebar:` query; without this container it has nothing to query.
      renderShell()
      const content = sidebar().querySelector('[data-slot="sidebar-content"]') as HTMLElement
      expect(content.className).toContain('@container/sidebar')
    })
  })

  /** The layout contract from the spec. These classes are the whole reason the cockpit does not
   *  scroll its document or clip its composer on an iPhone — a refactor that drops one is a
   *  regression no visual test would catch on a desktop viewport. */
  describe('layout contract', () => {
    it('is exactly one viewport tall and never scrolls the document', () => {
      renderShell()
      const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
      // h-dvh, not h-screen: 100vh ignores mobile browser chrome.
      expect(shell.className).toContain('h-dvh')
      expect(shell.className).not.toContain('h-screen')
      expect(shell.className).toContain('overflow-hidden')
    })

    it('makes the main region the only scroller, and contains its overscroll', () => {
      renderShell()
      const main = screen.getByRole('main')
      expect(main.className).toContain('overflow-y-auto')
      expect(main.className).toContain('overscroll-contain')
    })

    it('pads for safe areas and lets the keyboard reserve the composer row', () => {
      renderShell()
      const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
      expect(shell.className).toContain('pl-[env(safe-area-inset-left)]')

      const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
      expect(bar.className).toContain('pt-[env(safe-area-inset-top)]')

      // The composer row keeps the home-indicator gutter while empty, and yields to the
      // published keyboard inset when that obstruction is taller.
      const composer = document.querySelector('[data-slot="composer"]') as HTMLElement
      expect(composer.className).toContain(
        'pb-[max(env(safe-area-inset-bottom),var(--kb,0px))]',
      )
    })
  })

  describe('banner slot', () => {
    const bannerSlot = () => document.querySelector('[data-slot="banner-slot"]')

    it('renders nothing when no banner is passed', () => {
      renderShell()
      expect(bannerSlot()).toBeNull()
    })

    it('renders the banner above the routed view', () => {
      renderShell('/', { banner: <p>promo</p> })
      expect(screen.getByText('promo')).not.toBeNull()
    })

    // The regression guard for the #391 QA defect: the banner first shipped as `sticky top-0
    // z-10` *inside* `main`, where routed views' own `sticky top-0` headers (z-10 and z-20) sit
    // later in the DOM and painted over it — the banner vanished on scroll and its dismiss
    // button stopped being clickable on every route. Keeping the slot a sibling of the scroller
    // is what makes that unrepresentable; nesting it back inside `main` fails here.
    it('is a peer of the scroller, not a child of it, so route headers cannot paint over it', () => {
      renderShell('/', { banner: <p>promo</p> })
      const slot = bannerSlot() as HTMLElement
      const main = screen.getByRole('main')

      expect(main.contains(slot)).toBe(false)
      expect(slot.parentElement).toBe(main.parentElement)

      // Its own grid row, so it holds its space instead of sticking to the scroller's edge.
      expect(slot.className).toContain('row-start-2')
      expect(main.className).toContain('row-start-3')
      expect(slot.className).not.toContain('sticky')
    })
  })

  /** The `<md` drawer (spec: "Sidebar becomes an overlay drawer … backdrop").
   *
   *  jsdom still cannot evaluate `md:`, so the drawer is always openable here — the button that
   *  opens it is what CSS hides on desktop, and the e2e suite proves that at 390px for real. What
   *  these tests do own is the state machine and the semantics, which no screenshot can check.
   */
  describe('mobile nav drawer', () => {
    const drawer = () => screen.queryByRole('dialog', { name: 'Navigation' })
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /^Open projects/ }))

    /** Radix arms its outside-pointer listener in a `setTimeout(…, 0)`, so a backdrop press fired
     *  in the same tick as the open would land before anything is listening. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    it('is closed until the menu button is pressed', () => {
      renderShell()
      expect(drawer()).toBeNull()
      openMenu()
      expect(drawer()).not.toBeNull()
    })

    it('is a dialog with an accessible name', () => {
      renderShell()
      openMenu()
      // A real dialog, not a div styled to look like one — the focus trap and the Escape
      // handling below are only meaningful because the role underneath them is real.
      expect(drawer()?.getAttribute('role')).toBe('dialog')
      // `getByRole('dialog', { name: 'Navigation' })` already proves the name resolves; this
      // pins down *how*, so dropping the sr-only SheetTitle fails here loudly.
      expect(drawer()?.getAttribute('aria-labelledby')).toBeTruthy()
    })

    it('advertises the drawer from the menu button', () => {
      renderShell()
      const menuButton = screen.getByRole('button', { name: /^Open projects/ })
      expect(menuButton.getAttribute('aria-haspopup')).toBe('dialog')
      expect(menuButton.getAttribute('aria-expanded')).toBe('false')

      openMenu()
      expect(menuButton.getAttribute('aria-expanded')).toBe('true')
      expect(menuButton.getAttribute('aria-controls')).toBe(drawer()?.id)
    })

    it('hides the rest of the tree from assistive tech while open', () => {
      renderShell()
      openMenu()

      // This is the modality, and it is worth asserting precisely because it is NOT spelled
      // `aria-modal`: Radix's Dialog does not set that attribute at all. It marks every sibling
      // of the portal `aria-hidden` instead (the `hideOthers` approach), which is the stronger
      // of the two and what actually makes AT ignore the shell behind the drawer.
      const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
      expect(shell.closest('[aria-hidden="true"]')).not.toBeNull()
      expect(drawer()?.closest('[aria-hidden="true"]')).toBeNull()
    })

    it('moves focus into the drawer and restores it to the menu button on close', async () => {
      renderShell()
      const menuButton = screen.getByRole('button', { name: /^Open projects/ })
      // A real pointer click focuses the button it hits; fireEvent.click does not. Without this
      // the drawer opens while focus is on <body>, and "restore" would restore to <body> — the
      // test would pass or fail on a jsdom artifact rather than on Radix's focus scope.
      menuButton.focus()
      openMenu()

      await waitFor(() => expect(drawer()?.contains(document.activeElement)).toBe(true))

      fireEvent.click(within(drawer() as HTMLElement).getByRole('button', { name: 'Close menu' }))
      await waitFor(() => expect(drawer()).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(menuButton))
    })

    it('closes on Escape', async () => {
      renderShell()
      openMenu()
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(drawer()).toBeNull())
    })

    it('closes when the backdrop is tapped', async () => {
      renderShell()
      openMenu()
      await settle()

      const overlay = document.querySelector('[data-slot="sheet-overlay"]')
      expect(overlay).not.toBeNull()

      // A whole tap, both halves. Radix defers a left-button dismissal from `pointerdown` to the
      // following `click` (so a drag that starts inside the drawer and releases over the backdrop
      // does not dismiss it), so a lone pointerDown here would assert nothing.
      fireEvent.pointerDown(overlay as Element)
      fireEvent.click(overlay as Element)
      await waitFor(() => expect(drawer()).toBeNull())
    })

    it('renders no SidebarContent: no nav, quick list, New task or search hint (#621)', () => {
      renderShell('/', { taskQuickList: <p>list</p> })
      openMenu()
      const root = drawer() as HTMLElement
      expect(root.querySelector('[data-slot="sidebar-content"]')).toBeNull()
      expect(within(root).queryByRole('navigation', { name: 'Main' })).toBeNull()
      expect(within(root).queryByRole('link', { name: 'Git' })).toBeNull()
      expect(within(root).queryByRole('link', { name: /New task/ })).toBeNull()
      expect(within(root).queryByText('list')).toBeNull()
      // The desktop sidebar still carries all of it.
      expect(allNavLinks().length).toBeGreaterThan(0)
    })

    it('closes when the Tools row navigates', async () => {
      renderShell('/', { toolsStatus: { blocked: false, note: null } })
      openMenu()
      fireEvent.click(within(drawer() as HTMLElement).getByRole('link', { name: 'Tools' }))
      // Both halves matter: an open drawer sitting on top of the newly routed view is the whole
      // bug this guards, and a drawer that closed without navigating would be just as wrong.
      await waitFor(() => expect(drawer()).toBeNull())
      expect(screen.getByTestId('location').textContent).toBe('/tools')
    })

    it('closes when the Tools row is re-clicked on /tools', async () => {
      // No pathname change, so the route-change effect cannot fire: the link's own onNavigate
      // is what has to close it.
      renderShell('/tools', { toolsStatus: { blocked: false, note: null } })
      openMenu()
      fireEvent.click(within(drawer() as HTMLElement).getByRole('link', { name: 'Tools' }))
      await waitFor(() => expect(drawer()).toBeNull())
      expect(screen.getByTestId('location').textContent).toBe('/tools')
    })

    it('shows no update row until a newer release exists, then one row with the action', () => {
      renderShell('/', { version: '1.0.0', latestVersion: '1.0.0' })
      openMenu()
      expect(drawer()?.querySelector('[data-slot="drawer-update"]')).toBeNull()
      expect(drawer()?.querySelector('[data-slot="drawer-version"]')?.textContent).toBe('v1.0.0')
    })

    it('renders the update row right under the identity row with the Update button', () => {
      renderShell('/', { version: '1.0.0', latestVersion: '1.2.0', applicationUpdate: { supported: true, status: 'idle' } as never, onApplyUpdate: async () => {} })
      openMenu()
      const identity = drawer()?.querySelector('[data-slot="drawer-identity"]') as HTMLElement
      const row = drawer()?.querySelector('[data-slot="drawer-update"]') as HTMLElement
      expect(identity.nextElementSibling).toBe(row)
      expect(row.textContent).toContain('Update available · v1.2.0')
      expect(within(row).getByRole('button', { name: 'Update application' })).toBeTruthy()
    })

    it('closes when the viewport widens past md, where the real sidebar takes over', async () => {
      // Otherwise an open drawer survives a rotation into a desktop-width layout and traps focus
      // in a modal copy of a sidebar that is now visible right next to it.
      const listeners = new Set<(event: MediaQueryListEvent) => void>()
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: false,
        media: query,
        addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
      }))

      renderShell()
      openMenu()
      expect(drawer()).not.toBeNull()

      // Every registered listener gets the event; only the shell's breakpoint one acts on it.
      for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent)
      await waitFor(() => expect(drawer()).toBeNull())
    })

    it('pads the drawer for the safe-area insets', () => {
      renderShell()
      openMenu()
      const root = drawer() as HTMLElement

      // The drawer is a full-height overlay under the same notch and home indicator as the
      // sidebar. Its identity row sits at the top and its global rows at the bottom, so those two
      // own the insets; the scroll between them takes none (it would double them).
      expect(root.querySelector('[data-slot="drawer-identity"]')?.className).toContain('pt-[env(safe-area-inset-top)]')
      expect(root.querySelector('[data-slot="drawer-global"]')?.className).toContain('env(safe-area-inset-bottom)')
      expect(root.querySelector('[data-slot="drawer-scroll"]')?.className).not.toContain('safe-area-inset')
      // The desktop sidebar keeps its own.
      expect((sidebar().querySelector('[data-slot="sidebar-content"]') as HTMLElement).className).toContain('pt-[env(safe-area-inset-top)]')
    })
  })
})

it('keeps project and page context in the desktop breadcrumb', () => {
  const { container } = renderShell('/p/demo/skills', { repo: { name: 'demo', branch: 'main' } })
  const breadcrumb = container.querySelector('[data-slot="desktop-breadcrumb"]')
  expect(breadcrumb).not.toBeNull()
  expect(breadcrumb?.textContent).toContain('demo')
  expect(breadcrumb?.textContent).toContain('Skills')
  expect(breadcrumb?.textContent).toContain('main')
})

it('opens project navigation from the mobile project control and restores its focus', async () => {
  renderShell('/p/demo/skills', { repo: { name: 'demo', branch: 'main' }, toolsStatus: { blocked: false, note: null } })
  const picker = screen.getByRole('button', { name: 'Switch project: demo' })
  picker.focus()
  fireEvent.click(picker)
  const drawer = document.querySelector('[data-slot="mobile-nav-drawer"]') as HTMLElement
  expect(drawer).not.toBeNull()
  expect(within(drawer).getByRole('link', { name: 'Tools' })).toBeTruthy()
  fireEvent.keyDown(drawer, { key: 'Escape' })
  await waitFor(() => expect(document.activeElement).toBe(picker))
  fireEvent.click(picker)
  fireEvent.click(within(document.querySelector('[data-slot="mobile-nav-drawer"]') as HTMLElement).getByRole('link', { name: 'Tools' }))
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tools'))
})

// Current 193-frame source has a taller Start/New task header; page/session frames
// explicitly retain 64px, including Git panes whose viewport caps deduct it.
it.each(['/new', '/p/iac/new'])('uses the source 72px Start header at %s', (route) => {
  const { container } = renderShell(route)
  expect(container.querySelector('[data-slot="desktop-breadcrumb"]')?.classList.contains('h-[72px]')).toBe(true)
  expect(container.querySelector('[data-slot="desktop-breadcrumb"]')?.classList.contains('px-11')).toBe(true)
})
it.each(['/skills', '/workflows', '/p/iac/runs/123', '/p/iac/git', '/settings/global'])('retains the source 64px page header at %s', (route) => {
  const { container } = renderShell(route)
  expect(container.querySelector('[data-slot="desktop-breadcrumb"]')?.classList.contains('h-16')).toBe(true)
})
