import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { ProjectRail, type ProjectRailProps } from '@/components/project-rail'
import { ThemeProvider } from '@/components/theme-provider'
import type { ProjectSignal } from '@/lib/project-signal'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  setViewport(1024)
})

/** jsdom's window is 1024px wide: too narrow for the expanded rail beside a 264px sidebar. */
function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

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

function renderRail(props: Partial<ProjectRailProps> = {}, entry = '/p/toolkit-dev/') {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <ProjectRail
          projects={[project('toolkit-dev'), project('open_mercato')]}
          signals={new Map()}
          truncated={new Set()}
          version="0.15.0"
          singleProject={false}
          {...props}
        />
      </MemoryRouter>
    </ThemeProvider>,
  )
}

const mark = (id: string) => document.querySelector(`[data-slot="rail-project"][data-project-id="${id}"]`) as HTMLElement
const pill = (id: string, position: 'top' | 'bottom') => mark(id).querySelector(`[data-slot="rail-pill-${position}"]`)
const segments = (id: string, position: 'top' | 'bottom') =>
  [...(pill(id, position)?.querySelectorAll('[data-segment]') ?? [])].map((el) => ({
    tone: el.getAttribute('data-segment'),
    text: el.textContent,
    width: (el as HTMLElement).style.width,
  }))

describe('ProjectRail layout', () => {
  it('is a labelled nav with the app mark, a mark per project in registry order, and the bottom group', () => {
    renderRail()
    const nav = screen.getByRole('navigation', { name: 'Projects' })
    expect(nav.style.width).toBe('60px')
    expect(nav.getAttribute('data-expanded')).toBe('false')
    // Desktop only: the rail is `hidden` below md.
    expect(nav.className).toContain('hidden')
    expect(nav.className).toContain('md:flex')
    expect(within(nav).getByAltText('Cezarion v0.15.0').getAttribute('src')).toBe('/cezarion-mark-dark.svg')
    expect([...document.querySelectorAll('[data-slot="rail-project"]')].map((el) => el.getAttribute('data-project-id'))).toEqual([
      'toolkit-dev',
      'open_mercato',
    ])
    expect(within(nav).getByRole('link', { name: 'All projects' }).getAttribute('href')).toBe('/tasks')
    expect(within(nav).getByRole('link', { name: 'Global settings' }).getAttribute('href')).toBe('/settings/global/appearance')
    expect(within(nav).getByRole('button', { name: /^Theme:/ })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Add project' })).toBeTruthy()
  })

  it('names the app without a version until health has one', () => {
    renderRail({ version: null })
    expect(screen.getByAltText('Cezarion')).toBeTruthy()
  })

  it('shows two lower-case letters per project and links each mark to its project', () => {
    renderRail()
    const link = within(mark('open_mercato')).getByRole('link')
    expect(link.textContent).toBe('om')
    expect(link.getAttribute('href')).toBe('/p/open_mercato/')
    expect(within(mark('toolkit-dev')).getByRole('link').textContent).toBe('td')
  })

  it('marks the URL project as current: aria-current, the left bar, and only that one', () => {
    renderRail()
    expect(within(mark('toolkit-dev')).getByRole('link').getAttribute('aria-current')).toBe('page')
    expect(mark('toolkit-dev').querySelector('[data-slot="rail-current-bar"]')).not.toBeNull()
    expect(within(mark('open_mercato')).getByRole('link').getAttribute('aria-current')).toBeNull()
    expect(mark('open_mercato').querySelector('[data-slot="rail-current-bar"]')).toBeNull()
  })

  it('has no current project on a global route, and lights the global icon instead', () => {
    renderRail({}, '/settings/global/agents')
    expect(document.querySelector('[data-slot="rail-current-bar"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'Global settings' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'All projects' }).getAttribute('aria-current')).toBeNull()
  })

  it('lights All projects on the global tasks route', () => {
    renderRail({}, '/tasks')
    expect(screen.getByRole('link', { name: 'All projects' }).getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('[data-slot="rail-current-bar"]')).toBeNull()
  })
})

describe('ProjectRail single-project capability', () => {
  it('keeps Add project and All projects with one registered project when the capability is off', () => {
    renderRail({ projects: [project('toolkit-dev')], singleProject: false })
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'All projects' })).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="rail-project"]')).toHaveLength(1)
  })

  it('drops Add project and All projects, and keeps the rest, when the capability is on', () => {
    renderRail({ projects: [project('toolkit-dev'), project('other')], singleProject: true })
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'All projects' })).toBeNull()
    expect(screen.getByAltText('Cezarion v0.15.0')).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="rail-project"]')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Global settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Theme:/ })).toBeTruthy()
  })
})

