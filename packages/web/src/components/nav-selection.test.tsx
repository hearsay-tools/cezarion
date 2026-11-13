import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell, type AppShellProps } from './app-shell'
import { ThemeProvider } from './theme-provider'

/*
 * #617 addendum 01c: one selection language for the sidebar. A selected nav item, New task on
 * /new and the footer's active icon take the task row's `--sidebar-row-selected` fill with
 * foreground ink; badges follow what they mean. The e2e selection-states spec resolves the same
 * rules against the real stylesheet in both themes.
 */

afterEach(() => {
  cleanup()
  localStorage.clear()
})

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
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

const sidebar = () => document.querySelector('[data-slot="sidebar"]') as HTMLElement
const nav = () => within(sidebar()).getByRole('navigation', { name: 'Main' })

describe('sidebar nav selection (#619)', () => {
  it('shows a neutral active pill and accessible icon-only inactive links', () => {
    renderShell('/activity')
    const activity = within(nav()).getByRole('link', { name: 'Activity' })
    expect(activity.getAttribute('aria-current')).toBe('page')
    expect(activity.textContent).toBe('Activity')
    const skills = within(nav()).getByRole('link', { name: 'Skills' })
    expect(skills.textContent).toBe('')
  })

  it('selects New task on /new', () => {
    renderShell('/new')
    const item = sidebar().querySelector('[data-sidebar-item="new-task"]')!
    expect(item.getAttribute('aria-current')).toBe('page')
  })

  it('shows attention only on the inactive Tasks tab', () => {
    renderShell('/', { needsYou: true })
    expect(sidebar().querySelector('[data-slot="nav-needs-you-dot"]')).toBeNull()
    cleanup()
    renderShell('/activity', { needsYou: true })
    expect(sidebar().querySelector('[data-slot="nav-needs-you-dot"]')).not.toBeNull()
  })

  it('moves keyboard focus across the view row without changing routes', () => {
    renderShell('/activity')
    const tasks = within(nav()).getByRole('link', { name: 'Tasks' })
    const activity = within(nav()).getByRole('link', { name: 'Activity' })
    tasks.focus()
    fireEvent.keyDown(tasks, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(activity)
    fireEvent.keyDown(activity, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(within(nav()).getByRole('link', { name: 'GitHub' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(within(nav()).getByRole('button', { name: 'More views' }))
    expect(activity.getAttribute('aria-current')).toBe('page')
  })

  it('leaves the mobile drawer without a nav list, so only the desktop pill is selected (#621)', () => {
    renderShell('/activity')
    fireEvent.click(screen.getByRole('button', { name: /^Open projects/ }))
    const selected = document.querySelectorAll('nav[aria-label="Main"] a[aria-current="page"]')
    expect(selected).toHaveLength(1)
  })
})
