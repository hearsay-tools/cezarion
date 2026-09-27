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

describe('sidebar nav selection (#617 01c)', () => {
  it('fills a selected nav item like a selected task row, with foreground icon and label at 500', () => {
    renderShell('/git')
    const git = within(nav()).getByRole('link', { current: 'page' })
    expect(git.textContent).toBe('Git')
    expect(classes(git)).toEqual(expect.arrayContaining([...SELECTED, 'hover:bg-sidebar-row-selected']))
    expect(classes(git)).not.toContain('font-normal')
    expect(classes(git.querySelector('svg'))).toContain('text-foreground')
    expect(git.className).not.toMatch(TEAL)
  })

  it('keeps a default nav item muted at 400, and hovers every item onto the neutral hover fill', () => {
    renderShell('/git')
    for (const link of within(nav()).getAllByRole('link')) {
      // A selected row keeps its selected fill under the pointer; every other row hovers neutral.
      const fill = link.getAttribute('aria-current') ? 'hover:bg-sidebar-row-selected' : 'hover:bg-sidebar-row-hover'
      expect(classes(link)).toEqual(expect.arrayContaining([fill, 'hover:text-foreground', 'group/nav']))
      expect(classes(link.querySelector('svg'))).toContain('group-hover/nav:text-foreground')
      expect(link.className).not.toMatch(TEAL)
    }
    const skills = within(nav()).getByRole('link', { name: 'Skills' })
    expect(classes(skills)).toEqual(expect.arrayContaining(['text-muted-foreground', 'font-normal']))
    expect(classes(skills)).not.toContain('bg-sidebar-row-selected')
    expect(classes(skills.querySelector('svg'))).toContain('text-soft-foreground')
  })

  it('selects New task on /new exactly like a nav item, and leaves it plain elsewhere', () => {
    renderShell('/new')
    const newTask = sidebar().querySelector('[data-sidebar-item="new-task"]') as HTMLElement
    expect(newTask.getAttribute('aria-current')).toBe('page')
    // Still a Button link: `a[data-slot='button']` is what holds the mobile 44px floor.
    expect(newTask.getAttribute('data-slot')).toBe('button')
    expect(classes(newTask)).toEqual(expect.arrayContaining([...SELECTED, 'hover:bg-sidebar-row-selected']))
    expect(newTask.className).not.toMatch(TEAL)
    cleanup()
    renderShell('/git')
    const plain = sidebar().querySelector('[data-sidebar-item="new-task"]') as HTMLElement
    expect(plain.getAttribute('aria-current')).toBeNull()
    expect(classes(plain)).not.toContain('bg-sidebar-row-selected')
    expect(classes(plain)).toEqual(expect.arrayContaining(['hover:bg-sidebar-row-hover', 'hover:text-foreground']))
  })

  it('draws tasks-unread as a neutral 11px/600 chip, on --sidebar when its row is selected', () => {
    const shape = ['text-[11px]', 'font-semibold', 'px-[6px]', 'py-px', 'rounded-[9px]', 'text-foreground']
    renderShell('/', { unreadCount: 2 })
    const onSelected = sidebar().querySelector('[data-slot="nav-unread-badge"]')
    expect(classes(onSelected)).toEqual(expect.arrayContaining([...shape, 'bg-sidebar']))
    expect(classes(onSelected)).not.toContain('bg-muted')
    cleanup()
    renderShell('/git', { unreadCount: 2 })
    const atRest = sidebar().querySelector('[data-slot="nav-unread-badge"]')
    expect(classes(atRest)).toEqual(expect.arrayContaining([...shape, 'bg-muted']))
    expect(atRest?.className).not.toMatch(/running|merged/)
    expect(atRest?.className).not.toMatch(TEAL)
  })

  it('draws the inbox count soft amber through its tokens, and the skills marker as a 6px --info dot', () => {
    renderShell('/git', { inboxCount: 4, skillsUpdateAvailable: true })
    const inbox = sidebar().querySelector('[data-slot="nav-badge"]')
    expect(inbox?.textContent).toBe('4')
    expect(classes(inbox)).toEqual(expect.arrayContaining(['bg-inbox-count', 'text-inbox-count-foreground', 'text-[11px]', 'font-semibold']))
    expect(inbox?.className).not.toMatch(TEAL)
    const dot = sidebar().querySelector('[data-slot="nav-update-marker"] > span[aria-hidden]')
    expect(classes(dot)).toEqual(expect.arrayContaining(['size-[6px]', 'rounded-full', 'bg-info']))
  })

  it('gives the mobile drawer, the same nav, the same selected row', () => {
    renderShell('/git')
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const selected = document.querySelectorAll('nav[aria-label="Main"] a[aria-current="page"]')
    expect(selected).toHaveLength(2)
    for (const link of selected) expect(classes(link)).toEqual(expect.arrayContaining(SELECTED))
  })

  it('marks the active footer icon with a 36px square on the selected fill', () => {
    renderShell('/settings/global/appearance', { projectGroups: <div /> })
    const settings = sidebar().querySelector('[data-slot="global-settings-link"]') as HTMLElement
    expect(settings.getAttribute('aria-current')).toBe('page')
    expect(classes(settings)).toEqual(expect.arrayContaining(['size-[36px]', 'bg-sidebar-row-selected', 'text-foreground']))
    const allTasks = sidebar().querySelector('[data-slot="all-tasks-link"]') as HTMLElement
    expect(allTasks.getAttribute('aria-current')).toBeNull()
    expect(classes(allTasks)).toContain('size-[36px]')
    expect(classes(allTasks)).not.toContain('bg-sidebar-row-selected')
    cleanup()
    renderShell('/tasks', { projectGroups: <div /> })
    const active = sidebar().querySelector('[data-slot="all-tasks-link"]') as HTMLElement
    expect(active.getAttribute('aria-current')).toBe('page')
    expect(classes(active)).toEqual(expect.arrayContaining(['size-[36px]', 'bg-sidebar-row-selected', 'text-foreground']))
    expect(active.innerHTML).not.toMatch(TEAL)
    const idle = sidebar().querySelector('[data-slot="global-settings-link"]') as HTMLElement
    expect(idle.getAttribute('aria-current')).toBeNull()
    expect(classes(idle)).not.toContain('bg-sidebar-row-selected')
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