describe('ProjectRail pills', () => {
  it('draws no pill and no dot for an idle project', () => {
    renderRail({ signals: new Map([['toolkit-dev', signal()]]) })
    expect(pill('toolkit-dev', 'top')).toBeNull()
    expect(pill('toolkit-dev', 'bottom')).toBeNull()
    expect(pill('open_mercato', 'top')).toBeNull()
    // The rail speaks in counts only: nothing on it is a status dot.
    expect(document.querySelector('[data-slot="status-dot"]')).toBeNull()
  })

  it('splits the top pill amber then red, 14px each', () => {
    renderRail({ signals: new Map([['toolkit-dev', signal({ needsYou: 1, failedUnread: 3 })]]) })
    expect(segments('toolkit-dev', 'top')).toEqual([
      { tone: 'amber', text: '1', width: '14px' },
      { tone: 'red', text: '3', width: '14px' },
    ])
    expect(pill('toolkit-dev', 'bottom')).toBeNull()
  })

  it('splits the bottom pill violet then green, and a lone segment is 18px', () => {
    renderRail({
      signals: new Map([
        ['toolkit-dev', signal({ inMotion: 2, finishedUnread: 1 })],
        ['open_mercato', signal({ finishedUnread: 4 })],
      ]),
    })
    expect(segments('toolkit-dev', 'bottom')).toEqual([
      { tone: 'violet', text: '2', width: '14px' },
      { tone: 'green', text: '1', width: '14px' },
    ])
    expect(segments('open_mercato', 'bottom')).toEqual([{ tone: 'green', text: '4', width: '18px' }])
    expect(pill('open_mercato', 'top')).toBeNull()
  })

  it('caps a segment at 9+ and widens it to 22px', () => {
    renderRail({ signals: new Map([['toolkit-dev', signal({ needsYou: 12, inMotion: 9 })]]) })
    expect(segments('toolkit-dev', 'top')).toEqual([{ tone: 'amber', text: '9+', width: '22px' }])
    expect(segments('toolkit-dev', 'bottom')).toEqual([{ tone: 'violet', text: '9', width: '18px' }])
  })

  it('places the pills on the mark corners and keeps them off the click target', () => {
    renderRail({ signals: new Map([['toolkit-dev', signal({ needsYou: 1, inMotion: 1 })]]) })
    const top = pill('toolkit-dev', 'top') as HTMLElement
    const bottom = pill('toolkit-dev', 'bottom') as HTMLElement
    for (const el of [top, bottom]) {
      expect(el.className).toContain('h-[17px]')
      expect(el.className).toContain('rounded-[9px]')
      expect(el.className).toContain('border-2')
      expect(el.className).toContain('border-background')
      expect(el.className).toContain('-right-[4px]')
      expect(el.className).toContain('pointer-events-none')
      expect(el.getAttribute('aria-hidden')).toBe('true')
    }
    expect(top.className).toContain('-top-[6px]')
    expect(bottom.className).toContain('top-[25px]')
  })

  it('fills each segment from its own token, and inks amber apart from the rest', () => {
    renderRail({ signals: new Map([['toolkit-dev', signal({ needsYou: 1, failedUnread: 1, inMotion: 1, finishedUnread: 1 })]]) })
    const cls = (tone: string) => (mark('toolkit-dev').querySelector(`[data-segment="${tone}"]`) as HTMLElement).className
    expect(cls('amber')).toContain('bg-pending')
    expect(cls('amber')).toContain('text-signal-ink-amber')
    expect(cls('red')).toContain('bg-danger')
    expect(cls('violet')).toContain('bg-status-running')
    expect(cls('green')).toContain('bg-success')
    for (const tone of ['red', 'violet', 'green']) expect(cls(tone)).toContain('text-signal-ink')
  })
})

