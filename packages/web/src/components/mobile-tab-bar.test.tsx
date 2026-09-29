import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileTabBar } from '@/components/mobile-tab-bar'
import { activeNavPath, visibleNavItems } from '@/components/nav-items'

afterEach(cleanup)

function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderBar(
  entry: string,
  availability: Parameters<typeof visibleNavItems>[0] = { forge: true },
  props: Partial<React.ComponentProps<typeof MobileTabBar>> = {},
) {
  const path = entry.replace(/^\/p\/[^/]+/, '') || '/'
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <MobileTabBar items={visibleNavItems(availability)} activeTo={activeNavPath(path)} projectName="cezarion" {...props} />
      <Location />
    </MemoryRouter>,
  )
}

const bar = () => screen.getByRole('navigation', { name: 'Views' })
const tabLabels = () => Array.from(bar().children).map((el) => el.textContent?.replace(/\d+\+?$/, '').trim())

describe('MobileTabBar', () => {
  it('shows Tasks, Git, GitHub and More when the forge is available', () => {
    renderBar('/')
    expect(tabLabels()).toEqual(['Tasks', 'Git', 'GitHub', 'More'])
  })

  it('drops the GitHub tab without a forge, leaving three slots', () => {
    renderBar('/', { forge: false })
    expect(tabLabels()).toEqual(['Tasks', 'Git', 'More'])
  })

  it('never puts flag-gated or More views in the bar, even with every flag on', () => {
    renderBar('/', { forge: true, inbox: true, automations: true })
    expect(tabLabels()).toEqual(['Tasks', 'Git', 'GitHub', 'More'])
  })

  it('marks the tab that owns the route, including project-scoped and nested routes', () => {
    renderBar('/p/cezarion/git/commits')
    expect(within(bar()).getByRole('link', { name: 'Git' }).getAttribute('aria-current')).toBe('page')
    expect(within(bar()).getByRole('link', { name: 'Tasks' }).hasAttribute('aria-current')).toBe(false)
    expect(within(bar()).getByRole('button', { name: 'More' }).hasAttribute('data-active')).toBe(false)
  })

  it('lights More, and no tab, for a route that lives in the More sheet', () => {
    renderBar('/skills')
    expect(within(bar()).getByRole('button', { name: 'More' }).getAttribute('data-active')).toBe('true')
    expect(within(bar()).queryAllByRole('link').filter((a) => a.getAttribute('aria-current'))).toHaveLength(0)
  })

  it('lights nothing on /new', () => {
    renderBar('/new', { forge: true }, { activeTo: '/new' })
    expect(within(bar()).getByRole('button', { name: 'More' }).hasAttribute('data-active')).toBe(false)
  })

  it('badges Tasks with the top pill only', () => {
    renderBar('/', { forge: true }, { signal: { needsYou: 2, failedUnread: 1, inMotion: 3, finishedUnread: 4 } })
    const tasks = within(bar()).getByRole('link', { name: 'Tasks' })
    expect(tasks.querySelector('[data-slot="rail-pill-top"]')).not.toBeNull()
    expect(tasks.querySelector('[data-segment="amber"]')!.getAttribute('data-count')).toBe('2')
    expect(tasks.querySelector('[data-segment="red"]')!.getAttribute('data-count')).toBe('1')
    expect(bar().querySelector('[data-slot="rail-pill-bottom"]')).toBeNull()
    expect(bar().querySelector('[data-segment="violet"]')).toBeNull()
  })

  it('renders no badge for an idle or unknown project', () => {
    renderBar('/', { forge: true }, { signal: { needsYou: 0, failedUnread: 0, inMotion: 5, finishedUnread: 2 } })
    expect(bar().querySelector('[data-slot^="rail-pill"]')).toBeNull()
  })

  it('floats a New task button that goes to /new, and can be turned off', () => {
    const { unmount } = renderBar('/p/cezarion/')
    expect(screen.getByRole('link', { name: 'New task' }).getAttribute('href')).toBe('/p/cezarion/new')
    unmount()
    renderBar('/new', { forge: true }, { showNewTask: false })
    expect(screen.queryByRole('link', { name: 'New task' })).toBeNull()
  })
})

