import { readFileSync } from 'node:fs'
import path from 'node:path'

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
const classes = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/)
const TEAL = /task-brand-selected|accent-(?:text|strong|icon)/
const SELECTED = ['bg-sidebar-row-selected', 'text-foreground', 'font-medium']

describe('sidebar nav selection (#619)', () => {
  it('shows a neutral active pill and accessible icon-only inactive links', () => {
    renderShell('/git')
    const git = within(nav()).getByRole('link', { name: 'Git' })
    expect(git.getAttribute('aria-current')).toBe('page')
    expect(git.textContent).toBe('Git')
    expect(classes(git)).toEqual(expect.arrayContaining(['bg-sidebar-row-selected', 'text-foreground', 'font-semibold']))
    const skills = within(nav()).getByRole('link', { name: 'Skills' })
    expect(skills.textContent).toBe('')
    expect(skills.className).toContain('text-soft-foreground')
    for (const link of within(nav()).getAllByRole('link')) expect(link.className).not.toMatch(TEAL)
  })

  it('selects New task with the same neutral fill', () => {
    renderShell('/new')
    const item = sidebar().querySelector('[data-sidebar-item="new-task"]')!
    expect(item.getAttribute('aria-current')).toBe('page')
    expect(classes(item)).toEqual(expect.arrayContaining(SELECTED))
    expect(item.className).not.toMatch(TEAL)
  })

  it('shows attention only on the inactive Tasks tab', () => {
    renderShell('/', { needsYou: true })
    expect(sidebar().querySelector('[data-slot="nav-needs-you-dot"]')).toBeNull()
    cleanup()
    renderShell('/git', { needsYou: true })
    expect(classes(sidebar().querySelector('[data-slot="nav-needs-you-dot"]'))).toEqual(expect.arrayContaining(['size-[7px]', 'bg-pending-strong']))
  })

  it('shows Inbox count in overflow and a Skills update dot', async () => {
    renderShell('/git', { inboxCount: 4, skillsUpdateAvailable: true })
    expect(sidebar().querySelector('[data-slot="overflow-inbox-dot"]')).not.toBeNull()
    expect(classes(sidebar().querySelector('[data-slot="nav-update-marker"]'))).toEqual(expect.arrayContaining(['size-[7px]', 'bg-info']))
    fireEvent.keyDown(within(nav()).getByRole('button', { name: 'More views' }), { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: /Inbox/ })).textContent).toBe('Inbox4')
  })

  it('moves keyboard focus across the view row without changing routes', () => {
    renderShell('/git')
    const git = within(nav()).getByRole('link', { name: 'Git' })
    git.focus()
    fireEvent.keyDown(git, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(within(nav()).getByRole('link', { name: 'GitHub' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(within(nav()).getByRole('button', { name: 'More views' }))
    expect(git.getAttribute('aria-current')).toBe('page')
  })

  it('uses the same selected pill in the mobile drawer', () => {
    renderShell('/git')
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const selected = document.querySelectorAll('nav[aria-label="Main"] a[aria-current="page"]')
    expect(selected).toHaveLength(2)
    for (const link of selected) expect(classes(link)).toEqual(expect.arrayContaining(['bg-sidebar-row-selected', 'text-foreground']))
  })
})

describe('sidebar tokens and the last teal (#617 01c)', () => {
  const src = (file: string) => readFileSync(path.join(import.meta.dirname, file), 'utf8')

  it('declares the inbox count amber per theme and exposes it as a colour utility', () => {
    const css = src('../styles/index.css')
    const block = (opener: string) => css.slice(css.indexOf(opener)).split(/\n}\n/)[0]
    const dark = block('\n:root {\n'), light = block('\n.light {\n')
    expect(dark).toMatch(/--inbox-count:\s*#f4c54226;/i)
    expect(dark).toMatch(/--inbox-count-foreground:\s*#f4c542;/i)
    expect(light).toMatch(/--inbox-count:\s*#f4c54240;/i)
    expect(light).toMatch(/--inbox-count-foreground:\s*#7a5200;/i)
    expect(css).toMatch(/--color-inbox-count:\s*var\(--inbox-count\);/)
    expect(css).toMatch(/--color-inbox-count-foreground:\s*var\(--inbox-count-foreground\);/)
  })

  it('leaves no teal token in the sidebar sources but the header ShieldCheck, which says why', () => {
    for (const file of ['project-groups.tsx', 'task-quick-list.tsx', 'nav-row-styles.ts']) {
      expect(src(file).match(new RegExp(TEAL, 'g')), file).toBeNull()
    }
    const shell = src('app-shell.tsx').split('\n')
    const hits = shell.map((line, index) => ({ line, index })).filter(({ line }) => TEAL.test(line))
    expect(hits.map(({ line }) => line.includes('<ShieldCheckIcon'))).toEqual([true])
    // The exception is stated at the site, in the comment just above it.
    const at = hits[0]?.index ?? 0
    expect(shell.slice(Math.max(0, at - 3), at + 1).join('\n')).toMatch(/#617 01c/)
  })
})