describe('ProjectRail accessible name', () => {
  it('spells the signal out on the link, in the tooltip, in order', () => {
    renderRail({ signals: new Map([['toolkit-dev', signal({ needsYou: 1, failedUnread: 1, inMotion: 2, finishedUnread: 1 })]]) })
    const link = within(mark('toolkit-dev')).getByRole('link')
    expect(link.getAttribute('aria-label')).toBe('toolkit-dev · 1 needs you · 1 failed · 2 working · 1 finished')
    expect(link.getAttribute('title')).toBe(link.getAttribute('aria-label'))
  })

  it('says the activity is unknown, not idle, while the runs index has not loaded', () => {
    renderRail({ signals: null })
    expect(within(mark('toolkit-dev')).getByRole('link').getAttribute('aria-label')).toBe('toolkit-dev · activity unknown')
    expect(within(mark('open_mercato')).getByRole('link').getAttribute('title')).toBe('open_mercato · activity unknown')
    expect(document.querySelector('[data-slot="rail-pill-top"], [data-slot="rail-pill-bottom"]')).toBeNull()
  })

  it('says idle for a quiet project, and says so when only recent runs were counted', () => {
    renderRail({ truncated: new Set(['open_mercato']) })
    expect(within(mark('toolkit-dev')).getByRole('link').getAttribute('aria-label')).toBe('toolkit-dev · idle')
    expect(within(mark('open_mercato')).getByRole('link').getAttribute('aria-label')).toBe('open_mercato · idle · recent runs only')
  })
})

describe('ProjectRail expand toggle (#711)', () => {
  const toggle = () => document.querySelector('[data-slot="rail-expand-toggle"]') as HTMLButtonElement | null
  const nav = () => screen.getByRole('navigation', { name: 'Projects' })

  it('defaults to collapsed, with a borderless icon toggle first in the bottom group', () => {
    setViewport(1440)
    renderRail()
    expect(nav().style.width).toBe('60px')
    const button = toggle()!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-label')).toBe('Expand projects')
    expect(button.getAttribute('title')).toBe('Expand projects')
    expect(button.getAttribute('aria-controls')).toBe(nav().id)
    expect(button.className).not.toMatch(/\bborder\b/)
    expect(button.className).toContain('rounded-[8px]')
    expect(button.className).toContain('hover:bg-sidebar-row-hover')
    const bottom = document.querySelector('[data-slot="rail-bottom"]')!
    expect(bottom.firstElementChild).toBe(button)
  })

  it('expands to 232px and back, remembering the choice in localStorage', () => {
    setViewport(1440)
    renderRail()
    fireEvent.click(toggle()!)
    expect(nav().style.width).toBe('232px')
    expect(nav().getAttribute('data-expanded')).toBe('true')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    expect(toggle()!.textContent).toBe('Collapse')
    expect(localStorage.getItem('cez-project-rail-expanded')).toBe('1')
    // The nav keeps its name when unfolded.
    expect(nav().getAttribute('aria-label')).toBe('Projects')
    fireEvent.click(toggle()!)
    expect(nav().style.width).toBe('60px')
    expect(localStorage.getItem('cez-project-rail-expanded')).toBe('0')
  })

  it('opens expanded after a reload when that was the stored choice', () => {
    setViewport(1440)
    localStorage.setItem('cez-project-rail-expanded', '1')
    renderRail()
    expect(nav().style.width).toBe('232px')
  })

  it('says on hover when an expanded row counted recent runs only', () => {
    setViewport(1440)
    localStorage.setItem('cez-project-rail-expanded', '1')
    renderRail({ truncated: new Set(['open_mercato']) })
    const capped = within(mark('open_mercato')).getByRole('link')
    expect(capped.getAttribute('title')).toBe('Counts cover recent runs only')
    expect(capped.getAttribute('aria-label')).toBe('open_mercato · idle · recent runs only')
    expect(within(mark('toolkit-dev')).getByRole('link').getAttribute('title')).toBeNull()
  })

  it('collapses and hides the toggle when main would drop under 640px, and restores on widening', () => {
    localStorage.setItem('cez-project-rail-expanded', '1')
    setViewport(1024)
    renderRail()
    expect(nav().style.width).toBe('60px')
    expect(toggle()).toBeNull()
    // The stored choice is kept for the wider window.
    expect(localStorage.getItem('cez-project-rail-expanded')).toBe('1')
    act(() => {
      setViewport(1440)
      window.dispatchEvent(new Event('resize'))
    })
    expect(nav().style.width).toBe('232px')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
  })

  it('animates only the width, and not under reduced motion', () => {
    setViewport(1440)
    renderRail()
    expect(nav().className).toContain('transition-[width]')
    expect(nav().className).toContain('duration-[160ms]')
    expect(nav().className).toContain('motion-reduce:transition-none')
  })
})

