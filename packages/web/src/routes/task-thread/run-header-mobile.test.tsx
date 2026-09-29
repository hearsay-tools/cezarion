import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { AppShell } from '@/components/app-shell'
import { ThemeProvider } from '@/components/theme-provider'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { RunHeader } from './run-header'

/** The pushed task screen below md (#621): the shell's top bar carries back / title / state /
 *  run actions and RunHeader drops its own copy. jsdom has no media queries, so the viewport is a
 *  stub: `phone` decides what `(min-width: 768px)` answers. */
function stubViewport(phone: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches: !phone, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
}

beforeEach(() => stubViewport(true))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '')
})

const record: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Reviewer agent presets',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'running',
  createdAt: '2026-07-14T12:00:00.000Z',
  tokensUsed: 0,
  inputTokens: 0,
  outputTokens: 0,
  archived: false,
  steps: [],
  prNumber: 451,
  diffStat: { adds: 10, dels: 2, files: 12 },
}

function Probe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderScreen(entry = '/tasks/r1', run: ApiRun = record) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShell>
            <Routes>
              <Route path="/tasks/:id" element={<RunHeader run={run} />} />
              <Route path="/" element={<p>tasks list</p>} />
            </Routes>
            <Probe />
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const topBar = () => document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement

describe('pushed task screen top bar', () => {
  it('shows back, the title, a state line with the primary reference and the run actions', () => {
    renderScreen()
    const bar = topBar()
    expect(bar.getAttribute('data-mode')).toBe('task')
    expect(within(bar).getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(within(bar).getByText('Reviewer agent presets')).toBeTruthy()
    expect(bar.querySelector('[data-slot="mobile-run-state"]')?.textContent).toBe('running · #451')
    // The project chrome is gone: this is a pushed screen, not a list.
    expect(within(bar).queryByRole('button', { name: 'Search' })).toBeNull()
    expect(bar.querySelector('[data-slot="mobile-project-picker"]')).toBeNull()
  })

  it('opens the same run actions menu from the … button', () => {
    renderScreen()
    const kebab = within(topBar()).getByRole('button', { name: 'Run actions' })
    expect(kebab.className).toContain('size-11')
    // One kebab in the whole document: the header did not keep a second copy.
    expect(document.querySelectorAll('[aria-label="Run actions"]')).toHaveLength(1)
    fireEvent.pointerDown(kebab)
    const menu = document.querySelector('[data-slot="run-actions-menu"]') as HTMLElement
    expect(within(menu).getByText('Notes / handoff')).toBeTruthy()
  })

  it('goes back through history when the app has some', () => {
    window.history.replaceState({ idx: 2 }, '')
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ThemeProvider>
          <MemoryRouter initialEntries={['/', '/tasks/r1']} initialIndex={1}>
            <AppShell>
              <Probe />
            </AppShell>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    )
    fireEvent.click(within(topBar()).getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('falls back to the Tasks list when the screen was opened cold', () => {
    // A cold deep link has no in-app history entry to return to; navigate(-1) would leave the app.
    window.history.replaceState({ idx: 0 }, '')
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ThemeProvider>
          <MemoryRouter initialEntries={['/git', '/tasks/r1']} initialIndex={1}>
            <AppShell>
              <Probe />
            </AppShell>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    )
    fireEvent.click(within(topBar()).getByRole('button', { name: 'Back' }))
    // Not '/git' (which navigate(-1) would give): the list, unconditionally.
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('titles a compare route itself', () => {
    renderScreen('/compare/grp-1')
    expect(within(topBar()).getByText('Compare variants')).toBeTruthy()
    expect(within(topBar()).getByRole('button', { name: 'Back' })).toBeTruthy()
  })

  it('keeps the list route on the project top bar', () => {
    renderScreen('/')
    expect(topBar().getAttribute('data-mode')).toBeNull()
    expect(within(topBar()).getByRole('button', { name: 'Search' })).toBeTruthy()
  })
})

describe('RunHeader below md on a pushed task screen', () => {
  it('drops its own title and status row, and the details toggle stays', () => {
    renderScreen()
    const header = document.querySelector('[data-slot="run-header"]') as HTMLElement
    expect(header.querySelector('[data-slot="session-kind"]')).toBeNull()
    expect(within(header).queryByText('Reviewer agent presets')).toBeNull()
    expect(within(header).queryByText('running')).toBeNull()
    expect(within(header).getByRole('button', { name: 'Show run details' })).toBeTruthy()
  })

  it('styles run-tabs for the phone and counts the changed files only', () => {
    renderScreen()
    const tabs = document.querySelector('[data-slot="run-tabs"]') as HTMLElement
    expect(tabs.className).toContain('max-md:[&>a]:min-h-11')
    expect(tabs.className).toContain('max-md:[&>a]:text-[13.5px]')
    const links = within(tabs).getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual(['Session', 'Changes12', 'Commits', 'Files'])
    expect(links[1]!.querySelector('[data-slot="tab-count"]')?.className).toContain('text-[11.5px]')
    // Commits has no count on the record; none is invented.
    expect(links[2]!.querySelector('[data-slot="tab-count"]')).toBeNull()
  })

  it('omits the Changes count when the run has no diff', () => {
    renderScreen('/tasks/r1', { ...record, diffStat: undefined })
    expect(document.querySelector('[data-slot="run-tabs"] [data-slot="tab-count"]')).toBeNull()
  })

  it('keeps the whole header in place at desktop width', () => {
    stubViewport(false)
    renderScreen()
    const header = document.querySelector('[data-slot="run-header"]') as HTMLElement
    expect(within(header).getByText('Reviewer agent presets')).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Run actions' })).toBeTruthy()
    expect(document.querySelector('[data-slot="mobile-run-title"]')).toBeNull()
  })
})
