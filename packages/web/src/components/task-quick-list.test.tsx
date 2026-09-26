import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { setApiScope } from '@open-mercato/cezar-api-client'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { ListViewProvider } from '@/components/list-view'
import { SidebarSessionScope, TaskQuickList, TaskQuickListContainer } from '@/components/task-quick-list'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
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
  }
}

/** Where the router currently is — the whole-row click vs nested-control assertions read this. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}

function renderList(props: Partial<Parameters<typeof TaskQuickList>[0]> = {}, route = '/') {
  const onViewChange = props.onViewChange ?? vi.fn()
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <LocationProbe />
      <Routes>
        <Route
          path="*"
          element={<TaskQuickList runs={[]} view="active" now={NOW} {...props} onViewChange={onViewChange} />}
        />
      </Routes>
    </MemoryRouter>
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

describe('TaskQuickList', () => {
  it('renders the buckets in the mockup order with their runs', () => {
    renderList({
      runs: [
        run({ id: 'a', title: 'Structured changes endpoint', status: 'review' }),
        run({ id: 'b', title: 'Normalize agent-event protocol', status: 'running' }),
        run({ id: 'c', title: 'README parallel-agents tagline', status: 'done' }),
      ],
    })

    const headers = [...document.querySelectorAll('[data-slot="quick-list-bucket"] h2')].map((h) => h.textContent)
    expect(headers).toEqual(['Recent'])
    expect(rowsIn('Recent')).toEqual(['Structured changes endpointneeds review · 1m', 'Normalize agent-event protocolrunning · 1m', 'README parallel-agents tagline1m'])
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
      expect(rowsIn('Recent')).toEqual(['Has a PRneeds review · PR #7 · 1m'])
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
      expect(rowsIn('Recent')).toEqual(['implementing comment threads across the whole thread view+59,514 −12,160PR #775 · 1m'])
    })

    it('gives the collapsed variant tile the same floor', () => {
      renderList({
        runs: [
          run({ id: 'ga', title: 'Add skills autocomplete (A)', groupId: 'g', variant: 'A' }),
          run({ id: 'gb', title: 'Add skills autocomplete (B)', groupId: 'g', variant: 'B' }),
        ],
      })
      const tileTitle = document.querySelector('[data-slot="group-tile"] span') as HTMLElement
      expect(tileTitle.className).toContain('min-w-[7rem]')
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
      expect(tile.textContent).toBe('Add skills autocomplete×2')
      // Collapsed: the members are not rows of their own.
      expect(row('va')).toBeNull()
      expect(row('vb')).toBeNull()
    })

    it('expands and collapses on click, showing a lettered row per variant', () => {
      renderList({ runs: variants() })

      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(screen.getByRole('button', { expanded: true })).not.toBeNull()

      // The letter chip, its own dot, and what actually differs between the variants.
      // Line two is the meta line: state word (and references), never an age (#617 decision 1).
      expect(metadataText(row('va'))).toBe('Aclaude · IN 92.0k · OUT 4.2k · $0.31running')
      expect(metadataText(row('vb'))).toBe('Bcodex · IN 40.0k · OUT 1.8k · $0.12running')
      expect(dotOf('va')?.getAttribute('data-tone')).toBe('running')
      // Each variant is still its own deep link.
      expect(row('vb')?.querySelector('a')?.getAttribute('href')).toBe('/tasks/vb')

      fireEvent.click(screen.getByRole('button', { expanded: true }))
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
    it('renders pinned runs under a Pinned header at the top, once', () => {
      renderList({
        runs: [
          run({ id: 'waiting', title: 'Wants you', status: 'waiting' }),
          run({ id: 'kept', title: 'The one I live in', status: 'done', pinned: true }),
        ],
        onTogglePin: vi.fn(),
      })
      const headers = [...document.querySelectorAll('[data-slot="quick-list-bucket"] h2')].map((h) => h.textContent)
      expect(headers).toEqual(['Pinned', 'Recent'])
      expect(rowsIn('Pinned')).toHaveLength(1)
      expect(bucket('Pinned').querySelector('[data-run-id="kept"]')).not.toBeNull()
      expect(bucket('Recent').querySelector('[data-run-id="kept"]')).toBeNull()
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

    it('keeps the status dot on a pinned row — Pinned says where it is, not how it is', () => {
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

  function renderContainer(runs: RunRecord[], route = '/') {
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/runs')
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
      const path = String(input)
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
      const path = String(input)
      if (path === '/api/v1/runs') {
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
      expect(pin.querySelector('[data-slot="pin-icon"]')?.getAttribute('class')).toContain('size-3')
      expect(pin.className).toContain('size-5')
    }
    expect(plain.querySelector('[data-slot="pin-icon"]')?.getAttribute('fill')).toBe('none')
    expect(kept.querySelector('[data-slot="pin-icon"]')?.getAttribute('fill')).toBe('currentColor')
  })

  it('Pinned bucket: the pin is hidden at rest and shows filled (unpin) on hover', () => {
    renderList({ runs: [run({ id: 'kept', pinned: true })], onTogglePin: vi.fn() })
    const pin = bucket('Pinned').querySelector('[data-run-id="kept"] [data-slot="pin-toggle"]') as HTMLElement
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
