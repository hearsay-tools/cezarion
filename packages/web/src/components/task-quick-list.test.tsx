import { summaryOf } from '@/test/run-summary-fixture'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { setApiScope } from '@open-mercato/cezar-api-client'
import type { RunRecord, RunSummary } from '@open-mercato/cezar-api-client'
import { ListViewProvider } from '@/components/list-view'
import { ReferenceStatusProvider, ReferenceStatusRegistry } from '@/components/reference-status'
import { QuickListBuckets, SidebarSessionScope, TaskQuickList, TaskQuickListContainer } from '@/components/task-quick-list'
import { resetSwipeStore } from '@/components/use-swipe-to-archive'
import { groupRuns } from '@/lib/task-groups'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0

function run(over: Partial<RunRecord> = {}): RunSummary {
  seq += 1
  return summaryOf({
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: ago(60_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  })
}

/** Where the router currently is — the whole-row click vs nested-control assertions read this. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}

function renderList(
  props: Partial<Parameters<typeof TaskQuickList>[0]> = {},
  route = '/',
  repo?: { projectId: string; repoBase: string },
) {
  const onViewChange = props.onViewChange ?? vi.fn()
  const list = <TaskQuickList runs={[]} view="active" now={NOW} projectId="test-project" {...props} onViewChange={onViewChange} />
  const utils = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <Routes>
          <Route
            path="*"
            element={
              repo ? (
                <ReferenceStatusProvider projectId={repo.projectId} repoBase={repo.repoBase} requests={[]}>
                  {list}
                </ReferenceStatusProvider>
              ) : (
                list
              )
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { ...utils, onViewChange }
}

const location = () => screen.getByTestId('location').textContent

const bucket = (label: string): HTMLElement => {
  const node = document.querySelector(`[data-bucket="${label}"]`)
  if (!node) throw new Error(`no "${label}" bucket rendered`)
  return node as HTMLElement
}

const row = (id: string) => document.querySelector(`[data-run-id="${id}"]`)
const dotOf = (id: string) => document.querySelector(`[data-run-id="${id}"] [data-slot="status-dot"]`)

/** Existing metadata assertions exclude the separate session role/status line. */
function metadataText(element: Element | null | undefined): string {
  const copy = element?.cloneNode(true) as Element | undefined
  copy?.querySelectorAll('[data-slot="session-role-status"]').forEach(node => node.remove())
  return copy?.textContent ?? ''
}

/** The rendered text of each row under one bucket header, in order. */
const rowsIn = (label: string): string[] =>
  [...bucket(label).querySelectorAll('[data-slot="task-row"], [data-slot="group-tile"]')].map((el) =>
    metadataText(el).trim()
  )

afterEach(cleanup)

describe('status section folding (#811)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  describe('focus across live status moves', () => {
    afterEach(() => vi.unstubAllGlobals())
    const variants = () => [
      run({ id: 'va', groupId: 'g', variant: 'A', status: 'running' }),
      run({ id: 'vb', groupId: 'g', variant: 'B', status: 'running' }),
    ]
    const tree = (runs: RunSummary[]) => <QueryClientProvider client={createQueryClient()}><MemoryRouter>
      <button type="button">Outside navigation</button>
      <TaskQuickList projectId="focus" runs={runs} view="active" onViewChange={() => {}} />
    </MemoryRouter></QueryClientProvider>
    const control = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      expect(element).not.toBeNull()
      return element!
    }

    it.each(['group-tile', 'group-compare'])('retains the group %s control when its section changes', slot => {
      const runs = variants()
      // A run with the same id must not be mistaken for the group in an earlier section.
      const sameId = run({ id: 'g', status: 'waiting' })
      const { rerender } = render(tree([sameId, ...runs]))
      const selector = `[data-slot="${slot}"]`
      const previous = control(selector)
      act(() => previous.focus())
      expect(document.activeElement).toBe(previous)
      rerender(tree([sameId, ...runs.map(member => ({ ...member, status: 'done' as const }))]))
      const next = control(selector)
      expect(previous.isConnected).toBe(false)
      expect(next.closest('[data-bucket]')?.getAttribute('data-bucket')).toBe('Finished')
      expect(document.activeElement).toBe(next)
    })

    it.each(['group-tile', 'group-compare'])('focuses the folded destination disclosure for group %s', slot => {
      const runs = variants()
      const done = run({ id: 'done' })
      const { rerender } = render(tree([done, ...runs]))
      fireEvent.click(screen.getByRole('button', { name: 'Finished 1' }))
      act(() => control(`[data-slot="${slot}"]`).focus())
      rerender(tree([done, ...runs.map(member => ({ ...member, status: 'done' as const }))]))
      const disclosure = screen.getByRole('button', { name: 'Finished 3' })
      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      expect(document.querySelector('[data-slot="group-row"]')).toBeNull()
      expect(document.activeElement).toBe(disclosure)
    })

    it.each([false, true])('restores a shared reference or falls back to the group toggle when removed=%s', removed => {
      stubMedia({ noHover: false, desktop: true })
      const runs = variants().map(member => ({ ...member, referencedIssueUrl: 'https://github.com/o/r/issues/425' }))
      const { rerender } = render(tree(runs))
      const selector = '[data-slot="group-meta"] a'
      act(() => control(selector).focus())
      rerender(tree(runs.map(member => ({ ...member, status: 'done' as const, referencedIssueUrl: removed ? undefined : member.referencedIssueUrl }))))
      expect(document.activeElement).toBe(control(removed ? '[data-slot="group-tile"]' : selector))
    })

    it.each([false, true])('retains expanded member identity with destination folded=%s', folded => {
      const runs = variants()
      const done = run({ id: 'done' })
      const { rerender } = render(tree([done, ...runs]))
      fireEvent.click(control('[data-slot="group-tile"]'))
      if (folded) fireEvent.click(screen.getByRole('button', { name: 'Finished 1' }))
      const selector = '[data-run-id="vb"] a[href="/tasks/vb"]'
      act(() => control(selector).focus())
      rerender(tree([done, ...runs.map(member => ({ ...member, status: 'done' as const }))]))
      expect(document.activeElement).toBe(folded ? screen.getByRole('button', { name: 'Finished 3' }) : control(selector))
      if (!folded) expect(control('[data-slot="group-tile"]').getAttribute('aria-expanded')).toBe('true')
    })

    it('retains an individual run link across an unfolded status move', () => {
      const working = run({ id: 'work', status: 'running' })
      const { rerender } = render(tree([working]))
      act(() => control('[data-run-id="work"] a').focus())
      rerender(tree([{ ...working, status: 'done' }]))
      expect(document.activeElement).toBe(control('[data-run-id="work"] a'))
    })

    it('does not redirect focus on group removal to a run with the same id', () => {
      const runs = variants()
      const sameId = run({ id: 'g' })
      const { rerender } = render(tree([sameId, ...runs]))
      act(() => control('[data-slot="group-tile"]').focus())
      rerender(tree([sameId]))
      expect(document.activeElement).toBe(document.body)
    })

    it.each([false, true])('does not steal focus after outside navigation, blurred=%s', blurred => {
      const runs = variants()
      const { rerender } = render(tree(runs))
      act(() => control('[data-slot="group-tile"]').focus())
      const outside = screen.getByRole('button', { name: 'Outside navigation' })
      act(() => outside.focus())
      if (blurred) act(() => outside.blur())
      rerender(tree(runs.map(member => ({ ...member, status: 'done' as const }))))
      expect(document.activeElement).toBe(blurred ? document.body : outside)
    })

    it.each(['before return', 'after return'])('forgets removed group focus when outside navigation blurs %s', when => {
      const runs = variants()
      const other = run({ id: 'other' })
      const { rerender } = render(tree([other, ...runs]))
      act(() => control('[data-slot="group-tile"]').focus())
      rerender(tree([other]))
      expect(document.activeElement).toBe(document.body)
      const outside = screen.getByRole('button', { name: 'Outside navigation' })
      act(() => outside.focus())
      if (when === 'before return') act(() => outside.blur())
      rerender(tree([other, ...runs]))
      if (when === 'after return') {
        expect(document.activeElement).toBe(outside)
        act(() => outside.blur())
        rerender(tree([{ ...other, title: 'Unrelated title update' }, ...runs]))
      }
      expect(document.activeElement).toBe(document.body)
    })
  })

  it('starts expanded, folds independently, and remembers each section after remount', () => {
    const runs = [run({ id: 'ask', status: 'waiting' }), run({ id: 'done' }), run({ id: 'work', status: 'running' })]
    renderList({ runs })
    const toggle = screen.getByRole('button', { name: 'Finished 1' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(row('done')).toBeNull()
    expect(row('ask')).not.toBeNull()
    expect(row('work')).not.toBeNull()
    cleanup()
    renderList({ runs })
    expect(screen.getByRole('button', { name: 'Finished 1' }).getAttribute('aria-expanded')).toBe('false')
    expect(row('done')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Finished 1' }))
    expect(row('done')).not.toBeNull()
  })

  it('shows full task counts and live attention for folded sections, including capped variants', () => {
    const runs = [run({ id: 'a', groupId: 'g', variant: 'A', status: 'waiting' }), run({ id: 'b', groupId: 'g', variant: 'B' }), run({ id: 'c' })]
    renderList({ runs, rowLimit: 1 })
    const toggle = screen.getByRole('button', { name: 'Needs you 2' })
    fireEvent.click(toggle)
    expect(within(toggle).getByRole('img', { name: 'needs you' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finished 1' })).toBeTruthy()
    cleanup()
    renderList({ runs: [...runs, run({ id: 'new', status: 'review' })], rowLimit: 1 })
    expect(screen.getByRole('button', { name: 'Needs you 3' }).getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-slot="group-row"]')).toBeNull()
  })

  it('offers only the unpinned Finished sweep even when folded and every row is capped', () => {
    const onSweep = vi.fn()
    renderList({ runs: [run({ id: 'plain' }), run({ id: 'pin', pinned: true })], rowLimit: 0, onSweep })
    fireEvent.click(screen.getByRole('button', { name: 'Finished 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive all' }))
    expect(onSweep).toHaveBeenCalledExactlyOnceWith('unpinned')
    expect(document.querySelector('[data-scope="pinned"]')).toBeNull()
  })

  it('moves live updates into saved folded sections without duplication, retaining attention and focus', () => {
    const done = run({ id: 'done', status: 'done', finishedAt: ago(1000) })
    const working = run({ id: 'move', status: 'running' })
    const tree = (runs: RunSummary[]) => <QueryClientProvider client={createQueryClient()}><MemoryRouter><TaskQuickList projectId="live" runs={runs} view="active" onViewChange={() => {}} /></MemoryRouter></QueryClientProvider>
    const { rerender } = render(tree([done, working]))
    fireEvent.click(screen.getByRole('button', { name: 'Finished 1' }))
    act(() => (row('move')?.querySelector('a') as HTMLElement).focus())
    rerender(tree([done, { ...working, status: 'failed', finishedAt: ago(500) }]))
    const folded = screen.getByRole('button', { name: 'Finished 2' })
    expect(folded.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(folded)
    expect(within(folded).getByRole('img', { name: 'failed' })).toBeTruthy()
    expect(within(folded).getByRole('img', { name: 'unread' })).toBeTruthy()
    expect(row('move')).toBeNull()
    fireEvent.click(folded)
    expect(document.querySelectorAll('[data-run-id="move"]')).toHaveLength(1)
    expect(document.querySelector('[data-bucket="Working"]')).toBeNull()
  })

  it('shares section state between mounted copies, handles corrupt storage and stays usable when writes fail', () => {
    localStorage.setItem('cez-sidebar-sections-collapsed', '{broken')
    const runs = [run()]
    const first = renderList({ runs, projectId: 'same' })
    const second = renderList({ runs, projectId: 'same' })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      fireEvent.click(within(first.container).getByRole('button', { name: 'Finished 1' }))
      expect(within(second.container).getByRole('button', { name: 'Finished 1' }).getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(within(second.container).getByRole('button', { name: 'Finished 1' }))
      expect(within(first.container).getByRole('button', { name: 'Finished 1' }).getAttribute('aria-expanded')).toBe('true')
    } finally { write.mockRestore() }
  })
})

describe('TaskQuickList', () => {
  it('renders the buckets in the mockup order with their runs', () => {
    renderList({
      runs: [
        run({ id: 'a', title: 'Structured changes endpoint', status: 'review', pinned: true }),
        run({ id: 'pin', title: 'Kept', pinned: true }),
        run({ id: 'b', title: 'Normalize agent-event protocol', status: 'running' }),
        run({ id: 'c', title: 'README parallel-agents tagline', status: 'done' }),
      ],
    })

    const headers = [...document.querySelectorAll('[data-slot="quick-list-bucket"] h2')].map((h) => h.textContent)
    expect(headers).toEqual(['Needs you 1', 'Finished 2', 'Working 1'])
    expect(rowsIn('Needs you')).toEqual(['Structured changes endpointneeds review · 1m'])
    expect(rowsIn('Working')).toEqual(['Normalize agent-event protocolrunning · 1m'])
    expect(rowsIn('Finished')).toEqual(['Kept1m', 'README parallel-agents tagline1m'])
  })

  it('links every row to its task', () => {
    renderList({ runs: [run({ id: 'abc123', title: 'Bump zod to v4' })] })
    expect(screen.getByRole('link', { name: /Bump zod to v4/ }).getAttribute('href')).toBe('/tasks/abc123')
  })

  it('links the PR chip out without hijacking it, while a row click opens the task', () => {
    const onTogglePin = vi.fn()
    renderList({
      runs: [
        run({
          id: 'pr1',
          title: 'Has a PR',
          status: 'review',
          pullRequestUrl: 'https://github.com/o/r/pull/7',
        }),
      ],
      onTogglePin,
    })

    const title = row('pr1')?.querySelector('a[href="/tasks/pr1"]') as HTMLElement
    expect(title).not.toBeNull()
    expect(title.tagName).toBe('A')

    const chip = within(row('pr1') as HTMLElement).getByRole('link', {
      name: 'Open the pull request for Has a PR',
    })
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/7')
    expect(chip.getAttribute('target')).toBe('_blank')
    expect(chip.getAttribute('rel')).toBe('noopener noreferrer')

    const stopJsdomNav = (event: Event) => event.preventDefault()
    document.addEventListener('click', stopJsdomNav)
    fireEvent.click(chip)
    document.removeEventListener('click', stopJsdomNav)
    expect(location()).toBe('/')

    fireEvent.click(within(row('pr1') as HTMLElement).getByRole('button', { name: 'Pin task' }))
    expect(onTogglePin).toHaveBeenCalledOnce()
    expect(location()).toBe('/')

    fireEvent.click(dotOf('pr1') as HTMLElement)
    expect(location()).toBe('/tasks/pr1')
  })

  it('opens the task from a click on empty padding in the row', () => {
    renderList({ runs: [run({ id: 'pad', title: 'Padded row' })] })
    fireEvent.click(row('pad') as HTMLElement)
    expect(location()).toBe('/tasks/pad')
  })

  it('does not open the task from a click whose target is outside the row', () => {
    // The reference-status card is a Radix portal on document.body. React still bubbles that
    // click through RunRow; the target is not a descendant, so the row must not navigate.
    renderList({ runs: [run({ id: 'pad', title: 'Padded row' })] })
    const rowEl = row('pad') as HTMLElement
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    const click = createEvent.click(rowEl)
    Object.defineProperty(click, 'target', { value: outside })
    fireEvent(rowEl, click)
    expect(location()).toBe('/')
  })

  it('names a row by its auto-summary once one exists — the title, the tooltip and the PR chip agree', () => {
    renderList({
      runs: [
        run({
          id: 'sum',
          title: 'fix the login bug plz',
          titleSummary: 'Catch AuthError in the login handler',
          status: 'review',
          pullRequestUrl: 'https://github.com/o/r/pull/9',
        }),
        run({ id: 'raw', title: 'fix the search crash' }),
      ],
    })

    const link = row('sum')?.querySelector('a[href="/tasks/sum"]') as HTMLElement
    expect(link.textContent).toContain('Catch AuthError in the login handler')
    expect(link.getAttribute('title')).toBe('Catch AuthError in the login handler')
    expect(metadataText(row('sum'))).not.toContain('fix the login bug plz')
    expect(
      within(row('sum') as HTMLElement).getByRole('link', {
        name: 'Open the pull request for Catch AuthError in the login handler',
      })
    ).not.toBeNull()
    // No summary yet (or a pre-R2 record) → the raw title, honestly.
    expect(within(row('raw') as HTMLElement).getByRole('link', { name: /fix the search crash/ })).not.toBeNull()
  })

  it('shows the diff pair when a turn recorded one, and nothing when none exists', () => {
    renderList({
      runs: [
        run({ id: 'diffed', title: 'Has a diff', status: 'review', diffStat: { adds: 42, dels: 7, files: 3 } }),
        run({ id: 'plain', title: 'No diff yet', status: 'review' }),
      ],
    })

    const pair = row('diffed')?.querySelector('[data-slot="diff-stat"]')
    expect(pair?.textContent).toBe('+42 −7')
    // Two colored halves through the design tokens — green adds, red dels, like the mockup.
    expect(pair?.querySelector('.text-success')?.textContent).toBe('+42')
    expect(pair?.querySelector('.text-danger')?.textContent).toBe('−7')
    // A sidebar row has no ± column to hold an em dash open for — absence is just absence.
    expect(row('plain')?.querySelector('[data-slot="diff-stat"]')).toBeNull()
    expect(metadataText(row('plain'))).not.toContain('—')
  })

  it('flags a repointed-worktree diff so the sidebar number explains itself (#751)', () => {
    renderList({
      runs: [
        run({ id: 'review', title: 'Review PR 694', status: 'review', diffStat: { adds: 1, dels: 0, files: 1, repointed: true } }),
        run({ id: 'own', title: 'Own work', status: 'review', diffStat: { adds: 42, dels: 7, files: 3 } }),
      ],
    })

    const narrowed = row('review')?.querySelector('[data-slot="diff-stat"]')
    expect(narrowed?.textContent).toBe('+1 −0')
    expect(narrowed?.getAttribute('data-repointed')).toBe('true')
    expect(narrowed?.getAttribute('title')).toContain('as this task found it')
    // A task working on its own branch is untouched by the annotation.
    expect(row('own')?.querySelector('[data-slot="diff-stat"]')?.getAttribute('data-repointed')).toBeNull()
  })

  it('marks the row for the open task active, from the route', () => {
    const runs = [run({ id: 'open', title: 'Open one' }), run({ id: 'other', title: 'Other one' })]
    renderList({ runs, currentRunId: 'open' }, '/tasks/open')

    const active = document.querySelectorAll('[data-slot="task-row"] a[aria-current="page"]')
    expect(active).toHaveLength(1)
    expect(active[0]?.getAttribute('href')).toBe('/tasks/open')
    expect(row('open')?.getAttribute('data-active')).toBe('true')
    expect(row('other')?.getAttribute('data-active')).toBeNull()
  })

  describe('status dots', () => {
    it('paints one dot per row, from deriveAttention', () => {
      renderList({
        runs: [
          run({ id: 'w', status: 'waiting' }),
          run({ id: 'v', status: 'review' }),
          run({ id: 'r', status: 'running' }),
          run({ id: 'd', status: 'done' }),
          run({ id: 'f', status: 'failed' }),
        ],
      })
      expect(dotOf('w')?.getAttribute('data-tone')).toBe('pending')
      expect(dotOf('v')?.getAttribute('data-tone')).toBe('info')
      expect(dotOf('r')?.getAttribute('data-tone')).toBe('running')
      expect(dotOf('d')?.getAttribute('data-tone')).toBe('success')
      expect(dotOf('f')?.getAttribute('data-tone')).toBe('danger')

      // Exactly one dot per row — the design system's "a single 7px dot per row" rule.
      expect(document.querySelectorAll('[data-run-id="w"] [data-slot="status-dot"]')).toHaveLength(1)
      expect(dotOf('w')?.getAttribute('aria-label')).toBe('needs you')
    })

    it('pulses the transitioning rows only', () => {
      renderList({ runs: [run({ id: 'r', status: 'running' }), run({ id: 'd', status: 'done' })] })
      expect(dotOf('r')?.className).toContain('animate-pulse')
      expect(dotOf('d')?.className).not.toContain('animate-pulse')
    })
  })

  describe('the PR chip', () => {
    it('appears only when the run has a pullRequestUrl, and opens it', () => {
      renderList({
        runs: [
          run({ id: 'with', title: 'Has a PR', status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/7' }),
          run({ id: 'without', title: 'No PR', status: 'review' }),
        ],
      })

      const chip = within(row('with') as HTMLElement).getByRole('link', {
        name: 'Open the pull request for Has a PR',
      })
      expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/7')
      expect(chip.getAttribute('target')).toBe('_blank')
      expect(chip.getAttribute('rel')).toBe('noopener noreferrer')

      expect(document.querySelector('[data-run-id="without"] [data-slot="pr-chip"]')).toBeNull()
    })

    it('also appears for a referenced PR — the task worked ON it (#407)', () => {
      renderList({
        runs: [
          run({
            id: 'ref',
            title: 'Review task',
            status: 'review',
            referencedPullRequestUrl: 'https://github.com/o/r/pull/4170',
          }),
        ],
      })
      const chip = within(row('ref') as HTMLElement).getByRole('link', {
        name: 'Open the pull request for Review task',
      })
      expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/4170')
    })

    it('is a sibling of the row link, not nested inside it', () => {
      // Two independent targets: the row opens the task, the chip opens the PR. An anchor inside
      // an anchor is invalid HTML, and only one of them would ever fire.
      renderList({ runs: [run({ id: 'x', pullRequestUrl: 'https://github.com/o/r/pull/7' })] })
      const chip = document.querySelector('[data-slot="pr-chip"]') as HTMLElement
      expect(chip.closest('a[href^="/tasks/"]')).toBeNull()
      expect(chip.closest('[data-slot="task-row"]')).toBe(row('x'))
    })

    it('sits on the meta line as plain text, after the state word and before the age (#617)', () => {
      renderList({
        runs: [run({ id: 'x', title: 'Has a PR', status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/7' })],
      })
      // Title on line one; state word, reference and age on line two.
      expect(rowsIn('Needs you')).toEqual(['Has a PRneeds review · PR #7 · 1m'])
    })

    it('carries the issue when no PR exists yet — the number the title prefix was about', () => {
      renderList({
        runs: [
          run({
            id: 'iss',
            title: '788: implementing readable task names',
            status: 'running',
            referencedIssueUrl: 'https://github.com/o/r/issues/788',
          }),
        ],
      })
      const chip = within(row('iss') as HTMLElement).getByRole('link', {
        name: 'Open the issue for 788: implementing readable task names',
      })
      expect(chip.getAttribute('href')).toBe('https://github.com/o/r/issues/788')
      // `#788`, not `Issue #788`: in this column the word costs six glyphs the name needs.
      expect(chip.textContent).toBe('#788')
    })

    it('still paints a number it cannot link — an inert chip beats losing the reference', () => {
      // A record that knows its PR number but has no URL (or a non-http one, #431). The title's
      // prefix is dropped in favour of the chip, so the chip has to exist or the number is gone.
      renderList({ runs: [run({ id: 'noturl', title: '402: no url for this one', prNumber: 402 })] })
      const chip = document.querySelector('[data-run-id="noturl"] [data-slot="pr-chip"]') as HTMLElement
      expect(chip.tagName).toBe('SPAN')
      expect(chip.textContent).toBe('PR #402')
    })
  })

  describe('the title vs. its metadata (#788, option C)', () => {
    it('drops the NNN: prefix the chip is already showing, and keeps the full title on hover', () => {
      renderList({
        runs: [
          run({
            id: 'dedup',
            title: '775: implementing comment threads',
            status: 'review',
            pullRequestUrl: 'https://github.com/o/r/pull/775',
          }),
        ],
      })

      const title = document.querySelector('[data-run-id="dedup"] [data-slot="task-row-title"]')
      expect(title?.textContent).toBe('implementing comment threads')
      // Nothing is lost: the number is a chip, and the stored title is still the row's tooltip.
      expect(document.querySelector('[data-run-id="dedup"] [data-slot="pr-chip"]')?.textContent).toBe('PR #775')
      expect(
        document.querySelector('[data-run-id="dedup"] a[href="/tasks/dedup"]')?.getAttribute('title')
      ).toBe('775: implementing comment threads')
    })

    it('keeps the prefix when it is a DIFFERENT number from the chip — two facts, not one', () => {
      // Opened on issue #788, shipped as PR #790. Stripping `788: ` here would delete the only
      // place the issue number appears.
      renderList({
        runs: [
          run({
            id: 'two',
            title: '788: implementing readable task names',
            status: 'review',
            pullRequestUrl: 'https://github.com/o/r/pull/790',
            referencedIssueUrl: 'https://github.com/o/r/issues/788',
          }),
        ],
      })
      expect(document.querySelector('[data-run-id="two"] [data-slot="task-row-title"]')?.textContent).toBe(
        '788: implementing readable task names'
      )
      expect(document.querySelector('[data-run-id="two"] [data-slot="pr-chip"]')?.textContent).toBe('PR #790')
    })

    it('keeps a leading number that is not a reference at all', () => {
      renderList({ runs: [run({ id: 'year', title: '2026: the year in review' })] })
      expect(document.querySelector('[data-run-id="year"] [data-slot="task-row-title"]')?.textContent).toBe(
        '2026: the year in review'
      )
    })

    it('gives the title a floor and makes the diff pair the element that drops', () => {
      // The worst case from the issue: a title competing with a 5-digit diff pair, a PR chip and
      // the unread dot all at once. The title must still be the growing element with a floor,
      // and the diff pair must be the one carrying the container query that drops it.
      renderList({
        runs: [
          run({
            id: 'worst',
            title: '775: implementing comment threads across the whole thread view',
            status: 'done',
            finishedAt: ago(60_000),
            diffStat: { adds: 59_514, dels: 12_160, files: 208 },
            pullRequestUrl: 'https://github.com/o/r/pull/775',
          }),
        ],
      })

      const rowEl = row('worst') as HTMLElement
      const title = rowEl.querySelector('[data-slot="task-row-title"]') as HTMLElement
      expect(title.className).toContain('min-w-[7rem]')
      expect(title.className).toContain('flex-1')
      expect(title.className).toContain('text-[13px]')
      expect(title.textContent).toBe('implementing comment threads across the whole thread view')

      const diff = rowEl.querySelector('[data-slot="diff-stat"]') as HTMLElement
      // Hidden by default at the 232px column, back once the column is dragged past 23rem —
      // the width at which the pair fits without costing the name any of its default budget.
      expect(diff.className).toContain('hidden')
      expect(diff.className).toContain('@min-[23rem]/sidebar:inline')
      expect(diff.className).toContain('text-[12px]')
      expect(diff.className).not.toContain('text-[11px]')
      // Dropped from view, never from reach — the exact numbers stay in its tooltip.
      expect(diff.getAttribute('title')).toBe('+59514 −12160 across 208 files')

      // Everything the row paints, in reading order: name and diff on line one; reference and
      // age on the meta line (a done row has no state word — its green dot says it).
      expect(rowsIn('Finished')).toEqual(['implementing comment threads across the whole thread view+59,514 −12,160PR #775 · 1m'])
    })

    it('lets the collapsed group title truncate before its ×N chip does', () => {
      renderList({
        runs: [
          run({ id: 'ga', title: 'Add skills autocomplete (A)', groupId: 'g', variant: 'A' }),
          run({ id: 'gb', title: 'Add skills autocomplete (B)', groupId: 'g', variant: 'B' }),
        ],
      })
      // #617 01a: the group title flexes and truncates; its ×N chip is what never gives way.
      const tileTitle = document.querySelector('[data-slot="group-title"]') as HTMLElement
      expect(tileTitle.className).toContain('truncate')
      expect(tileTitle.className).toContain('min-w-0')
      expect(document.querySelector('[data-slot="group-count"]')?.className).toContain('shrink-0')
    })
  })

  describe('ages and queue positions', () => {
    it('shows a compact age, from finishedAt once the run is over', () => {
      renderList({
        runs: [
          run({
            id: 'old',
            title: 'Old',
            status: 'done',
            createdAt: ago(9 * 3_600_000),
            finishedAt: ago(2 * 3_600_000),
          }),
          run({ id: 'new', title: 'New', status: 'running', createdAt: ago(4 * 60_000) }),
        ],
      })
      expect(metadataText(row('old'))).toBe('Old2h')
      const age = row('old')!.querySelector('[data-slot="task-row-age"]') as HTMLElement
      expect(age.textContent).toBe('2h')
      expect(age.classList.contains('sr-only')).toBe(false)
      expect(age.closest('[data-slot="task-row-meta"]')?.className).toContain('text-[11.5px]')
      expect(metadataText(row('new'))).toBe('Newrunning · 4m')
    })

    it('shows the queue position instead of an age for queued runs', () => {
      renderList({
        runs: [
          run({ id: 'q1', title: 'First', status: 'queued', createdAt: ago(120_000) }),
          run({ id: 'q2', title: 'Second', status: 'queued', createdAt: ago(60_000) }),
        ],
      })
      // The position rides in the state word (`queued #2`), in place of an age.
      expect(metadataText(row('q1'))).toBe('Firstqueued #1')
      expect(metadataText(row('q2'))).toBe('Secondqueued #2')
    })

    it('keeps the queue position even when the row has a reference chip', () => {
      // The chip takes the AGE's slot, never the queue position's: `#1` is where the engine will
      // pick this run up, it is carried nowhere else in the row, and an issue-driven queued run —
      // an issue reference, no PR yet — is exactly the shape that would have silently lost it.
      renderList({
        runs: [
          run({
            id: 'qref',
            title: '788: queued on an issue',
            status: 'queued',
            createdAt: ago(120_000),
            referencedIssueUrl: 'https://github.com/o/r/issues/788',
          }),
        ],
      })
      expect(metadataText(row('qref'))).toBe('queued on an issuequeued #1 · #788')
    })

    it('keeps the age beside the reference on the meta line — there is room for both now (#617)', () => {
      renderList({
        runs: [
          run({
            id: 'aged',
            title: 'Finished with a PR',
            status: 'done',
            finishedAt: ago(2 * 3_600_000),
            pullRequestUrl: 'https://github.com/o/r/pull/9',
          }),
        ],
      })
      expect(metadataText(row('aged'))).toBe('Finished with a PRPR #9 · 2h')
    })
  })

  describe('item links (#692)', () => {
    const REPO = { projectId: 'api', repoBase: 'https://github.com/o/r' }

    it('opens the task item tab from an own-repo chip and keeps GitHub for a foreign one', () => {
      renderList(
        {
          runs: [
            run({ id: 'own', title: 'Own PR', status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/7' }),
            run({ id: 'foreign', title: 'Foreign PR', status: 'review', pullRequestUrl: 'https://github.com/x/y/pull/8' }),
          ],
        },
        '/',
        REPO,
      )
      const own = within(row('own') as HTMLElement).getByRole('link', { name: 'Open the pull request for Own PR' })
      expect(own.getAttribute('href')).toBe('/p/api/tasks/own/pr/7')
      expect(own.getAttribute('target')).toBeNull()
      const foreign = within(row('foreign') as HTMLElement).getByRole('link', { name: 'Open the pull request for Foreign PR' })
      expect(foreign.getAttribute('href')).toBe('https://github.com/x/y/pull/8')
    })

    it('points a group’s shared chip at the first member’s item tab', () => {
      const shared = { pullRequestUrl: 'https://github.com/o/r/pull/7' }
      renderList(
        {
          runs: [
            run({ id: 'ga', groupId: 'g', variant: 'A', title: 'Group (A)', status: 'running', ...shared }),
            run({ id: 'gb', groupId: 'g', variant: 'B', title: 'Group (B)', status: 'running', ...shared }),
          ],
        },
        '/',
        REPO,
      )
      const chip = document.querySelector('[data-slot="group-meta"] [data-slot="pr-chip"]')
      expect(chip?.getAttribute('href')).toBe('/p/api/tasks/ga/pr/7')
    })
  })

  describe('variant groups', () => {
    const variants = () => [
      run({
        id: 'va',
        groupId: 'g1',
        variant: 'A',
        title: 'Add skills autocomplete (A)',
        status: 'running',
        runner: 'claude',
        tokensUsed: 96_249,
        inputTokens: 92_000,
        outputTokens: 4_249,
        costUsd: 0.31,
      }),
      run({
        id: 'vb',
        groupId: 'g1',
        variant: 'B',
        title: 'Add skills autocomplete (B)',
        status: 'running',
        runner: 'codex',
        tokensUsed: 41_800,
        inputTokens: 40_000,
        outputTokens: 1_800,
        costUsd: 0.12,
      }),
    ]

    it('collapses into one tile with the shared title and an ×N count', () => {
      renderList({ runs: variants() })

      const tile = screen.getByRole('button', { expanded: false })
      // The toggle is line 1 only; line 2 (the aggregate in words, #617 01a) sits beside it,
      // because it can hold reference links and a link inside a button is invalid.
      expect(tile.textContent).toBe('Add skills autocomplete×2')
      expect(document.querySelector('[data-slot="group-meta"]')?.textContent).toBe('2 working · 1m')
      // Collapsed: the members are not rows of their own.
      expect(row('va')).toBeNull()
      expect(row('vb')).toBeNull()
    })

    it('expands and collapses on click, showing a lettered row per variant', () => {
      renderList({ runs: variants() })

      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(screen.getByRole('button', { name: /Add skills autocomplete/, expanded: true })).not.toBeNull()

      // The letter chip, its own dot, and what actually differs between the variants.
      // Line two is the meta line: state word (and references), never an age (#617 decision 1).
      // Line 1 `runner · $cost`, line 2 state · tokens (#617 01a).
      expect(metadataText(row('va'))).toBe('Aclaude · $0.31running · IN 92.0k · OUT 4.2k')
      expect(metadataText(row('vb'))).toBe('Bcodex · $0.12running · IN 40.0k · OUT 1.8k')
      expect(dotOf('va')?.getAttribute('data-tone')).toBe('running')
      // Each variant is still its own deep link.
      expect(row('vb')?.querySelector('a')?.getAttribute('href')).toBe('/tasks/vb')

      fireEvent.click(screen.getByRole('button', { name: /Add skills autocomplete/, expanded: true }))
      expect(row('va')).toBeNull()
    })

    it('offers a ⚖ compare link beside the tile, pointing at /compare/:groupId', () => {
      renderList({ runs: variants() })

      // A sibling of the toggle button, never its child — a link inside a button is invalid.
      const link = screen.getByRole('link', { name: 'Compare the variants of Add skills autocomplete' })
      expect(link.getAttribute('href')).toBe('/compare/g1')
      expect(link.closest('button')).toBeNull()
    })

    it('omits unknown token directions while preserving independently visible cost', () => {
      renderList({
        runs: variants().map((v, i) =>
          i === 0 ? { ...v, inputTokens: undefined, outputTokens: undefined } : v,
        ),
      })
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(metadataText(row('va'))).toBe('Aclaude · $0.31running')
    })

    it('gates variant token directions and cost independently', () => {
      renderList({ runs: variants(), showTokens: false, showCost: true })
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(metadataText(row('va'))).toBe('Aclaude · $0.31running')
      expect(metadataText(row('vb'))).toBe('Bcodex · $0.12running')
    })
  })

  describe('the pin (#935)', () => {
    it('renders pinned runs in their status section after Needs you, once', () => {
      renderList({
        runs: [
          run({ id: 'waiting', title: 'Wants you', status: 'waiting' }),
          run({ id: 'kept', title: 'The one I live in', status: 'done', pinned: true }),
        ],
        onTogglePin: vi.fn(),
      })
      const headers = [...document.querySelectorAll('[data-slot="quick-list-bucket"] h2')].map((h) => h.textContent)
      expect(headers).toEqual(['Needs you 1', 'Finished 1'])
      expect(rowsIn('Finished')).toHaveLength(1)
      expect(bucket('Finished').querySelector('[data-run-id="kept"]')).not.toBeNull()
      expect(bucket('Needs you').querySelector('[data-run-id="kept"]')).toBeNull()
    })

    it('offers Pin on an ordinary row and Unpin on a pinned one, reporting the state asked for', () => {
      const onTogglePin = vi.fn()
      renderList({
        runs: [run({ id: 'plain', status: 'done' }), run({ id: 'kept', status: 'done', pinned: true })],
        onTogglePin,
      })

      fireEvent.click(within(row('plain') as HTMLElement).getByRole('button', { name: 'Pin task' }))
      expect(onTogglePin.mock.calls[0]?.[1]).toBe(true)

      fireEvent.click(within(row('kept') as HTMLElement).getByRole('button', { name: 'Unpin task' }))
      expect(onTogglePin.mock.calls[1]?.[1]).toBe(false)
      expect(onTogglePin.mock.calls[1]?.[0]).toMatchObject({ id: 'kept' })
    })

    it('does not keep the pin visible on the current unpinned task', () => {
      renderList({
        runs: [run({ id: 'open', status: 'running' })],
        currentRunId: 'open',
        onTogglePin: vi.fn(),
      })
      const pin = row('open')!.querySelector('[data-slot="pin-toggle"]') as HTMLElement
      expect(pin.getAttribute('data-pinned')).toBeNull()
      expect(pin.className).toContain('opacity-0')
      expect(pin.className).not.toContain('group-focus-within')
      expect(pin.className).toContain('group-hover/task-row:opacity-100')
      // Keyboard focus anywhere in the row reveals it; a click's lingering `:focus` does not.
      expect(pin.className).toContain('group-has-[:focus-visible]/task-row:opacity-100')
    })

    it('stays reachable on a device that cannot hover — the drawer has no pointer', () => {
      // The bug this pins: the control was revealed by `group-hover` and focus alone, so on a
      // phone (where this same list IS the drawer) there was no way to reach it at all. The
      // honest axis is the pointer, not the viewport — the drawer keeps the sidebar's fixed
      // 232px, so a `md:` rule would have been wrong in both directions.
      renderList({ runs: [run({ id: 'plain', status: 'done' })], onTogglePin: vi.fn() })
      const pin = document.querySelector('[data-slot="pin-toggle"]') as HTMLElement
      expect(pin.className).toContain('no-hover:opacity-100')
      // …and big enough for a thumb there, where 20px is not a target — in a slot that is
      // 44px wide on that device all the time, so the reveal still moves nothing.
      expect(pin.className).toContain('no-hover:min-h-11')
      expect(pin.className).toContain('no-hover:min-w-11')
      expect(pin.closest('[data-slot="task-row-trailing"]')?.className).toContain('no-hover:w-11')
      // The quiet default survives for pointer devices: invisible until hovered.
      expect(pin.className).toContain('opacity-0')
    })

    it('paints no pin control at all when no container wired one', () => {
      renderList({ runs: [run({ id: 'plain', status: 'done' })] })
      expect(document.querySelector('[data-slot="pin-toggle"]')).toBeNull()
    })

    it('paints none in the archived view either — `groupRuns` never reads the pin there', () => {
      renderList({
        view: 'archived',
        runs: [run({ id: 'gone', status: 'done', archived: true })],
        onTogglePin: vi.fn(),
      })
      expect(document.querySelector('[data-slot="pin-toggle"]')).toBeNull()
    })

    it('keeps the status dot on a pinned row', () => {
      renderList({ runs: [run({ id: 'kept', status: 'waiting', pinned: true })], onTogglePin: vi.fn() })
      expect(dotOf('kept')?.getAttribute('data-tone')).toBe('pending')
    })
  })

  describe('the Active/Archived tabs', () => {
    const runs = () => [
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'waiting' }),
      run({ id: 'c', status: 'done', archived: true }),
    ]

    it('shows counts and which view is on', () => {
      renderList({ runs: runs(), view: 'active' })
      const active = screen.getByRole('button', { name: /Active/ })
      const archived = screen.getByRole('button', { name: /Archived/ })
      expect(active.textContent).toBe('Active2')
      expect(archived.textContent).toBe('Archived1')
      expect(active.getAttribute('aria-pressed')).toBe('true')
      expect(archived.getAttribute('aria-pressed')).toBe('false')
    })

    it('reports the view the user picked', () => {
      const { onViewChange } = renderList({ runs: runs(), view: 'active' })
      fireEvent.click(screen.getByRole('button', { name: /Archived/ }))
      expect(onViewChange).toHaveBeenCalledWith('archived')
    })

    it('renders no count for an empty bucket', () => {
      renderList({ runs: [run({ status: 'running' })] })
      // "Archived 0" is noise — an empty bucket says so by being empty.
      expect(screen.getByRole('button', { name: /Archived/ }).textContent).toBe('Archived')
    })

    it('flags waiting runs on the Active tab only while you are looking elsewhere', () => {
      const { unmount } = renderList({ runs: runs(), view: 'archived' })
      expect(document.querySelector('[data-slot="waiting-dot"]')?.getAttribute('data-tone')).toBe('pending')
      unmount()

      // On the Active view the rows themselves say it — the tab dot would be noise.
      renderList({ runs: runs(), view: 'active' })
      expect(document.querySelector('[data-slot="waiting-dot"]')).toBeNull()
    })

    it('shows the archived view when asked', () => {
      renderList({ runs: runs(), view: 'archived' })
      expect(rowsIn('Archived')).toHaveLength(1)
      expect(row('a')).toBeNull()
      expect(row('c')).not.toBeNull()
    })
  })

  describe('empty states', () => {
    it('says there are no tasks, without inventing any', () => {
      renderList({ runs: [], view: 'active' })
      expect(screen.getByText('No tasks yet — describe one.')).not.toBeNull()
      expect(document.querySelectorAll('[data-slot="task-row"]')).toHaveLength(0)
    })

    it('says the archive is empty', () => {
      renderList({ runs: [run({ status: 'done' })], view: 'archived' })
      expect(screen.getByText('Nothing archived yet.')).not.toBeNull()
    })
  })
})

describe('TaskQuickListContainer', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  function renderContainer(runs: RunSummary[], route = '/') {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(runs), { status: 200 }))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[route]}>
          <ListViewProvider>{children}</ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    return render(<TaskQuickListContainer />, { wrapper })
  }

  it('renders nothing until /api/v1/runs answers — no invented rows, no premature empty state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    renderContainer([])
    expect(screen.queryByText('No tasks yet — describe one.')).toBeNull()
    expect(document.querySelector('[data-slot="quick-list"]')).toBeNull()
  })

  it('renders the live run list', async () => {
    renderContainer([run({ id: 'live', title: 'A real run', status: 'running' })])
    expect(await screen.findByText('A real run')).not.toBeNull()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/run-summaries?archived=recent')
  })

  it('lights the row for the task open at /tasks/:id, including its child routes', async () => {
    renderContainer([run({ id: 'open', title: 'Open one' })], '/tasks/open/changes')
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="task-row"] a[aria-current="page"]')?.getAttribute('href')
      ).toBe('/tasks/open')
    )
  })

  it('pins a row through POST /pin, in the active project scope (#935)', async () => {
    const sent: Array<{ path: string; body: unknown }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).replace('?archived=recent', '')
      if (init.method === 'POST') {
        sent.push({ path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify([run({ id: 'live', title: 'A real run', status: 'running' })]), {
        status: 200,
      })
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/']}>
          <ListViewProvider>{children}</ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    render(<TaskQuickListContainer />, { wrapper })

    fireEvent.click(await screen.findByRole('button', { name: 'Pin task' }))
    await waitFor(() =>
      expect(sent).toEqual([{ path: '/api/v1/runs/live/pin', body: { pinned: true } }]),
    )
  })

  it('caps sidebar history at ten rows while retaining every pinned task', async () => {
    renderContainer([
      ...Array.from({ length: 14 }, (_, i) => run({ id: `recent-${i}`, title: `Recent ${i}`, status: 'done' })),
      run({ id: 'pinned', title: 'Pinned history', status: 'done', pinned: true }),
      run({ id: 'attention-pin', title: 'Pinned attention', status: 'waiting', pinned: true }),
    ])
    await screen.findByText('Pinned history')
    expect(document.querySelectorAll('[data-slot="task-row"]')).toHaveLength(12)
    expect(screen.getByText('Pinned attention')).toBeTruthy()
  })

  it('drives the sidebar Active/Archived view', async () => {
    renderContainer([run({ id: 'a', status: 'running' }), run({ id: 'b', status: 'done', archived: true })])

    fireEvent.click(await screen.findByRole('button', { name: /Archived/ }))

    await waitFor(() => expect(row('b')).not.toBeNull())
    expect(row('a')).toBeNull()
  })
})

describe('SidebarSessionScope', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    fetchMock.mockReset()
    vi.unstubAllGlobals()
    setApiScope(null)
  })

  it('keeps colliding run ids from different projects in combined counts and the waiting indicator', async () => {
    const sharedId = 'shared-across-projects'
    fetchMock.mockImplementation(async (input) => {
      const path = String(input).replace('?archived=recent', '')
      if (path === '/api/v1/run-summaries') {
        return new Response(JSON.stringify([run({ id: sharedId, status: 'running' })]), { status: 200 })
      }
      if (path === '/api/v1/projects') {
        return new Response(
          JSON.stringify({
            projects: [
              {
                id: 'cezar',
                name: 'cezar',
                root: '/cezar',
                addedAt: '2026-07-01T00:00:00.000Z',
                lastOpenedAt: '2026-07-20T12:00:00.000Z',
                source: 'local',
                status: 'ok',
              },
              {
                id: 'shop',
                name: 'shop',
                root: '/shop',
                addedAt: '2026-07-01T00:00:00.000Z',
                lastOpenedAt: '2026-07-19T00:00:00.000Z',
                source: 'local',
                status: 'ok',
              },
            ],
            bootProject: 'cezar',
            projectsDir: '/projects',
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    })
    const client = createQueryClient()
    client.setQueryData(['shop', 'runs', 'list'], [run({ id: sharedId, status: 'waiting' })])
    render(
      <QueryClientProvider client={client}>
        <ListViewProvider>
          <SidebarSessionScope />
        </ListViewProvider>
      </QueryClientProvider>,
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Active/ }).textContent).toBe('Active2'),
    )
    fireEvent.click(screen.getByRole('button', { name: /Archived/ }))
    expect(document.querySelector('[data-slot="waiting-dot"]')).not.toBeNull()
  })

  it('does not double-count a scoped run list that also sits in that project cache', async () => {
    setApiScope('shop')
    const shopRun = run({ id: 'shop-only', status: 'waiting' })
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
    const client = createQueryClient()
    client.setQueryData(workspaceQueryKeys.projects, {
      projects: [
        {
          id: 'cezar',
          name: 'cezar',
          root: '/cezar',
          addedAt: '2026-07-01T00:00:00.000Z',
          lastOpenedAt: '2026-07-20T12:00:00.000Z',
          source: 'local',
          status: 'ok',
        },
        {
          id: 'shop',
          name: 'shop',
          root: '/shop',
          addedAt: '2026-07-01T00:00:00.000Z',
          lastOpenedAt: '2026-07-19T00:00:00.000Z',
          source: 'local',
          status: 'ok',
        },
      ],
      bootProject: 'cezar',
      projectsDir: '/projects',
    })
    client.setQueryData(['shop', 'runs', 'list'], [shopRun])
    render(
      <QueryClientProvider client={client}>
        <ListViewProvider>
          <SidebarSessionScope />
        </ListViewProvider>
      </QueryClientProvider>,
    )

    expect(screen.getByRole('button', { name: /Active/ }).textContent).toBe('Active1')
  })
})

it('hides owned worker rows without changing ordinary titles', () => {
  renderList({ runs: [run({ id: 'worker', title: 'Investigate', delegation: { role: 'worker' as const, permissions: [], parentRunId: 'parent', workspace: { ownerRunId: 'worker', resourceId: 'worker', kind: 'owned-isolated' as const, path: '/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40) } } }), run({ id: 'ordinary', title: 'Ordinary' })] })
  expect(row('worker')).toBeNull()
  expect(document.querySelector('[data-slot="session-workers"]')).toBeNull()
  expect(screen.getAllByRole('link', { name: /Ordinary/ }).length).toBeGreaterThan(0)
})

it('does not nest a worker under its parent even when their statuses put them in different buckets', () => {
  const child = run({ id: 'child', status: 'running', title: 'Check result', delegation: { role: 'worker', permissions: [], parentRunId: 'parent', workspace: { ownerRunId: 'child', resourceId: 'child', kind: 'owned-isolated', path: '/child', branch: 'cez/child', baselineSha: 'a'.repeat(40) } } })
  renderList({ runs: [child, run({ id: 'parent', title: 'Build feature' })] })
  expect(row('child')).toBeNull()
  expect(row('parent')).not.toBeNull()
  expect(document.querySelector('[data-slot="session-workers"]')).toBeNull()
})

it('does not keep an independently pinned worker in Pinned when its parent is recent', () => {
  const worker = run({ id: 'child', pinned: true, delegation: { role: 'worker', permissions: [], parentRunId: 'parent', workspace: { ownerRunId: 'child', resourceId: 'child', kind: 'owned-isolated', path: '/child', branch: 'cez/child', baselineSha: 'a'.repeat(40) } } })
  renderList({ runs: [run({ id: 'parent' }), worker] })
  expect(row('child')).toBeNull()
  expect(document.querySelector('[data-bucket="Pinned"]')).toBeNull()
})

it('marks the parent row active when currentRunId is the worker', () => {
  const child = run({
    id: 'child',
    title: 'Check result',
    delegation: {
      role: 'worker',
      permissions: [],
      parentRunId: 'parent',
      workspace: {
        ownerRunId: 'child',
        resourceId: 'child',
        kind: 'owned-isolated',
        path: '/child',
        branch: 'cez/child',
        baselineSha: 'a'.repeat(40),
      },
    },
  })
  renderList({
    runs: [child, run({ id: 'parent', title: 'Build feature' })],
    currentRunId: 'child',
  })
  expect(row('child')).toBeNull()
  expect(row('parent')?.getAttribute('data-active')).toBe('true')
})

it('shows both tracker references on the meta line, never a line of their own', () => {
  renderList({ runs: [run({ id: 'both', pullRequestUrl: 'https://github.com/o/r/pull/217', referencedIssueUrl: 'https://github.com/o/r/issues/214' })] })
  const meta = row('both')?.querySelector('[data-slot="task-row-meta"]')
  expect(meta?.querySelector('[data-slot="pr-chip"]')?.textContent).toBe('PR #217')
  expect(meta?.querySelector('[data-slot="issue-chip"]')?.textContent).toBe('#214')
  expect(meta?.textContent).toBe('PR #217 · #214 · 1m')
  expect(row('both')?.querySelector('a a')).toBeNull()
})

describe('the calmer row (#617)', () => {
  const parked = (id: string, workers = 2) => run({
    id,
    title: 'Assessing reviewer agent',
    status: 'waiting',
    delegation: {
      role: 'root', permissions: [], receipts: [],
      wait: { id: 'wait', workerIds: Array.from({ length: workers }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`), deadline: '2026-09-06T00:00:00.000Z', phase: 'parked', outcomes: [] },
    },
  } as Partial<RunRecord>)

  it('is two fixed lines — a truncated title and a truncated meta line — whatever the reference count', () => {
    renderList({
      runs: [
        run({ id: 'long', title: 'A very long task title that will never fit into a 232px sidebar column at all', pullRequestUrl: 'https://github.com/o/r/pull/217', referencedIssueUrl: 'https://github.com/o/r/issues/214' }),
        run({ id: 'short', title: 'Short' }),
      ],
    })
    for (const id of ['long', 'short']) {
      const el = row(id) as HTMLElement
      const title = el.querySelector('[data-slot="task-row-title"]') as HTMLElement
      const meta = el.querySelector('[data-slot="task-row-meta"]') as HTMLElement
      expect(title.className).toContain('truncate')
      expect(title.className).toContain('text-[13px]')
      expect(title.className).toContain('leading-[1.45]')
      expect(meta.className).toContain('truncate')
      expect(meta.className).toContain('h-[16px]')
      expect(meta.className).toContain('text-soft-foreground')
      // The title line is a fixed 19px box and the meta line a fixed 16px one, so height is
      // independent of content; no reference is ever a line of its own.
      expect(title.closest('a')?.className).toContain('h-[19px]')
      expect(el.querySelector('[data-slot="session-references"]')).toBeNull()
      for (const chip of el.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')) {
        expect(chip.parentElement).toBe(meta)
      }
    }
  })

  it('reserves the 16px trailing slot on every row, pin or not, unread or not', () => {
    renderList({ runs: [run({ id: 'bare' }), run({ id: 'unread', finishedAt: ago(1_000) })], onTogglePin: vi.fn() })
    renderList({ runs: [run({ id: 'nopin' })] })
    for (const id of ['bare', 'unread', 'nopin']) {
      const slot = row(id)?.querySelector('[data-slot="task-row-trailing"]') as HTMLElement
      expect(slot, id).not.toBeNull()
      expect(slot.className).toContain('w-[16px]')
      expect(slot.className).toContain('shrink-0')
    }
  })

  it('reveals the pin by opacity only, inside the slot — hovering changes no width or margin', () => {
    renderList({ runs: [run({ id: 'r' })], onTogglePin: vi.fn() })
    const el = row('r') as HTMLElement
    const pin = el.querySelector('[data-slot="pin-toggle"]') as HTMLElement
    expect(pin.closest('[data-slot="task-row-trailing"]')).not.toBeNull()
    expect(pin.className).toContain('absolute')
    // Nothing in the row may change its box under the pointer or on focus (the old pin grew
    // from w-0 to w-5 and pushed the title into a rewrap).
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const cls = node.getAttribute('class') ?? ''
      expect(cls, cls).not.toMatch(/(group-hover\/task-row|focus-visible|group-has-\[:focus-visible\]\/task-row):(w|mr|ml|size|px|pl|pr)-/)
    }
  })

  it('pin: 12px, soft-foreground, never teal; filled when pinned', () => {
    renderList({ runs: [run({ id: 'plain' }), run({ id: 'kept', pinned: true })], onTogglePin: vi.fn() })
    const plain = row('plain')?.querySelector('[data-slot="pin-toggle"]') as HTMLElement
    const kept = row('kept')?.querySelector('[data-slot="pin-toggle"]') as HTMLElement
    for (const pin of [plain, kept]) {
      expect(pin.className).toContain('text-soft-foreground')
      expect(pin.className).toContain('hover:text-foreground')
      expect(pin.className).not.toContain('accent')
      // Explicit px: `size-3` follows `--spacing` and would render 9px under ultra density.
      expect(pin.querySelector('[data-slot="pin-icon"]')?.getAttribute('class')).toContain('size-[12px]')
      expect(pin.className).toContain('size-5')
    }
    expect(plain.querySelector('[data-slot="pin-icon"]')?.getAttribute('fill')).toBe('none')
    expect(kept.querySelector('[data-slot="pin-icon"]')?.getAttribute('fill')).toBe('currentColor')
  })

  it('a pinned row keeps its filled unpin affordance on hover', () => {
    renderList({ runs: [run({ id: 'kept', pinned: true })], onTogglePin: vi.fn() })
    const pin = bucket('Finished').querySelector('[data-run-id="kept"] [data-slot="pin-toggle"]') as HTMLElement
    expect(pin.getAttribute('aria-label')).toBe('Unpin task')
    expect(pin.className).toContain('opacity-0')
    expect(pin.className).toContain('group-hover/task-row:opacity-100')
    expect(pin.className).not.toContain('data-[pinned=true]:opacity-100')
    expect(pin.querySelector('[data-slot="pin-icon"]')?.getAttribute('fill')).toBe('currentColor')
  })

  it('puts the unread marker in the trailing slot, in the outcome colour', () => {
    renderList({
      runs: [
        run({ id: 'd', status: 'done', finishedAt: ago(1_000) }),
        run({ id: 'f', status: 'failed', finishedAt: ago(1_000) }),
      ],
      onTogglePin: vi.fn(),
    })
    const marker = (id: string) => row(id)?.querySelector('[data-slot="unread-marker"]') as HTMLElement
    expect(marker('d').getAttribute('data-tone')).toBe('success')
    expect(marker('f').getAttribute('data-tone')).toBe('danger')
    for (const id of ['d', 'f']) {
      expect(marker(id).closest('[data-slot="task-row-trailing"]')).not.toBeNull()
      // The pin takes the slot on hover; the marker steps aside rather than stacking.
      expect(marker(id).className).toContain('group-hover/task-row:opacity-0')
      expect(row(id)?.querySelector('[data-slot="task-row-title"]')?.className).toContain('font-semibold')
    }
  })

  it('shows the violet robot for a parent waiting on its workers, with a counted label, in the same dot slot', () => {
    renderList({ runs: [parked('p'), run({ id: 'r', status: 'running' })] })
    const dot = dotOf('p') as HTMLElement
    expect(dot.getAttribute('data-shape')).toBe('workers')
    expect(dot.getAttribute('data-tone')).toBe('running')
    expect(dot.getAttribute('aria-label')).toBe('waiting on 2 workers')
    expect(dot.querySelector('svg')).not.toBeNull()
    // Both glyphs sit in the same fixed 12px dot slot, so the titles start at the same x.
    for (const id of ['p', 'r']) {
      expect(dotOf(id)?.parentElement?.getAttribute('data-slot')).toBe('task-row-dot')
      expect(dotOf(id)?.parentElement?.className).toContain('w-[12px]')
    }
    expect(row('p')?.querySelector('[data-slot="task-row-meta"]')?.textContent).toBe('waiting on 2 workers · 1m')
  })

  it('paints the monitoring ring and the queued ring apart from running and cancelled', () => {
    renderList({ runs: [
      run({ id: 'm', status: 'running', activity: 'monitoring' }),
      run({ id: 'q', status: 'queued' }),
      run({ id: 'c', status: 'cancelled' }),
    ] })
    expect(dotOf('m')?.getAttribute('data-shape')).toBe('ring')
    expect(dotOf('q')?.getAttribute('data-shape')).toBe('ring')
    expect(dotOf('c')?.getAttribute('data-shape')).toBe('filled')
    expect(row('m')?.querySelector('[data-slot="task-row-state"]')?.textContent).toBe('monitoring')
  })

  it('makes references keyboard-reachable links on the meta line', () => {
    renderList({ runs: [run({ id: 'x', title: 'Has refs', pullRequestUrl: 'https://github.com/o/r/pull/594', referencedIssueUrl: 'https://github.com/o/r/issues/451' })] })
    const links = within(row('x') as HTMLElement).getAllByRole('link').filter(a => a.getAttribute('href')?.startsWith('https://'))
    expect(links.map(a => a.textContent)).toEqual(['PR #594', '#451'])
    for (const link of links) {
      expect(link.getAttribute('tabindex')).not.toBe('-1')
      expect(link.closest('a[href^="/tasks/"]')).toBeNull()
    }
  })

  it('uses the neutral hover and selected fills — no teal anywhere on the row', () => {
    renderList({ runs: [run({ id: 'open', pullRequestUrl: 'https://github.com/o/r/pull/7' }), run({ id: 'other' })], currentRunId: 'open', onTogglePin: vi.fn() })
    const open = row('open') as HTMLElement
    expect(open.className).toContain('bg-sidebar-row-selected')
    // Selected holds under the pointer; the other rows take the hover fill.
    expect(open.className).toContain('hover:bg-sidebar-row-selected')
    expect(row('other')?.className).toContain('hover:bg-sidebar-row-hover')
    expect(open.className).not.toContain('task-brand-selected')
    expect(open.querySelector('[data-slot="task-row-title"]')?.className).toContain('text-foreground')
    // …and the meta line steps up one ink on the selected fill, to hold 4.5:1.
    expect(open.querySelector('[data-slot="task-row-meta"]')?.className).toContain('text-muted-foreground')
    expect(row('other')?.querySelector('[data-slot="task-row-meta"]')?.className).toContain('text-soft-foreground')
    expect(row('other')?.className).not.toContain('bg-sidebar-row-selected')
    expect(row('other')?.querySelector('[data-slot="task-row-title"]')?.className).toContain('text-muted-foreground')
    for (const node of [open, ...open.querySelectorAll('*')]) {
      expect(node.getAttribute('class') ?? '').not.toMatch(/accent-text|task-brand|accent-strong\/35/)
    }
  })
})

describe('meta-line state words (#617, the issue\'s list exactly)', () => {
  const ref = { pullRequestUrl: 'https://github.com/o/r/pull/594' }
  const stateOf = (id: string) => row(id)?.querySelector('[data-slot="task-row-state"]')?.textContent ?? null
  const metaOf = (id: string) => row(id)?.querySelector('[data-slot="task-row-meta"]')?.textContent

  it('omits the state word where the dot already says it — needs you, done, cancelled — and keeps references and age', () => {
    renderList({ runs: [
      run({ id: 'you', status: 'waiting', ...ref }),
      run({ id: 'done', status: 'done', ...ref }),
      run({ id: 'gone', status: 'cancelled', ...ref }),
    ] })
    for (const id of ['you', 'done', 'gone']) {
      expect(stateOf(id), id).toBeNull()
      expect(metaOf(id), id).toBe('PR #594 · 1m')
    }
  })

  it('says it for every state the issue lists', () => {
    const workers = { role: 'root', permissions: [], receipts: [], wait: { id: 'w', workerIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], deadline: '2026-09-06T00:00:00.000Z', phase: 'parked', outcomes: [] } }
    renderList({ runs: [
      run({ id: 'mon', status: 'running', activity: 'monitoring' }),
      run({ id: 'run', status: 'running' }),
      run({ id: 'rev', status: 'review' }),
      run({ id: 'fail', status: 'failed' }),
      // Already due: no time left to name, so the word falls back to `scheduled`.
      run({ id: 'sched', status: 'failed', autoResumeAt: ago(60_000) }),
      run({ id: 'q', status: 'queued' }),
      run({ id: 'wk', status: 'waiting', delegation: workers } as Partial<RunRecord>),
      run({ id: 'rep', status: 'waiting', delegation: { ...workers, wait: { ...workers.wait, requestIds: ['00000000-0000-4000-8000-000000000009'] } } } as Partial<RunRecord>),
    ] })
    expect(stateOf('mon')).toBe('monitoring')
    expect(stateOf('run')).toBe('running')
    expect(stateOf('rev')).toBe('needs review')
    expect(stateOf('fail')).toBe('failed')
    expect(stateOf('sched')).toBe('scheduled')
    expect(stateOf('q')).toBe('queued #1')
    expect(stateOf('wk')).toBe('waiting on 2 workers')
    expect(stateOf('rep')).toBe('waiting on worker replies')
  })
})

describe('the variant group and its members (#617 addendum 01a)', () => {
  const ISSUE = 'https://github.com/o/r/issues/425'
  const members = (over: [Partial<RunRecord>, Partial<RunRecord>] = [{}, {}]) => [
    run({ id: 'va', groupId: 'g1', variant: 'A', title: 'Upstream ledger (A)', status: 'running', runner: 'claude', costUsd: 0.4, inputTokens: 12_000, outputTokens: 3_000, createdAt: ago(12 * 60_000), referencedIssueUrl: ISSUE, ...over[0] }),
    run({ id: 'vb', groupId: 'g1', variant: 'B', title: 'Upstream ledger (B)', status: 'running', runner: 'codex', costUsd: 0.22, inputTokens: 9_000, outputTokens: 2_000, createdAt: ago(12 * 60_000), referencedIssueUrl: ISSUE, ...over[1] }),
  ]
  const tile = () => document.querySelector('[data-slot="group-row"]') as HTMLElement
  const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }))

  it('shows the loudest member\'s status, the title with a non-truncating ×N chip, the aggregate line and a 36px trailing slot', () => {
    renderList({ runs: members([{}, { status: 'waiting' }]) })
    const row = tile()
    // Needs you beats running: B picks the bucket, so B's dot leads the group.
    const dot = row.querySelector('[data-slot="task-row-dot"] [data-slot="status-dot"]') as HTMLElement
    expect(dot.getAttribute('data-tone')).toBe('pending')
    const count = row.querySelector('[data-slot="group-count"]') as HTMLElement
    expect(count.textContent).toBe('×2')
    expect(count.className).toContain('shrink-0')
    expect(count.className).toContain('bg-muted')
    expect(count.className).toContain('text-muted-foreground')
    expect(row.querySelector('[data-slot="group-title"]')?.className).toContain('truncate')
    expect(row.querySelector('[data-slot="group-meta"]')?.textContent).toBe('1 needs you · 1 working · #425 · 12m')
    const trailing = row.querySelector('[data-slot="group-trailing"]') as HTMLElement
    expect(trailing.className).toContain('w-[36px]')
    const [compare, chevron] = [...trailing.children]
    expect(compare?.getAttribute('data-slot')).toBe('group-compare')
    expect(chevron?.getAttribute('data-slot')).toBe('group-disclosure')
    expect(chevron?.getAttribute('data-expanded')).toBe('false')
    // Compare stays a link, never inside the toggle button.
    expect(compare?.closest('button')).toBeNull()
  })

  it('joins only the parts that exist, and drops a reference only some members carry', () => {
    renderList({ runs: members([{ referencedIssueUrl: undefined }, { referencedIssueUrl: undefined, pullRequestUrl: 'https://github.com/o/r/pull/611' }]) })
    expect(tile().querySelector('[data-slot="group-meta"]')?.textContent).toBe('2 working · 12m')
  })

  it('toggles from anywhere on the row but the compare link, and flips the chevron', () => {
    renderList({ runs: members() })
    fireEvent.click(tile().querySelector('[data-slot="group-disclosure"]') as HTMLElement)
    expect(row('va')).not.toBeNull()
    expect(tile().querySelector('[data-slot="group-disclosure"]')?.getAttribute('data-expanded')).toBe('true')
    fireEvent.click(tile().querySelector('[data-slot="group-meta"]') as HTMLElement)
    expect(row('va')).toBeNull()
  })

  it('keeps the compare hover neutral and paints no teal on the group or its variants', () => {
    renderList({ runs: members(), currentGroupId: 'g1' })
    expand()
    const compare = tile().querySelector('[data-slot="group-compare"]') as HTMLElement
    expect(compare.className).toContain('hover:bg-sidebar-row-hover')
    for (const node of [tile(), ...tile().querySelectorAll('*'), ...document.querySelectorAll('[data-slot="variant-list"] *')]) {
      expect(node.getAttribute('class') ?? '').not.toMatch(/accent/)
    }
  })

  it('indents the members 15.5px behind a 1px guide line, so each dot sits under the group title', () => {
    renderList({ runs: members() })
    expand()
    const list = document.querySelector('[data-slot="variant-list"]') as HTMLElement
    expect(list.className).toContain('ml-[15.5px]')
    expect(list.className).toContain('border-l')
    expect(list.className).toContain('border-border')
    expect(list.className).toContain('pl-[6px]')
    expect(row('va')?.className).not.toContain('pl-[26px]')
    expect(row('va')?.className).toContain('pl-2.5')
  })

  it('variant line 1 is the neutral letter chip and runner · cost; line 2 is state, its own reference, tokens', () => {
    renderList({ runs: members([{}, { pullRequestUrl: 'https://github.com/o/r/pull/611' }]) })
    expand()
    const chip = row('va')?.querySelector('[data-slot="task-row-variant-letter"]') as HTMLElement
    expect(chip.textContent).toBe('A')
    expect(chip.className).toContain('bg-muted')
    expect(chip.className).toContain('text-muted-foreground')
    expect(row('va')?.querySelector('[data-slot="task-row-title"]')?.textContent).toBe('claude · $0.40')
    // The shared issue is the group's; each variant shows only a reference of its own.
    expect(row('va')?.querySelector('[data-slot="task-row-meta"]')?.textContent).toBe('running · IN 12.0k · OUT 3.0k')
    expect(row('vb')?.querySelector('[data-slot="task-row-meta"]')?.textContent).toBe('running · PR #611 · IN 9.0k · OUT 2.0k')
  })

  it('keeps honouring showTokens and showCost, across both lines', () => {
    renderList({ runs: members(), showTokens: false, showCost: false })
    expand()
    expect(row('va')?.querySelector('[data-slot="task-row-title"]')?.textContent).toBe('claude')
    expect(row('va')?.querySelector('[data-slot="task-row-meta"]')?.textContent).toBe('running')
  })

  it('a needs-you variant says no state word — unless line 2 would otherwise be empty', () => {
    renderList({ runs: members([{ status: 'waiting' }, {}]) })
    expand()
    expect(row('va')?.querySelector('[data-slot="task-row-meta"]')?.textContent).toBe('IN 12.0k · OUT 3.0k')
    cleanup()
    renderList({ runs: members([{ status: 'waiting' }, {}]), showTokens: false })
    expand()
    expect(row('va')?.querySelector('[data-slot="task-row-meta"]')?.textContent).toBe('needs you')
  })

  describe('selection: one highlighted row', () => {
    it('selects the group while its compare page is open', () => {
      renderList({ runs: members(), currentGroupId: 'g1' })
      expect(tile().getAttribute('data-active')).toBe('true')
      expect(tile().className).toContain('bg-sidebar-row-selected')
    })

    it('selects the collapsed group while a member\'s thread is open', () => {
      renderList({ runs: members(), currentRunId: 'vb' })
      expect(tile().getAttribute('data-active')).toBe('true')
    })

    it('once expanded, selects the member and not the group', () => {
      renderList({ runs: members(), currentRunId: 'vb' })
      expand()
      expect(tile().getAttribute('data-active')).toBeNull()
      expect(row('vb')?.getAttribute('data-active')).toBe('true')
      expect(document.querySelectorAll('[data-active="true"]')).toHaveLength(1)
      const chip = row('vb')?.querySelector('[data-slot="task-row-variant-letter"]') as HTMLElement
      expect(chip.className).toContain('bg-sidebar')
      expect(chip.className).toContain('text-foreground')
    })
  })
})

describe('references on a device that cannot hover (#617 01b)', () => {
  const stubHover = (none: boolean, desktop = true) => stubMedia({ noHover: none, desktop })
  afterEach(() => vi.unstubAllGlobals())

  it('renders them as plain text, not links, so the whole row is the tap target', () => {
    stubHover(true)
    renderList({ runs: [run({ id: 't', title: 'Touch', pullRequestUrl: 'https://github.com/o/r/pull/594', referencedIssueUrl: 'https://github.com/o/r/issues/451' })] })
    const meta = row('t')?.querySelector('[data-slot="task-row-meta"]') as HTMLElement
    expect(meta.textContent).toBe('PR #594 · #451 · 1m')
    expect(meta.querySelector('a')).toBeNull()
    expect(meta.querySelector('[tabindex]')).toBeNull()
    fireEvent.click(meta.querySelector('[data-slot="pr-chip"]') as HTMLElement)
    expect(location()).toBe('/tasks/t')
  })

  it('keeps them links with a pointer', () => {
    stubHover(false)
    renderList({ runs: [run({ id: 't', pullRequestUrl: 'https://github.com/o/r/pull/594' })] })
    expect(row('t')?.querySelector('[data-slot="task-row-meta"] a[href="https://github.com/o/r/pull/594"]')).not.toBeNull()
  })

  it('renders them as plain text in the mobile shell, even with a pointer', () => {
    stubHover(false, false)
    renderList({ runs: [run({ id: 't', pullRequestUrl: 'https://github.com/o/r/pull/594' })] })
    const meta = row('t')?.querySelector('[data-slot="task-row-meta"]') as HTMLElement
    expect(meta.querySelector('a')).toBeNull()
    expect(meta.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-inert')).toBe('true')
  })
})

it('says when a scheduled run resumes, in the meta line (#617 01b)', () => {
  renderList({ runs: [run({ id: 's', status: 'failed', autoResumeAt: new Date(NOW + 12 * 60_000).toISOString() })] })
  expect(row('s')?.querySelector('[data-slot="task-row-state"]')?.textContent).toBe('resumes in 12m')
})

describe('variant line 1 under width pressure (#617 fix round)', () => {
  const pair = () => [
    run({ id: 'oa', groupId: 'g2', variant: 'A', title: 'Ledger (A)', status: 'running', runner: 'opencode', costUsd: 0.4, inputTokens: 1, outputTokens: 1 }),
    run({ id: 'ob', groupId: 'g2', variant: 'B', title: 'Ledger (B)', status: 'running', runner: 'claude', costUsd: 0.4, inputTokens: 1, outputTokens: 1 }),
  ]
  const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }))

  it('reads "runner · $cost" as inline text — the separator keeps its spaces', () => {
    renderList({ runs: pair() })
    expand()
    const title = row('oa')?.querySelector('[data-slot="task-row-title"]') as HTMLElement
    expect(title.textContent).toBe('opencode · $0.40')
    // Inline, not a flex row: a flex item would drop the separator's leading space ("claude· $0.40").
    expect(title.className).not.toMatch(/(^|\s)flex(\s|$)/)
  })

  it('drops the tokens once the cost no longer fits, so the cost is never cut while tokens show', () => {
    const observers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb) } observe() {} unobserve() {} disconnect() {} })
    const widths = { scroll: 0, client: 0 }
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.slot === 'task-row-title' ? widths.scroll : 0 })
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.slot === 'task-row-title' ? widths.client : 0 })
    try {
      renderList({ runs: pair() })
      expand()
      expect(row('oa')?.querySelector('[data-slot="task-row-tokens"]')?.textContent).toBe('IN 1 · OUT 1')
      // Line 1 overflows: 43px of text in a 24px box.
      widths.scroll = 43
      widths.client = 24
      act(() => observers.forEach((cb) => cb()))
      expect(row('oa')?.querySelector('[data-slot="task-row-tokens"]')).toBeNull()
      expect(row('oa')?.querySelector('[data-slot="task-row-meta"]')?.textContent).toBe('running')
      // Room again: the tokens come back.
      widths.scroll = 24
      act(() => observers.forEach((cb) => cb()))
      expect(row('oa')?.querySelector('[data-slot="task-row-tokens"]')?.textContent).toBe('IN 1 · OUT 1')
    } finally {
      scroll.mockRestore()
      client.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('gives the compare link a dedicated 44px target on touch, in a slot that reserves the room', () => {
    renderList({ runs: pair() })
    const compare = document.querySelector('[data-slot="group-compare"]') as HTMLElement
    expect(compare.className).toContain('no-hover:size-[44px]')
    const trailing = document.querySelector('[data-slot="group-trailing"]') as HTMLElement
    expect(trailing.className).toContain('w-[36px]')
    expect(trailing.className).toContain('no-hover:w-[60px]')
  })
})

describe("the group row's shared reference (#617 review round 4)", () => {
  const ISSUE = 'https://github.com/o/r/issues/425'
  const pair = () => [
    run({ id: 'sa', groupId: 'g3', variant: 'A', title: 'Shared (A)', status: 'running', referencedIssueUrl: ISSUE }),
    run({ id: 'sb', groupId: 'g3', variant: 'B', title: 'Shared (B)', status: 'running', referencedIssueUrl: ISSUE }),
  ]
  const groupRow = () => document.querySelector('[data-slot="group-row"][data-group-id="g3"]') as HTMLElement

  it('is a real link on line 2, outside the toggle button, with nothing interactive nested', () => {
    renderList({ runs: pair() })
    const link = groupRow().querySelector('[data-slot="group-meta"] a[data-slot="issue-chip"]') as HTMLElement
    expect(link?.getAttribute('href')).toBe(ISSUE)
    expect(link.textContent).toBe('#425')
    expect(link.closest('button')).toBeNull()
    const toggle = groupRow().querySelector('[data-slot="group-tile"]') as HTMLElement
    expect(toggle.querySelector('a, button')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(groupRow().querySelector('[data-slot="group-meta"]')?.textContent).toBe('2 working · #425 · 1m')
  })

  it('keeps same-numbered references from two repositories on their own variants (review round 6)', () => {
    renderList({ runs: [
      run({ id: 'ra', groupId: 'g4', variant: 'A', title: 'Repos (A)', status: 'running', pullRequestUrl: 'https://github.com/o/a/pull/7' }),
      run({ id: 'rb', groupId: 'g4', variant: 'B', title: 'Repos (B)', status: 'running', pullRequestUrl: 'https://github.com/o/b/pull/7' }),
    ] })
    const group = document.querySelector('[data-slot="group-row"][data-group-id="g4"]') as HTMLElement
    expect(group.querySelector('[data-slot="group-meta"]')?.textContent).toBe('2 working · 1m')
    fireEvent.click(group.querySelector('[data-slot="group-tile"]') as HTMLElement)
    expect(row('ra')?.querySelector('[data-slot="task-row-meta"] a')?.getAttribute('href')).toBe('https://github.com/o/a/pull/7')
    expect(row('rb')?.querySelector('[data-slot="task-row-meta"] a')?.getAttribute('href')).toBe('https://github.com/o/b/pull/7')
  })

  it('does not toggle the group when the link is clicked', () => {
    renderList({ runs: pair() })
    const link = groupRow().querySelector('[data-slot="group-meta"] a') as HTMLElement
    const stopJsdomNav = (event: Event) => event.preventDefault()
    document.addEventListener('click', stopJsdomNav)
    fireEvent.click(link)
    document.removeEventListener('click', stopJsdomNav)
    expect(groupRow().querySelector('[data-slot="group-tile"]')?.getAttribute('aria-expanded')).toBe('false')
    // …while a click elsewhere on line 2 still toggles, as before.
    fireEvent.click(groupRow().querySelector('[data-slot="group-meta"]') as HTMLElement)
    expect(groupRow().querySelector('[data-slot="group-tile"]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('is inert text on a device that cannot hover', () => {
    stubMedia({ noHover: true, desktop: true })
    try {
      renderList({ runs: pair() })
      const meta = groupRow().querySelector('[data-slot="group-meta"]') as HTMLElement
      expect(meta.querySelector('a')).toBeNull()
      expect(meta.querySelector('[data-slot="issue-chip"]')?.getAttribute('data-inert')).toBe('true')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // The mobile stylesheet floors every button at 44px (#166). A line-1-only toggle there grew the
  // row from 47px to ~72px, so off the desktop+hover pair the button spans both lines instead.
  describe('which structure renders (#617 mobile regression)', () => {
    afterEach(() => vi.unstubAllGlobals())
    const structure = () => {
      const toggle = groupRow().querySelector('[data-slot="group-tile"]') as HTMLElement
      const meta = groupRow().querySelector('[data-slot="group-meta"]') as HTMLElement
      return {
        structure: groupRow().dataset.structure,
        metaInToggle: toggle.contains(meta),
        links: meta.querySelectorAll('a').length,
        nested: toggle.querySelectorAll('a, button, [tabindex]').length,
      }
    }

    it('desktop + hover: the button is line 1, line 2 a sibling with a real link', () => {
      stubMedia({ noHover: false, desktop: true })
      renderList({ runs: pair() })
      expect(structure()).toEqual({ structure: 'pointer', metaInToggle: false, links: 1, nested: 0 })
    })

    for (const [name, media] of [
      ['mobile shell with a pointer', { noHover: false, desktop: false }],
      ['desktop width, no hover', { noHover: true, desktop: true }],
      ['mobile shell, no hover', { noHover: true, desktop: false }],
    ] as const) {
      it(`${name}: one button over both lines, the reference inert inside it`, () => {
        stubMedia(media)
        renderList({ runs: pair() })
        expect(structure()).toEqual({ structure: 'touch', metaInToggle: true, links: 0, nested: 0 })
        expect(groupRow().querySelector('[data-slot="group-meta"]')?.textContent).toBe('2 working · #425 · 1m')
        // The row's vertical padding moved into the button, so the button is the row's height.
        expect(groupRow().className).toContain('py-0')
        expect(groupRow().querySelector('[data-slot="group-tile"]')?.className).toContain('py-1.5')
        fireEvent.click(groupRow().querySelector('[data-slot="issue-chip"]') as HTMLElement)
        expect(groupRow().querySelector('[data-slot="group-tile"]')?.getAttribute('aria-expanded')).toBe('true')
      })
    }
  })
})

function stubMedia({ noHover, desktop }: { noHover: boolean; desktop: boolean }) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: none)' ? noHover : query === '(min-width: 768px)' ? desktop : false,
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }))
}

it('shows the selected view count and a project-scoped All link above retained view controls', () => {
  const { onViewChange } = renderList({ runs: [run(), run({ archived: true }), run({ archived: true })], view: 'archived' }, '/p/project/tasks/task')
  const header = document.querySelector('[data-slot="quick-list-header"]') as HTMLElement
  expect(header).not.toBeNull()
  expect(header.textContent).toBe('Tasks2All')
  expect(within(header).getByRole('link', { name: 'All' }).getAttribute('href')).toBe('/p/project/')
  fireEvent.click(screen.getByRole('button', { name: /Active/ }))
  expect(onViewChange).toHaveBeenCalledWith('active')
  fireEvent.click(within(header).getByRole('link', { name: 'All' }))
  expect(location()).toBe('/p/project/')
})

describe('notifying glyph and age-first overflow on the meta line (#729)', () => {
  const metaEl = (id: string) => row(id)?.querySelector('[data-slot="task-row-meta"]') as HTMLElement
  const glyph = (id: string) => metaEl(id)?.querySelector('[data-slot="task-row-notify"]') as HTMLElement | null
  const ISSUE = 'https://github.com/o/r/issues/425'
  const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }))
  afterEach(() => vi.unstubAllGlobals())

  it('leads the meta line with the send glyph for notify: true — and only then', () => {
    renderList({ runs: [
      run({ id: 'on', status: 'running', notify: true, pullRequestUrl: 'https://github.com/o/r/pull/594' }),
      run({ id: 'off', status: 'running', notify: false }),
      run({ id: 'unset', status: 'running' }),
    ] })
    const on = glyph('on')
    expect(on).not.toBeNull()
    expect(metaEl('on').firstElementChild).toBe(on)
    // No separator after it: the text is what it was without the glyph.
    expect(metaEl('on').textContent).toBe('running · PR #594 · 1m')
    expect(on?.getAttribute('role')).toBe('img')
    expect(on?.getAttribute('aria-label')).toBe('Notifying the task webhook')
    expect(on?.getAttribute('title')).toBe('Notifying the task webhook')
    // 10px, never shrinks, inherits the meta colour — no status tone, no teal.
    expect(on?.getAttribute('class')).toMatch(/shrink-0/)
    expect(on?.querySelector('svg')?.getAttribute('class')).toMatch(/size-\[10px\]/)
    expect(on?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(on?.getAttribute('class')).not.toMatch(/text-(success|danger|warning|pending|link|accent|primary)/)
    expect(glyph('off')).toBeNull()
    expect(glyph('unset')).toBeNull()
  })

  it('keeps the meta line colour on the open row, so the glyph follows the selected step-up', () => {
    renderList({ runs: [run({ id: 'on', status: 'running', notify: true })], currentRunId: 'on' })
    expect(metaEl('on').className).toContain('text-muted-foreground')
    expect(glyph('on')?.getAttribute('class')).not.toMatch(/text-/)
  })

  it('shows on a row with no other meta, and on a worker row', () => {
    renderList({ runs: [
      run({ id: 'solo', status: 'queued', notify: true }),
      run({ id: 'w', status: 'running', notify: true, delegation: { role: 'worker', permissions: [], receipts: [] } as never }),
    ] })
    expect(glyph('solo')).not.toBeNull()
    expect(glyph('w')).not.toBeNull()
  })

  it('renders the same glyph on a device that cannot hover', () => {
    stubMedia({ noHover: true, desktop: true })
    renderList({ runs: [run({ id: 'on', status: 'running', notify: true })] })
    expect(glyph('on')).not.toBeNull()
    expect(metaEl('on').textContent).toBe('running · 1m')
  })

  const members = (notify: boolean) => [
    run({ id: 'va', groupId: 'g9', variant: 'A', title: 'Ledger (A)', status: 'waiting', runner: 'claude', createdAt: ago(60_000), referencedIssueUrl: ISSUE, notify }),
    run({ id: 'vb', groupId: 'g9', variant: 'B', title: 'Ledger (B)', status: 'running', runner: 'codex', createdAt: ago(60_000), referencedIssueUrl: ISSUE }),
  ]

  it('a notifying needs-you variant keeps its "needs you" fallback — the glyph is not meta', () => {
    renderList({ runs: members(true), showTokens: false, showCost: false })
    expand()
    expect(glyph('va')).not.toBeNull()
    expect(metaEl('va').textContent).toBe('needs you')
    expect(glyph('vb')).toBeNull()
  })

  describe('width priority: the age drops first, whole', () => {
    let needsAge = 120
    let needsBare = 80
    let client = 100
    let observers: Array<() => void> = []
    beforeEach(() => {
      needsAge = 120
      needsBare = 80
      client = 100
      observers = []
      vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb) } observe() {} unobserve() {} disconnect() {} })
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        if (this.dataset.slot !== 'task-row-meta') return 0
        return this.querySelector('[data-slot="task-row-age"]') ? needsAge : needsBare
      })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.slot === 'task-row-meta' ? client : 0
      })
    })
    afterEach(() => vi.restoreAllMocks())
    const resize = () => act(() => observers.forEach((cb) => cb()))
    const age = (id: string) => metaEl(id).querySelector('[data-slot="task-row-age"]')

    it('takes the age off together with its separator, never ellipsizing it', () => {
      renderList({ runs: [run({ id: 't', status: 'running', notify: true, pullRequestUrl: 'https://github.com/o/r/pull/594' })] })
      expect(age('t')).toBeNull()
      expect(metaEl('t').textContent).toBe('running · PR #594')
      expect(glyph('t')).not.toBeNull()
    })

    it('does the same for a row that is not notifying', () => {
      renderList({ runs: [run({ id: 't', status: 'running' })] })
      expect(age('t')).toBeNull()
      expect(metaEl('t').textContent).toBe('running')
    })

    it('keeps the age while the line fits, and restores it when the column grows', () => {
      client = 130
      renderList({ runs: [run({ id: 't', status: 'running' })] })
      expect(age('t')?.textContent).toBe('1m')
      client = 100
      resize()
      expect(age('t')).toBeNull()
      client = 130
      resize()
      expect(age('t')?.textContent).toBe('1m')
    })

    it('does not flicker at the boundary: the decision uses the width WITH the age, not the line it just shortened', () => {
      renderList({ runs: [run({ id: 't', status: 'running' })] })
      expect(age('t')).toBeNull()
      // The bare line (80) fits in 100, but the age line (120) does not — repeated observer
      // callbacks must keep the age off instead of toggling it every frame.
      for (let i = 0; i < 4; i += 1) {
        resize()
        expect(age('t')).toBeNull()
      }
      client = 120
      resize()
      expect(age('t')).not.toBeNull()
      resize()
      expect(age('t')).not.toBeNull()
    })

    it('measures the content, not the box: scrollWidth floors at the box width when the line fits', () => {
      const range = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value(this: Range) {
          const el = this.commonAncestorContainer as HTMLElement
          return { width: el.querySelector('[data-slot="task-row-age"]') ? 120 : 80 }
        },
      })
      // A fitting line reports its box (130), never its content (120).
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.slot === 'task-row-meta' ? client : 0
      })
      try {
        client = 130
        renderList({ runs: [run({ id: 't', status: 'running' })] })
        expect(age('t')).not.toBeNull()
        client = 125 // still fits 120: a box-measured width (130) would drop the age here
        resize()
        expect(age('t')).not.toBeNull()
        client = 110
        resize()
        expect(age('t')).toBeNull()
      } finally {
        if (range) Object.defineProperty(Range.prototype, 'getBoundingClientRect', range)
        else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
      }
    })

    it('does not loop when web fonts have already resolved', async () => {
      Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading', ready: Promise.resolve() } })
      try {
        renderList({ runs: [run({ id: 't', status: 'running' })] })
        await act(async () => { await Promise.resolve(); await Promise.resolve() })
        expect(age('t')).toBeNull()
        for (let i = 0; i < 3; i += 1) {
          await act(async () => { await Promise.resolve(); resize() })
          expect(age('t')).toBeNull()
        }
      } finally {
        Reflect.deleteProperty(document, 'fonts')
      }
    })

    it('re-measures when a reference changes width with the same identity (status hydrates, conflict weight)', () => {
      // A second observer class that remembers what it watches, so the test can resize one child.
      const watchers: Array<{ cb: (entries?: unknown[]) => void; targets: Element[] }> = []
      vi.stubGlobal('ResizeObserver', class {
        private w = { cb: undefined as unknown as (entries?: unknown[]) => void, targets: [] as Element[] }
        constructor(cb: (entries?: unknown[]) => void) { this.w.cb = cb; watchers.push(this.w); observers.push(() => cb()) }
        observe(target: Element) { this.w.targets.push(target) }
        unobserve() {}
        disconnect() {}
      })
      const resizeChip = (chip: Element, width: number) =>
        act(() => watchers.filter((w) => w.targets.includes(chip)).forEach((w) => w.cb([{ target: chip, contentRect: { width } }])))
      client = 130
      renderList({ runs: [run({ id: 't', status: 'running', pullRequestUrl: 'https://github.com/o/r/pull/594' })] })
      expect(age('t')).not.toBeNull()
      const chip = metaEl('t').querySelector('[data-slot="pr-chip"]') as Element
      expect(watchers.some((w) => w.targets.includes(chip))).toBe(true)
      resizeChip(chip, 40) // baseline report on observe: not a change
      expect(age('t')).not.toBeNull()
      // The status glyph lands: the chip is wider, the line now needs 150 in a 130 box.
      needsAge = 150
      resizeChip(chip, 62)
      expect(age('t')).toBeNull()
      // Repeated reports at the same width are not changes: no loop, no flicker.
      for (let i = 0; i < 3; i += 1) {
        resizeChip(chip, 62)
        expect(age('t')).toBeNull()
      }
      // The status settles back narrower: the line fits again and the age returns.
      needsAge = 120
      resizeChip(chip, 40)
      expect(age('t')).not.toBeNull()
    })

    it('follows a chip the real registry replaces while it hydrates (idle anchor → hover card), not the detached first one', async () => {
      // Live watchers only: a disconnected observer, or one on a detached node, reports nothing.
      const watchers: Array<{ cb: (entries?: unknown[]) => void; targets: Set<Element>; live: boolean }> = []
      vi.stubGlobal('ResizeObserver', class {
        private w = { cb: undefined as unknown as (entries?: unknown[]) => void, targets: new Set<Element>(), live: true }
        constructor(cb: (entries?: unknown[]) => void) { this.w.cb = cb; watchers.push(this.w); observers.push(() => cb()) }
        observe(target: Element) { this.w.targets.add(target) }
        unobserve(target: Element) { this.w.targets.delete(target) }
        disconnect() { this.w.live = false }
      })
      const report = (el: Element, width: number) => act(() => watchers
        .filter((w) => w.live && w.targets.has(el) && el.isConnected)
        .forEach((w) => w.cb([{ target: el, contentRect: { width } }])))
      const requests: Array<() => void> = []
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
        requests.push(() => resolve(new Response(JSON.stringify({ available: true, recheckAfterMs: null, prs: { 594: 'merged' }, issues: {} }), { status: 200, headers: { 'content-type': 'application/json' } })))
      })))
      client = 130
      // The idle anchor is mounted and unmounted inside render()'s own act: catch the removal.
      const removed: Element[] = []
      const mutations = new MutationObserver((records) => records.forEach((r) => r.removedNodes.forEach((n) => { if (n instanceof Element) removed.push(n) })))
      mutations.observe(document.body, { childList: true, subtree: true })
      render(
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter>
            <ReferenceStatusRegistry>
              <ReferenceStatusProvider projectId="p" requests={[{ projectId: 'p', kind: 'PR', number: 594 }]}>
                <TaskQuickList runs={[run({ id: 't', status: 'running', pullRequestUrl: 'https://github.com/o/r/pull/594' })]} view="active" now={NOW} onViewChange={vi.fn()} />
              </ReferenceStatusProvider>
            </ReferenceStatusRegistry>
          </MemoryRouter>
        </QueryClientProvider>,
      )
      const direct = () => Array.from(metaEl('t').children).find((c) => c.matches('[data-slot="pr-chip"], [data-slot="reference-status-trigger"]') || c.querySelector('[data-slot="pr-chip"]')) as Element
      expect(age('t')).not.toBeNull()
      // The request starts: the idle anchor is swapped for the hover-card subtree (a new node).
      await waitFor(() => expect(requests.length).toBeGreaterThan(0))
      await act(async () => { await Promise.resolve() })
      expect(removed.some((n) => n.matches('[data-slot="pr-chip"]') || n.querySelector('[data-slot="pr-chip"]'))).toBe(true)
      mutations.disconnect()
      const replacement = direct()
      report(replacement, 40) // baseline
      expect(age('t')).not.toBeNull()
      // The answer lands and the status glyph widens the REPLACEMENT: the line now needs 150.
      needsAge = 150
      await act(async () => { requests.forEach((answer) => answer()); await new Promise((r) => setTimeout(r, 0)) })
      report(direct(), 62)
      await waitFor(() => expect(age('t')).toBeNull())
    })

    it('catches a status that hydrates after the full-age measure but before the first observer report', async () => {
      const watchers: Array<{ cb: (entries?: unknown[]) => void; targets: Set<Element>; live: boolean }> = []
      vi.stubGlobal('ResizeObserver', class {
        private w = { cb: undefined as unknown as (entries?: unknown[]) => void, targets: new Set<Element>(), live: true }
        constructor(cb: (entries?: unknown[]) => void) { this.w.cb = cb; watchers.push(this.w); observers.push(() => cb()) }
        observe(target: Element) { this.w.targets.add(target) }
        unobserve(target: Element) { this.w.targets.delete(target) }
        disconnect() { this.w.live = false }
      })
      // The chip's border box as the browser would report it right now (jsdom has no layout).
      let chipWidth = 40
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const inMeta = this.parentElement?.dataset.slot === 'task-row-meta' && this.dataset.slot !== 'task-row-age'
        return { width: inMeta ? chipWidth : 0 } as DOMRect
      })
      const requests: Array<() => void> = []
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
        requests.push(() => resolve(new Response(JSON.stringify({ available: true, recheckAfterMs: null, prs: { 594: 'merged' }, issues: {} }), { status: 200, headers: { 'content-type': 'application/json' } })))
      })))
      client = 130
      render(
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter>
            <ReferenceStatusRegistry>
              <ReferenceStatusProvider projectId="p" requests={[{ projectId: 'p', kind: 'PR', number: 594 }]}>
                <TaskQuickList runs={[run({ id: 't', status: 'running', pullRequestUrl: 'https://github.com/o/r/pull/594' })]} view="active" now={NOW} onViewChange={vi.fn()} />
              </ReferenceStatusProvider>
            </ReferenceStatusRegistry>
          </MemoryRouter>
        </QueryClientProvider>,
      )
      await waitFor(() => expect(requests.length).toBeGreaterThan(0))
      await act(async () => { await Promise.resolve() })
      expect(age('t')).not.toBeNull()
      // The answer lands and the glyph widens the chip BEFORE any observer has reported on it.
      chipWidth = 62
      needsAge = 150
      await act(async () => { requests.forEach((answer) => answer()); await new Promise((r) => setTimeout(r, 0)) })
      // Only now does the observer deliver its FIRST report for the chip — it is a change from the
      // width seen at bind time, not a baseline.
      const chip = Array.from(metaEl('t').children).find((c) => c.matches('[data-slot="pr-chip"]') || c.querySelector('[data-slot="pr-chip"]')) as Element
      act(() => watchers.filter((w) => w.live && w.targets.has(chip)).forEach((w) => w.cb([{ target: chip, contentRect: { width: 62 } }])))
      await waitFor(() => expect(age('t')).toBeNull())
    })

    it('leaves a variant row (no age) and the tokens order alone', () => {
      renderList({ runs: members(false), showTokens: false, showCost: false })
      expand()
      expect(age('va')).toBeNull()
      expect(metaEl('va').textContent).toBe('needs you')
    })
  })
})

describe('sidebar archive (#780)', () => {
  afterEach(() => vi.unstubAllGlobals())
  const archiveButtons = () => Array.from(document.querySelectorAll<HTMLElement>('[data-action="archive-run"]'))
  const groupButton = (scope: string) => document.querySelector<HTMLElement>(`[data-action="archive-group"][data-scope="${scope}"]`)

  it('puts the archive button on finished rows only, Finished and Pinned alike', () => {
    renderList({
      runs: [
        run({ id: 'fin', title: 'Done one', status: 'done' }),
        run({ id: 'pinned-fin', title: 'Pinned done', status: 'failed', pinned: true }),
        run({ id: 'live', status: 'running' }),
        run({ id: 'ask', status: 'waiting' }),
        run({ id: 'sched', status: 'failed', autoResumeAt: new Date(NOW + 600_000).toISOString() }),
        run({ id: 'pinned-live', status: 'running', pinned: true }),
      ],
      onTogglePin: vi.fn(),
      onArchiveRun: vi.fn(),
    })
    expect(archiveButtons().map((b) => b.closest('[data-slot="task-row"]')?.getAttribute('data-run-id'))).toEqual(['pinned-fin', 'fin'])
    const button = archiveButtons()[1]!
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('aria-label')).toBe('Archive Done one')
    expect(button.getAttribute('title')).toBe('Archive task')
  })

  it('keeps the trailing slot 16px and reveals the button like the pin', () => {
    renderList({ runs: [run({ id: 'fin' })], onTogglePin: vi.fn(), onArchiveRun: vi.fn() })
    const button = archiveButtons()[0]!
    const slot = button.closest('[data-slot="task-row-trailing"]') as HTMLElement
    expect(slot.className).toContain('w-[16px]')
    expect(button.className).toContain('opacity-0')
    expect(button.className).toContain('group-hover/task-row:opacity-100')
    expect(button.className).toContain('group-has-[:focus-visible]/task-row:opacity-100')
    // Beside the pin, never in place of it, and never over a line-1 target.
    expect(slot.querySelector('[data-slot="pin-toggle"]')).not.toBeNull()
  })

  it('archives on click with no dialog and without opening the row', () => {
    const onArchiveRun = vi.fn()
    renderList({ runs: [run({ id: 'fin' })], onArchiveRun })
    fireEvent.click(archiveButtons()[0]!)
    expect(onArchiveRun).toHaveBeenCalledOnce()
    expect(onArchiveRun.mock.calls[0]![0]).toMatchObject({ id: 'fin' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(location()).toBe('/')
  })

  it('renders nothing where the swipe replaces the button', () => {
    stubMedia({ noHover: true, desktop: false })
    renderList({ runs: [run({ id: 'fin' })], onArchiveRun: vi.fn(), onSweep: vi.fn() })
    expect(archiveButtons()).toHaveLength(0)
  })

  it('withholds the button in the Archived view and on variant group rows', () => {
    const onArchiveRun = vi.fn()
    renderList({ runs: [run({ id: 'old', archived: true })], view: 'archived', onArchiveRun, onSweep: vi.fn() })
    expect(archiveButtons()).toHaveLength(0)
    expect(document.querySelector('[data-action="archive-group"]')).toBeNull()
    cleanup()
    renderList({
      runs: [
        run({ id: 'v1', status: 'done', groupId: 'g', variant: 'A' }),
        run({ id: 'v2', status: 'done', groupId: 'g', variant: 'B' }),
      ],
      onArchiveRun,
    })
    expect(document.querySelector('[data-slot="group-row"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="group-row"] [data-action="archive-run"]')).toBeNull()
  })

  it('shows "Archive all" on Finished only while it has rows, and sweeps unpinned', () => {
    const onSweep = vi.fn()
    renderList({ runs: [run({ id: 'a' }), run({ id: 'b', pinned: true })], onSweep, onTogglePin: vi.fn() })
    const finished = document.querySelector('[data-bucket="Finished"]') as HTMLElement
    const button = within(finished).getByRole('button', { name: 'Archive all' })
    expect(button).toBe(groupButton('unpinned'))
    // The heading includes both tasks; the sweep button sits beside it.
    expect(within(finished).getByRole('heading', { name: 'Finished 2' })).toBeTruthy()
    fireEvent.click(button)
    expect(onSweep).toHaveBeenCalledWith('unpinned')
    cleanup()
    renderList({ runs: [run({ id: 'live', status: 'running' })], onSweep })
    expect(groupButton('unpinned')).toBeNull()
  })

  it('counts the whole unpinned set for "Archive all", rows the cap hides included', () => {
    const runs = Array.from({ length: 6 }, (_, i) => run({ id: `f${i}`, createdAt: ago(60_000 + i) }))
    renderList({ runs, rowLimit: 2, onSweep: vi.fn() })
    expect(document.querySelectorAll('[data-bucket="Finished"] [data-slot="task-row"]')).toHaveLength(2)
    expect(groupButton('unpinned')).not.toBeNull()
  })

  it('offers no sweep when only pins or scheduled runs are present', () => {
    const onSweep = vi.fn()
    renderList({ runs: [run({ id: 'p1', pinned: true, status: 'done' }), run({ id: 'p2', pinned: true, status: 'running' })], onSweep, onTogglePin: vi.fn() })
    expect(document.querySelectorAll('[data-action="archive-group"]')).toHaveLength(0)
    cleanup()
    // Review Focus 3: a pinned run that is only waiting out a usage limit has nothing to sweep.
    renderList({
      runs: [
        run({ id: 'p3', pinned: true, status: 'running' }),
        run({ id: 'p4', pinned: true, status: 'failed', autoResumeAt: new Date(NOW + 600_000).toISOString() }),
      ],
      onSweep,
    })
    expect(document.querySelector('[data-bucket="Working"]')).not.toBeNull()
    expect(groupButton('pinned')).toBeNull()
  })

  it('disables the running sweep with aria-busy', () => {
    renderList({ runs: [run({ id: 'a' }), run({ id: 'b', pinned: true })], onSweep: vi.fn(), sweeping: 'unpinned' })
    const busy = groupButton('unpinned') as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(groupButton('pinned')).toBeNull()
  })

  it('gives the group buttons a 44px target on touch', () => {
    renderList({ runs: [run({ id: 'a' })], onSweep: vi.fn() })
    const className = groupButton('unpinned')!.className
    // A 44px hit area from a pseudo-element: the header keeps its natural height.
    expect(className).toContain('max-md:before:h-11')
    expect(className).toContain('no-hover:before:h-11')
    expect(className).not.toContain('max-md:h-11')
    const row = groupButton('unpinned')!.parentElement as HTMLElement
    expect(row.className).not.toContain('min-h-11')
  })

  it('names the group button with its visible text first, then the project', () => {
    renderList({ runs: [run({ id: 'a' })], onSweep: vi.fn() })
    expect(groupButton('unpinned')!.getAttribute('aria-describedby')).toBe(
      document.querySelector('[data-bucket="Finished"] h2')!.id,
    )
    cleanup()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <QuickListBuckets buckets={groupRuns([run({ id: 'a' })], 'active')} sweepCounts={{ unpinned: 1, pinned: 0 }} onSweep={vi.fn()} projectName="shop" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(groupButton('unpinned')!.getAttribute('aria-label')).toBe('Archive all, shop')
  })
})

describe('swipe to archive on touch (#780 §7)', () => {
  // Every gesture step is 300ms after the last: the swipes here are deliberate drags, never flings.
  let clock = 0
  beforeEach(() => {
    clock = NOW
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    stubMedia({ noHover: true, desktop: false })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 320, height: 47, top: 0, left: 0, right: 320, bottom: 47, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
  })
  afterEach(() => {
    resetSwipeStore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const surface = (id: string) => document.querySelector<HTMLElement>(`[data-slot="task-row"][data-run-id="${id}"]`)?.closest<HTMLElement>('[data-slot="task-row-swipe"][data-swipe="on"]') ?? null
  const layer = (id: string) => document.querySelector<HTMLElement>(`[data-slot="task-row"][data-run-id="${id}"]`)!
  const action = (id: string) => surface(id)?.querySelector<HTMLElement>('[data-slot="task-row-swipe-action"]') ?? null
  function swipe(id: string, dx: number, { release = true } = {}) {
    const el = layer(id)
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 300, clientY: 20, button: 0 })
    clock += 300
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 300 + Math.sign(dx) * 12, clientY: 20 })
    clock += 300
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 300 + dx, clientY: 20 })
    clock += 300
    if (release) fireEvent.pointerUp(el, { pointerId: 1, clientX: 300 + dx, clientY: 20 })
  }

  it('wraps only finished, non-scheduled rows in a pan-y swipe surface', () => {
    renderList({
      runs: [
        run({ id: 'fin', status: 'done' }),
        run({ id: 'pin', status: 'cancelled', pinned: true }),
        run({ id: 'live', status: 'running' }),
        run({ id: 'ask', status: 'waiting' }),
        run({ id: 'sched', status: 'failed', autoResumeAt: new Date(NOW + 600_000).toISOString() }),
      ],
      onArchiveRun: vi.fn(),
      onTogglePin: vi.fn(),
    })
    expect(surface('fin')!.className).toContain('touch-pan-y')
    expect(surface('fin')!.className).toContain('touch-pinch-zoom')
    expect(surface('fin')!.className).toContain('overflow-hidden')
    expect(surface('pin')).not.toBeNull()
    for (const id of ['live', 'ask', 'sched']) expect(surface(id)).toBeNull()
    // At rest nothing sits behind the row.
    expect(action('fin')).toBeNull()
  })

  it('renders no swipe where the row button is used, nor without an archive handler', () => {
    vi.unstubAllGlobals()
    stubMedia({ noHover: false, desktop: true })
    renderList({ runs: [run({ id: 'fin' })], onArchiveRun: vi.fn() })
    expect(surface('fin')).toBeNull()
    cleanup()
    stubMedia({ noHover: true, desktop: false })
    renderList({ runs: [run({ id: 'fin2' })] })
    expect(surface('fin2')).toBeNull()
  })

  it('parks a short swipe on the Archive action, and tapping it archives', () => {
    const onArchiveRun = vi.fn()
    renderList({ runs: [run({ id: 'fin', title: 'Cursor fix' })], onArchiveRun })
    swipe('fin', -50)
    expect(layer('fin').style.transform).toBe('translateX(-88px)')
    const button = action('fin')!.querySelector('button')!
    expect(button.textContent).toBe('Archive')
    expect(button.getAttribute('aria-label')).toBe('Archive Cursor fix')
    expect(button.tabIndex).toBe(-1)
    expect(action('fin')!.className).toContain('bg-muted')
    fireEvent.click(button)
    expect(onArchiveRun).toHaveBeenCalledOnce()
    expect(onArchiveRun.mock.calls[0]![0]).toMatchObject({ id: 'fin' })
    expect(location()).toBe('/')
  })

  it('a long swipe shows "Release to archive" in --info and archives on release', () => {
    const onArchiveRun = vi.fn()
    renderList({ runs: [run({ id: 'fin' })], onArchiveRun })
    swipe('fin', -220, { release: false })
    expect(action('fin')!.className).toContain('bg-info')
    expect(action('fin')!.className).toContain('text-signal-ink')
    expect(action('fin')!.textContent).toBe('Release to archive')
    expect(onArchiveRun).not.toHaveBeenCalled()
    fireEvent.pointerUp(layer('fin'), { pointerId: 1, clientX: 80, clientY: 20 })
    expect(onArchiveRun).toHaveBeenCalledOnce()
  })

  it('a drag never opens the row, and the row stays one link for screen readers', () => {
    renderList({ runs: [run({ id: 'fin', title: 'Only link' })], onArchiveRun: vi.fn() })
    swipe('fin', -30)
    fireEvent.click(within(layer('fin')).getByRole('link'))
    expect(location()).toBe('/')
    swipe('fin', -50)
    expect(action('fin')!.getAttribute('aria-hidden')).toBe('true')
    expect(within(surface('fin')!).getAllByRole('link')).toHaveLength(1)
    expect(within(surface('fin')!).queryAllByRole('button')).toHaveLength(0)
  })

  it('snaps with a motion-safe 200ms transition, never while the finger drags', () => {
    renderList({ runs: [run({ id: 'fin' })], onArchiveRun: vi.fn() })
    expect(layer('fin').className).toContain('motion-safe:transition-transform')
    expect(layer('fin').className).toContain('motion-safe:duration-200')
    swipe('fin', -50, { release: false })
    expect(layer('fin').className).not.toContain('motion-safe:transition-transform')
    expect(layer('fin').style.transform).toBe('translateX(-50px)')
  })

  it('keeps the task link focused when finishing moves a pin into Finished', () => {
    const client = createQueryClient()
    const live = run({ id: 'flip', title: 'Flip', status: 'running', pinned: true })
    const tree = (record: RunSummary) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TaskQuickList runs={[record]} view="active" now={NOW} onViewChange={vi.fn()} onArchiveRun={vi.fn()} onTogglePin={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(tree(live))
    const link = within(layer('flip')).getByRole('link')
    link.focus()
    expect(surface('flip')).toBeNull()
    // The status move remounts the row in Finished, but keyboard focus follows it.
    rerender(tree({ ...live, status: 'done', finishedAt: ago(1_000) }))
    expect(document.activeElement).toBe(row('flip')?.querySelector('a'))
    expect(bucket('Finished').contains(document.activeElement)).toBe(true)
    expect(surface('flip')).not.toBeNull()
  })

  it('marks the link undraggable and the row unselectable while it swipes', () => {
    renderList({ runs: [run({ id: 'fin' })], onArchiveRun: vi.fn() })
    expect(within(layer('fin')).getByRole('link').getAttribute('draggable')).toBe('false')
    expect(layer('fin').className).toContain('select-none')
  })

  it('keeps one row open at a time', () => {
    renderList({ runs: [run({ id: 'a' }), run({ id: 'b' })], onArchiveRun: vi.fn() })
    swipe('a', -50)
    expect(action('a')).not.toBeNull()
    swipe('b', -50)
    expect(action('a')).toBeNull()
    expect(layer('a').style.transform).toBe('')
    expect(action('b')).not.toBeNull()
  })
})