describe('ProjectRail expanded rows (#711)', () => {
  function renderExpanded(props: Partial<ProjectRailProps> = {}, entry?: string) {
    setViewport(1440)
    localStorage.setItem('cez-project-rail-expanded', '1')
    return renderRail(props, entry)
  }
  const row = (id: string) => within(mark(id)).getByRole('link')

  it('shows the mark with both pills, the full name, and at most two state words in priority order', () => {
    renderExpanded({ signals: new Map([['toolkit-dev', signal({ needsYou: 1, failedUnread: 1, inMotion: 2, finishedUnread: 1 })]]) })
    const link = row('toolkit-dev')
    expect(link.querySelector('[data-slot="rail-project-name"]')?.textContent).toBe('toolkit-dev')
    expect(link.querySelector('[data-slot="rail-pill-top"]')).not.toBeNull()
    expect(link.querySelector('[data-slot="rail-pill-bottom"]')).not.toBeNull()
    const words = [...link.querySelectorAll('[data-tone]')].map((el) => `${el.getAttribute('data-tone')}:${el.textContent}`)
    expect(words).toEqual(['amber:1 needs you', 'red:1 failed'])
    // The accessible name keeps all four; no tooltip, since the words are on screen.
    expect(link.getAttribute('aria-label')).toBe('toolkit-dev · 1 needs you · 1 failed · 2 working · 1 finished')
    expect(link.getAttribute('title')).toBeNull()
  })

  it('paints the words with the shared text inks, never the pill fills', () => {
    renderExpanded({ signals: new Map([['toolkit-dev', signal({ needsYou: 1, failedUnread: 1 })], ['open_mercato', signal({ inMotion: 1, finishedUnread: 1 })]]) })
    const cls = (id: string, tone: string) => (row(id).querySelector(`[data-tone="${tone}"]`) as HTMLElement).className
    expect(cls('toolkit-dev', 'amber')).toContain('text-signal-word-amber')
    expect(cls('toolkit-dev', 'red')).toContain('text-signal-word-red')
    expect(cls('open_mercato', 'violet')).toContain('text-status-running')
    expect(cls('open_mercato', 'green')).toContain('text-success')
  })

  it('fills the current row, borders its mark on --sidebar, and drops the left bar', () => {
    renderExpanded()
    const current = row('toolkit-dev')
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(current.className).toContain('bg-sidebar-row-selected')
    const markEl = current.querySelector('[data-slot="rail-mark"]') as HTMLElement
    expect(markEl.className).toContain('border-soft-foreground')
    expect(markEl.className).toContain('bg-sidebar')
    expect(document.querySelector('[data-slot="rail-current-bar"]')).toBeNull()
    expect(current.querySelector('[data-slot="rail-project-name"]')?.className).toContain('text-foreground')
    const other = row('open_mercato')
    expect(other.className).toContain('hover:bg-sidebar-row-hover')
    expect(other.querySelector('[data-slot="rail-project-name"]')?.className).toContain('text-muted-foreground')
    expect(other.querySelector('[data-slot="rail-project-state"]')?.textContent).toBe('idle')
  })

  it('shows the identity, the Projects label, a labelled Add project and the labelled bottom rows', () => {
    renderExpanded()
    const rail = screen.getByRole('navigation', { name: 'Projects' })
    expect(within(rail).getByText('Cezarion')).toBeTruthy()
    expect(within(rail).getByText('v0.15.0')).toBeTruthy()
    expect(within(rail).getByText('Projects')).toBeTruthy()
    expect(within(rail).getByRole('button', { name: 'Add project' }).textContent).toBe('Add project')
    expect(within(rail).getByRole('link', { name: 'All projects' }).textContent).toBe('All projects')
    expect(within(rail).getByRole('link', { name: 'Global settings' }).textContent).toBe('Global settings')
    expect(within(rail).getByRole('button', { name: /^Theme:/ }).textContent).toMatch(/^Theme · (System|Light|Dark)$/)
    expect(within(rail).getByRole('button', { name: 'Collapse projects' }).textContent).toBe('Collapse')
  })

  it('drops Add project and All projects under the single-project capability', () => {
    renderExpanded({ singleProject: true })
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'All projects' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Collapse projects' })).toBeTruthy()
  })
})

