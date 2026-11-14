import { productName } from '@/lib/product-name'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Link as RouterLink, MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell, routeOwnsScrollArrival, type AppShellProps } from './app-shell'
import { ThemeProvider } from './theme-provider'

afterEach(() => {
  cleanup()
  // The sidebar width is a real localStorage preference (#788) — one test's drag must not be the
  // next test's starting width.
  localStorage.clear()
})

// jsdom ships no `matchMedia`; the ThemeProvider needs one.
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
    renderShell('/automations', { })
    const more = within(nav()).getByRole('button', { name: 'More views' })
    expect(more.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(more, { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: 'Automations' })).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflows' }))
    expect(screen.getByTestId('location').textContent).toBe('/workflows')
  })

  it('keeps Git in More and lights the More button on a Git route', async () => {
    renderShell('/git/commits', { })
    expect(within(nav()).queryByRole('link', { name: 'Git' })).toBeNull()
    const more = within(nav()).getByRole('button', { name: 'More views' })
    expect(more.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(more, { key: 'Enter' })
    const git = await screen.findByRole('menuitem', { name: 'Git' })
    expect(git.getAttribute('aria-current')).toBe('page')
    expect(git.getAttribute('href')).toBe('/git')
  })

  it('moves Workflows into More when six views would crowd the overflow button', async () => {
    renderShell('/workflows', { })
    expect(allNavLinks().map(a => a.getAttribute('aria-label'))).toEqual(['Tasks', 'Activity', 'GitHub', 'Skills', 'Settings'])
    const more = within(nav()).getByRole('button', { name: 'More views' })
    expect(more.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(more, { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: 'Workflows' })).getAttribute('aria-current')).toBe('page')
  })

  it.each([false, true])('keeps Reports beside Workflows in More with automations=%s', async automationsAvailable => {
    renderShell('/reports', { automationsAvailable })
    const more = within(nav()).getByRole('button', { name: 'More views' })
    expect(more.getAttribute('data-active')).toBe('true')
    expect(allNavLinks().map(a => a.getAttribute('aria-label'))).toEqual(['Tasks', 'Activity', 'GitHub', 'Skills', 'Settings'])
    fireEvent.keyDown(more, { key: 'Enter' })
    await screen.findByRole('menuitem', { name: 'Reports' })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Git', ...(automationsAvailable ? ['Automations'] : []), 'Workflows', 'Reports',
    ])
    expect(screen.getByRole('menuitem', { name: 'Reports' }).getAttribute('aria-current')).toBe('page')
  })

  it('keeps Reports overflow without optional views and keeps version in footer', () => {
    renderShell('/', { automationsAvailable: false, forgeAvailable: false, version: '1.2.3' })
    expect(within(nav()).queryByRole('button', { name: 'More views' })).not.toBeNull()
    expect(within(nav()).queryByRole('link', { name: 'GitHub' })).toBeNull()
    expect(footer().querySelector('[data-slot="version-chip"]')?.textContent).toBe('v1.2.3')
  })

  // A schedule needs no GitHub remote (#766): the opt-in alone makes Automations an optional view.
  it('offers overflow for Automations alone, with no forge', () => {
    renderShell('/', { automationsAvailable: true, forgeAvailable: false })
    expect(within(nav()).getByRole('button', { name: 'More views' })).not.toBeNull()
    expect(within(nav()).queryByRole('link', { name: 'GitHub' })).toBeNull()
  })

  it('shows the running version in the footer and marks a newer release', () => {
    renderShell('/', { version: '1.2.9', latestVersion: '1.2.10' })
    const chip = footer().querySelector('[data-slot="version-chip"]') as HTMLElement
    expect(chip.textContent).toBe('v1.2.9')
    expect(chip.getAttribute('data-update-available')).toBe('true')
    cleanup()
    renderShell('/', { version: '1.2.10', latestVersion: '1.2.9' })
    expect(footer().querySelector('[data-slot="version-chip"]')?.getAttribute('data-update-available')).toBeNull()
  })

  it('shows project identity in the sidebar', () => {
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
    // Reports always supplies More; Workflows shares it to keep five primary tabs.
    renderShell('/', { automationsAvailable: false })
    const links = allNavLinks()
    expect(links.map(a => a.getAttribute('aria-label'))).toEqual(['Tasks', 'Activity', 'GitHub', 'Skills', 'Settings'])
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/', '/activity', '/github', '/skills', '/settings'])
  })

  // R6 Step 1.1: no forge, no GitHub tab — the nav item disappears entirely (spec's
  // degradation table), it does not render disabled.
  it('drops the GitHub item when the forge is unavailable', () => {
    renderShell('/', { forgeAvailable: false })
    const links = allNavLinks()
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/github')
    expect(links).toHaveLength(4)
  })

  // #801: same degradation for the automations capability — the item disappears, it does
  // not render disabled. The two gates on that item are independent: a forge alone is not enough.
  it('drops the Automations item when the capability is off', () => {
    renderShell('/', { automationsAvailable: false })
    const links = allNavLinks()
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/automations')
    expect(links).toHaveLength(5)
  })

  it('shows Automations in overflow once the capability is on', async () => {
    renderShell('/', { automationsAvailable: true })
    fireEvent.keyDown(within(nav()).getByRole('button', { name: 'More views' }), { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: 'Automations' })).getAttribute('href')).toBe('/automations')
  })

  describe('active nav state follows the current route', () => {
    const cases: Array<[entry: string, active: string]> = [
      ['/', 'Tasks'],
      ['/activity', 'Activity'],
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

  describe('sidebar search and footer chrome', () => {
    it('renders search as a launcher named by its visible label that opens the palette', () => {
      renderShell()
      // Named by its own visible label, not by an aria-label that would diverge from it
      // (WCAG 2.5.3) — jsdom reports no `navigator.platform`, so the chord reads Ctrl+K.
      const search = within(sidebar()).getByRole('button', { name: 'Search…' })
      expect(search.textContent).toContain('Search…')
      expect(search.querySelector('kbd')?.textContent).toBe('Ctrl+K')

      const opened = vi.fn()
      window.addEventListener('cezar:open-command-palette', opened)
      fireEvent.click(search)
      window.removeEventListener('cezar:open-command-palette', opened)
      expect(opened).toHaveBeenCalledTimes(1)
    })

    it('keeps a long nightly version legible on hover', () => {
      renderShell('/', {
        version: '0.9.2-nightly.20260813.1',
        toolsMenu: <button type="button">Tools</button>,
      })
      const chip = sidebar().querySelector('[data-slot="version-chip"]') as HTMLElement
      expect(chip.textContent).toBe('v0.9.2-nightly.20260813.1')
      expect(chip.getAttribute('title')).toBe('v0.9.2-nightly.20260813.1')
      expect(within(sidebar()).getByRole('button', { name: 'Tools' })).toBeTruthy()
    })
  })

  describe('data slots stay empty rather than showing invented data', () => {
    it('renders no version chip when unfed', () => {
      renderShell()
      expect(document.querySelector('[data-slot="version-chip"]')).toBeNull()
    })

    it('renders the repo chip and version chip from props', () => {
      renderShell('/', { repo: { name: `${productName("cezar")}`, branch: 'main' }, version: '1.2.3' })
      expect(within(sidebar()).getByText(`${productName("cezar")}`)).toBeTruthy()
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

      it('names the newer version', () => {
        renderShell('/', { version: '1.2.3', latestVersion: '1.3.0' })
        expect(chip().getAttribute('data-update-available')).toBe('true')
        expect(chip().getAttribute('title')).toBe('v1.2.3 — update available: v1.3.0')
        const dot = chip().querySelector('[data-slot="status-dot"]') as HTMLElement
        expect(dot.getAttribute('data-tone')).toBe('pending')
        // The version shown is still the one actually running.
        expect(chip().textContent).toContain('v1.2.3')
      })
    })
  })

  it('shows the current project task list in the sidebar', () => {
    renderShell('/p/shop/git', { taskQuickList: <p>Project tasks</p> })
    expect(within(sidebar()).getByText('Project tasks')).toBeTruthy()
  })

  it('titles the mobile bar from the active route', () => {
    renderShell('/skills')
    const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
    expect(within(bar).getByText('Skills')).toBeTruthy()
  })

  /** The resizable desktop column (#788, option C). jsdom has no layout engine, so these assert
   *  the state machine and the accessibility contract; the drag, the clamps, the keyboard resize
   *  and the reload are exercised for real in `e2e/quick-list.e2e.ts` ("a row under width
   *  contention, in a column the user can widen"). */
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
      expect(drawer.style.width).toBe('')
      expect(within(drawer).queryByRole('separator', { name: 'Resize the sidebar' })).toBeNull()
    })
  })

  /** The layout contract from the spec. These classes are the whole reason the cockpit does not
   *  scroll its document or clip its composer on an iPhone — a refactor that drops one is a
   *  regression no visual test would catch on a desktop viewport. */
  describe('layout contract', () => {
    // Rule: .ai/specs/2026-07-14-cockpit-ui-redesign.md § Mobile (layout contract).
    it('is exactly one viewport tall and never scrolls the document', () => {
      renderShell()
      const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
      // h-dvh, not h-screen: 100vh ignores mobile browser chrome.
      expect(shell.className).toContain('h-dvh')
      expect(shell.className).not.toContain('h-screen')
      expect(shell.className).toContain('overflow-hidden')
    })

    // Rule: .ai/specs/2026-07-14-cockpit-ui-redesign.md § Mobile (layout contract).
    it('makes the main region the only scroller, and contains its overscroll', () => {
      renderShell()
      const main = screen.getByRole('main')
      expect(main.className).toContain('overflow-y-auto')
      expect(main.className).toContain('overscroll-contain')
    })

    // Rule: docs/areas/web-ui.md § Touch and phone rules: chrome clears the safe-area insets.
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

    it('shares the task list in the mobile drawer without desktop nav or composer chrome (#811)', () => {
      renderShell('/', { taskQuickList: <p>list</p> })
      openMenu()
      const root = drawer() as HTMLElement
      expect(root.querySelector('[data-slot="sidebar-content"]')).toBeNull()
      expect(within(root).queryByRole('navigation', { name: 'Main' })).toBeNull()
      expect(within(root).queryByRole('link', { name: 'Activity' })).toBeNull()
      expect(within(root).queryByRole('link', { name: /New task/ })).toBeNull()
      expect(within(root).getByText('list')).toBeTruthy()
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

    describe('the boot alias resolving under an open drawer (hearsay-tools/cezarion#1129)', () => {
      /** Navigates from outside the drawer, the way `ProjectScopeRoute`'s `<Navigate>` and the ⌘K
       *  palette do: a click on anything behind the modal would dismiss it first. */
      let navigate: NavigateFunction | null = null
      function NavigateHandle() {
        navigate = useNavigate()
        return null
      }
      const go = (to: string, replace: boolean) => act(() => { void navigate?.(to, { replace }) })

      it('stays open when /p/default/… is rewritten in place to the boot project\'s id', async () => {
        renderShell('/p/default/', {}, <NavigateHandle />)
        openMenu()
        await settle()
        go('/p/boot-repo/', true)
        expect(screen.getByTestId('location').textContent).toBe('/p/boot-repo/')
        await settle()
        expect(drawer()).not.toBeNull()
      })

      it('still closes on a pushed switch to another project\'s same view', async () => {
        renderShell('/p/default/', {}, <NavigateHandle />)
        openMenu()
        go('/p/other-repo/', false)
        await waitFor(() => expect(drawer()).toBeNull())
      })

      it('still closes when a replace lands on a different view', async () => {
        renderShell('/p/default/', {}, <NavigateHandle />)
        openMenu()
        go('/p/boot-repo/tasks', true)
        await waitFor(() => expect(drawer()).toBeNull())
      })
    })

    it('shows the version in the identity row and marks a newer release without an update action', () => {
      renderShell('/', { version: '1.0.0', latestVersion: '1.2.0' })
      openMenu()
      const version = drawer()?.querySelector('[data-slot="drawer-version"]') as HTMLElement
      expect(version.textContent).toBe('v1.0.0')
      expect(version.getAttribute('data-update-available')).toBe('true')
      expect(version.getAttribute('title')).toBe('v1.0.0 — update available: v1.2.0')
      expect(within(drawer() as HTMLElement).queryByRole('button', { name: /update|restart/i })).toBeNull()
      cleanup()
      renderShell('/', { version: '1.2.0', latestVersion: '1.2.0' })
      openMenu()
      expect(drawer()?.querySelector('[data-slot="drawer-version"]')?.getAttribute('data-update-available')).toBeNull()
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

    // Rule: docs/areas/web-ui.md § Touch and phone rules: chrome clears the safe-area insets.
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
