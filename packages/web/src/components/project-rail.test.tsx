import { cleanup, render, screen, within } from '@testing-library/react'
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
    expect(nav.className).toContain('w-[60px]')
    // Desktop only: the rail is `hidden` below md.
    expect(nav.className).toContain('hidden')
    expect(nav.className).toContain('md:flex')
    expect(within(nav).getByAltText('Cezarion v0.15.0').getAttribute('src')).toBe('/cezarion-mark-dark.svg')
    expect([...document.querySelectorAll('[data-slot="rail-project"]')].map((el) => el.getAttribute('data-project-id'))).toEqual([
      'toolkit-dev',
      'open_mercato',
    ])
    expect(within(nav).getByRole('link', { name: 'All projects' }).getAttribute('href')).toBe('/tasks')
    expect(within(nav).getByRole('link', { name: 'Global settings' }).getAttribute('href')).toBe('/settings/global')
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

  it('says idle for a quiet project, and says so when only recent runs were counted', () => {
    renderRail({ truncated: new Set(['open_mercato']) })
    expect(within(mark('toolkit-dev')).getByRole('link').getAttribute('aria-label')).toBe('toolkit-dev · idle')
    expect(within(mark('open_mercato')).getByRole('link').getAttribute('aria-label')).toBe('open_mercato · idle · recent runs only')
  })
})