describe('ProjectRail remembered pages', () => {
  const target = (id: string) => ({
    href: id === 'open_mercato' ? '/p/open_mercato/git/branches?q=x#h' : `/p/${id}/`,
    verify: false,
  })

  it('links every mark to the resolved target, collapsed and expanded', () => {
    renderRail({ projectTarget: target })
    const href = (id: string) => mark(id).querySelector('a')?.getAttribute('href')
    expect(href('open_mercato')).toBe('/p/open_mercato/git/branches?q=x#h')
    expect(href('toolkit-dev')).toBe('/p/toolkit-dev/')

    localStorage.setItem('cez-project-rail-expanded', '1')
    setViewport(1600)
    cleanup()
    renderRail({ projectTarget: target })
    expect(document.querySelector('[data-slot="project-rail"]')?.getAttribute('data-expanded')).toBe('true')
    expect(href('open_mercato')).toBe('/p/open_mercato/git/branches?q=x#h')
  })

  it('hands a plain click on an entity page to the resolver, but not a new-tab click', () => {
    const onSwitchProject = vi.fn()
    renderRail({
      projectTarget: (id) => ({ href: `/p/${id}/tasks/run-1`, verify: true }),
      onSwitchProject,
    })
    const link = mark('open_mercato').querySelector('a') as HTMLElement

    fireEvent.click(link, { ctrlKey: true })
    expect(onSwitchProject).not.toHaveBeenCalled()

    fireEvent.click(link)
    expect(onSwitchProject).toHaveBeenCalledWith('open_mercato')
  })

  it('the expanded rail hands an entity click to the resolver as well', () => {
    localStorage.setItem('cez-project-rail-expanded', '1')
    setViewport(1600)
    const onSwitchProject = vi.fn()
    renderRail({ projectTarget: (id) => ({ href: `/p/${id}/tasks/run-1`, verify: true }), onSwitchProject })
    expect(document.querySelector('[data-slot="project-rail"]')?.getAttribute('data-expanded')).toBe('true')
    const link = mark('open_mercato').querySelector('a') as HTMLElement

    fireEvent.click(link, { metaKey: true })
    expect(onSwitchProject).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(onSwitchProject).toHaveBeenCalledWith('open_mercato')
  })

  it('keeps the home link when no resolver is given', () => {
    renderRail()
    expect(mark('open_mercato').querySelector('a')?.getAttribute('href')).toBe('/p/open_mercato/')
  })
})