describe('More sheet', () => {
  const open = () => fireEvent.click(within(bar()).getByRole('button', { name: 'More' }))
  const sheet = () => screen.getByRole('dialog', { name: 'More' })

  it('lists Skills, Workflows and Project settings, without flagged rows when flags are off', () => {
    renderBar('/')
    open()
    expect(within(sheet()).getAllByRole('link').map((a) => a.textContent)).toEqual(['Skills', 'Workflows', 'Project settings'])
    expect(within(sheet()).queryByText('Shown when their flag is on')).toBeNull()
    expect(within(sheet()).getByText('cezarion')).toBeTruthy()
  })

  it('adds Inbox and Automations under the flag label, each only when its flag is on', () => {
    const { unmount } = renderBar('/', { forge: true, inbox: true, automations: true }, { inboxCount: 2 })
    open()
    expect(within(sheet()).getAllByRole('link').map((a) => a.textContent)).toEqual(['Skills', 'Workflows', 'Project settings', 'Inbox2', 'Automations'])
    expect(within(sheet()).getByText('Shown when their flag is on')).toBeTruthy()
    unmount()
    renderBar('/', { forge: true, inbox: true })
    open()
    expect(within(sheet()).getAllByRole('link').map((a) => a.textContent)).toEqual(['Skills', 'Workflows', 'Project settings', 'Inbox'])
  })

  it('shows the inbox count pill and the skills update pill', () => {
    renderBar('/', { forge: true, inbox: true }, { inboxCount: 3, skillsUpdateAvailable: true })
    open()
    expect(within(sheet()).getByText('1 update')).toBeTruthy()
    expect(sheet().querySelector('[data-slot="inbox-count"]')!.textContent).toBe('3')
  })

  it('shows no badges when nothing is pending', () => {
    renderBar('/', { forge: true, inbox: true })
    open()
    expect(within(sheet()).queryByText('1 update')).toBeNull()
    expect(sheet().querySelector('[data-slot="inbox-count"]')).toBeNull()
  })

  it('closes and navigates when a row is tapped', () => {
    renderBar('/p/cezarion/')
    open()
    fireEvent.click(within(sheet()).getByRole('link', { name: 'Workflows' }))
    expect(screen.getByTestId('location').textContent).toBe('/p/cezarion/workflows')
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull()
  })

  it('closes when the row of the current route is tapped again', () => {
    renderBar('/settings')
    open()
    const row = within(sheet()).getByRole('link', { name: 'Project settings' })
    expect(row.getAttribute('aria-current')).toBe('page')
    fireEvent.click(row)
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull()
  })
})

describe('More sheet lifecycle', () => {
  const open = () => fireEvent.click(within(bar()).getByRole('button', { name: 'More' }))

  it('returns focus to the More tab on Escape', async () => {
    renderBar('/')
    open()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'More' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull()
    // Radix restores focus on a zero-delay timer after the content unmounts.
    await waitFor(() => expect(document.activeElement).toBe(within(bar()).getByRole('button', { name: 'More' })))
  })

  it('closes on a route change that did not come from a row (back/forward, palette)', () => {
    function Jump() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/git')}>jump</button>
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <MobileTabBar items={visibleNavItems({ forge: true })} activeTo="/" />
        <Jump />
      </MemoryRouter>,
    )
    open()
    expect(screen.getByRole('dialog', { name: 'More' })).toBeTruthy()
    fireEvent.click(screen.getByText('jump'))
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull()
  })

  it('closes when the viewport widens past md', async () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
    }))
    try {
      renderBar('/')
      open()
      expect(screen.getByRole('dialog', { name: 'More' })).toBeTruthy()
      act(() => {
        for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent)
      })
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
