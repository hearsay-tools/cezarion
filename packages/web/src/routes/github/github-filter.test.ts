// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { GithubItem } from '@open-mercato/cezar-api-client'

import { allLabels, filterGithubItems, labelChipStyle, shouldSearchForge } from './github-filter'

const item = (over: Partial<GithubItem> & Pick<GithubItem, 'number' | 'title'>): GithubItem => ({
  kind: 'issue',
  author: 'octocat',
  createdAt: '2026-07-01T00:00:00Z',
  labels: [],
  body: '',
  url: `https://github.com/o/r/issues/${over.number}`,
  comments: 0,
  ...over,
})

const items = [
  item({ number: 142, title: 'Login drops session', labels: ['bug', 'auth'], author: 'alice' }),
  item({ number: 139, title: 'Add --json flag', labels: ['enhancement', 'cli'], body: 'machine-readable' }),
  item({ number: 135, title: 'Flaky e2e cleanup', labels: ['bug', 'flaky-test'] }),
]

describe('filterGithubItems', () => {
  it('matches a bare number or #id against the item number', () => {
    expect(filterGithubItems(items, { query: '142' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: '#139' }).map((i) => i.number)).toEqual([139])
    // Partial numeric match is allowed (13 → 139 and 135).
    expect(filterGithubItems(items, { query: '13' }).map((i) => i.number)).toEqual([139, 135])
  })

  it('matches free text across title, author and body (case-insensitive)', () => {
    expect(filterGithubItems(items, { query: 'login' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: 'ALICE' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: 'machine-readable' }).map((i) => i.number)).toEqual([139])
  })

  it('ANDs multiple selected labels, like GitHub', () => {
    expect(filterGithubItems(items, { labels: ['bug'] }).map((i) => i.number)).toEqual([142, 135])
    expect(filterGithubItems(items, { labels: ['bug', 'auth'] }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { labels: ['bug', 'cli'] })).toEqual([])
  })

  it('combines search and labels', () => {
    expect(filterGithubItems(items, { query: 'flaky', labels: ['bug'] }).map((i) => i.number)).toEqual([135])
  })

  it('empty filter returns everything', () => {
    expect(filterGithubItems(items, {})).toHaveLength(3)
  })
})

describe('allLabels', () => {
  it('returns the sorted distinct label set', () => {
    expect(allLabels(items)).toEqual(['auth', 'bug', 'cli', 'enhancement', 'flaky-test'])
  })
})

describe('labelChipStyle', () => {
  it('tints from a 6-hex color', () => {
    const style = labelChipStyle('d73a4a')
    expect(style.backgroundColor).toBe('#d73a4a22')
    expect(style.borderColor).toBe('#d73a4a66')
  })

  it('falls back to neutral tokens when the color is missing or malformed', () => {
    expect(labelChipStyle(undefined).color).toBe('var(--muted-foreground)')
    expect(labelChipStyle('nothex').color).toBe('var(--muted-foreground)')
  })

  it('blends the ink toward the theme foreground so it reads in both light and dark', () => {
    // No fixed hex: the color mixes toward `--foreground`, which flips per theme.
    expect(labelChipStyle('000000').color).toBe('color-mix(in srgb, #000000 50%, var(--foreground))')
  })
})

describe('issue assignment and project filters', () => {
  const rows = [
    item({ number: 1, title: 'Fix login', labels: ['bug'], assignees: ['Alice'], projectIds: ['P1'] }),
    item({ number: 2, title: 'Fix logout', labels: ['bug'], assignees: ['bob'], projectIds: ['P2'] }),
    item({ number: 3, title: 'Docs', assignees: [], projectIds: [] }),
    item({ number: 4, title: 'Legacy' }),
  ]
  it('matches any selected login case-insensitively, excluding unassigned and legacy rows', () => {
    expect(filterGithubItems(rows, { assignees: ['alice', 'BOB'] }).map(i => i.number)).toEqual([1, 2])
  })
  it('ANDs project membership with assignees, labels and search', () => {
    expect(filterGithubItems(rows, { assignees: ['alice', 'bob'], projectId: 'P2', labels: ['bug'], query: 'fix' }).map(i => i.number)).toEqual([2])
    expect(filterGithubItems(rows, { projectId: 'missing' })).toEqual([])
    expect(filterGithubItems(rows, { projectId: 'P1', query: 'docs' })).toEqual([])
  })
  it('keeps legacy and unassigned rows with no filters', () => {
    expect(filterGithubItems(rows)).toEqual(rows)
  })
})

/**
 * The fallback trigger (#730). `filterGithubItems` can only ever match the OPEN set the list
 * fetched, so "non-empty query, zero local matches" is precisely the state where the answer may
 * still exist on GitHub — closed, merged, or past the fetched window. Getting this predicate wrong
 * is either a search that never fires (the bug) or a `gh` subprocess on every keystroke.
 */
describe('shouldSearchForge', () => {
  it('fires when a real query matches nothing locally — the #730 case', () => {
    expect(filterGithubItems(items, { query: '4507' })).toHaveLength(0)
    expect(shouldSearchForge('4507', [])).toBe(true)
  })

  it('does not fire on a blank query — that is the unfiltered list, not a search', () => {
    expect(shouldSearchForge('', [])).toBe(false)
    expect(shouldSearchForge('   ', [])).toBe(false)
  })

  it('does not fire when the local filter already found something', () => {
    expect(filterGithubItems(items, { query: '142' }).length).toBeGreaterThan(0)
    expect(shouldSearchForge('142', filterGithubItems(items, { query: '142' }))).toBe(false)
  })

  // Locks what the JSDoc promises about the caller (#837): `github.tsx` counts local matches WITH
  // the label filter applied, so a label filter that empties an otherwise-matching query does reach
  // for the forge. Documented as intentional — the hits are re-narrowed by the same labels before
  // rendering — so this asserts the contract rather than guarding against it.
  it('a label filter that empties the local matches does trigger the fallback', () => {
    const countWith = (labels: readonly string[]) =>
      filterGithubItems(items, { query: '142', labels })
    expect(shouldSearchForge('142', countWith([]))).toBe(false)
    expect(countWith(['cli'])).toHaveLength(0)
    expect(shouldSearchForge('142', countWith(['cli']))).toBe(true)
  })
})
