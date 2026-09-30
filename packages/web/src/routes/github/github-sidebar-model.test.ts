// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { GithubData, GithubItem, GithubSearchData, RunRecord } from '@open-mercato/cezar-api-client'

import {
  FAILING_QUERY,
  REVIEW_QUERY,
  filterCounts,
  formatCount,
  githubFilterPath,
  issueNumbersWithTask,
  parseGithubFilter,
  rowsFromSearch,
} from './github-sidebar-model'

const issue = (number: number, over: Partial<GithubItem> = {}): GithubItem => ({
  kind: 'issue', number, title: `Issue ${number}`, author: 'ada', createdAt: '2026-07-01T00:00:00Z',
  labels: [], body: '', url: `https://github.com/acme/demo/issues/${number}`, comments: 0, ...over,
})
const pr = (number: number, over: Partial<GithubItem> = {}): GithubItem => ({
  kind: 'pr', number, title: `PR ${number}`, author: 'grace', createdAt: '2026-07-01T00:00:00Z',
  labels: [], body: '', url: `https://github.com/acme/demo/pull/${number}`, comments: 0, checks: null, ...over,
})
const data = (over: Partial<GithubData> = {}): GithubData => ({
  available: true, repo: 'acme/demo', viewerLogin: 'Ada', issues: [], prs: [], ...over,
})
const run = (over: Record<string, unknown>) => ({ id: 'r', archived: false, ...over }) as unknown as RunRecord

describe('parseGithubFilter', () => {
  it('accepts only the view’s own values; absent is null, unknown falls back to all', () => {
    expect(parseGithubFilter('issues', null)).toBeNull()
    expect(parseGithubFilter('issues', 'no-task')).toBe('no-task')
    expect(parseGithubFilter('issues', 'review')).toBe('all')
    expect(parseGithubFilter('prs', 'review')).toBe('review')
    expect(parseGithubFilter('prs', 'assigned')).toBe('all')
    expect(parseGithubFilter('prs', '')).toBe('all')
  })
})

describe('githubFilterPath', () => {
  it('builds list URLs that always carry an explicit filter, and keeps it on detail links', () => {
    expect(githubFilterPath('issues', 'assigned')).toBe('/github?filter=assigned')
    expect(githubFilterPath('prs', 'all')).toBe('/github/prs?filter=all')
    expect(githubFilterPath('issues', 'has-task', 14)).toBe('/github/issues/14?filter=has-task')
    expect(githubFilterPath('prs', 'failing', 9)).toBe('/github/prs/9?filter=failing')
    expect(githubFilterPath('prs', null, 9)).toBe('/github/prs/9')
    expect(githubFilterPath('issues', null)).toBe('/github')
    expect(githubFilterPath('prs', 'mine', 9, '/changes')).toBe('/github/prs/9/changes?filter=mine')
  })
})

describe('issueNumbersWithTask', () => {
  const repo = 'acme/demo'
  it('counts non-archived runs whose own-repo issue references match', () => {
    const set = issueNumbersWithTask([
      run({ issueNumber: 1 }),
      run({ referencedIssueUrl: 'https://github.com/Acme/Demo/issues/2' }),
      run({ issueNumber: 3, archived: true }),
      run({ referencedIssueUrl: 'https://github.com/other/repo/issues/4' }),
      run({ pullRequestUrl: 'https://github.com/acme/demo/pull/5' }),
    ], repo, 'p1')
    expect([...set].sort()).toEqual([1, 2])
  })
  it('never matches a foreign URL even when the number is also a bare field', () => {
    const set = issueNumbersWithTask([
      run({ issueNumber: 4, referencedIssueUrl: 'https://github.com/other/repo/issues/4' }),
    ], repo, 'p1')
    expect(set.size).toBe(0)
  })
  it('ignores URL references it cannot verify when the repo is unknown, keeps bare ones', () => {
    const set = issueNumbersWithTask([
      run({ referencedIssueUrl: 'https://github.com/acme/demo/issues/7' }),
      run({ issueNumber: 8 }),
    ], undefined, 'p1')
    expect([...set]).toEqual([8])
  })
})

describe('rowsFromSearch', () => {
  it('keeps hit order, prefers the open-list row, and includes hits beyond the list', () => {
    const open = [pr(1, { additions: 5 }), pr(2)]
    const rows = rowsFromSearch([pr(2), pr(3), pr(1)], open)
    expect(rows.map((r) => r.number)).toEqual([2, 3, 1])
    expect(rows[2]).toBe(open[0])
  })
})

describe('formatCount', () => {
  it('prints N, N+ for a lower bound, and nothing for unknown', () => {
    expect(formatCount({ value: 3, bound: 'exact' })).toBe('3')
    expect(formatCount({ value: 50, bound: 'atLeast' })).toBe('50+')
    expect(formatCount(null)).toBe('')
  })
})

describe('filterCounts', () => {
  const search = (n: number, truncated = false): GithubSearchData =>
    ({ available: true, items: Array.from({ length: n }, (_, i) => pr(100 + i)), ...(truncated ? { truncated } : {}) })
  const base = {
    gh: data({
      issues: [issue(1, { assignees: ['ada'] }), issue(2), issue(3, { assignees: ['bob'] })],
      prs: [pr(10, { author: 'ADA' }), pr(11)],
    }),
    tasks: new Set([2]),
    review: search(2),
    failing: search(50, true),
  }
  it('computes each count from its own source', () => {
    const c = filterCounts(base)
    expect(c.assigned).toEqual({ value: 1, bound: 'exact' })
    expect(c.all).toEqual({ value: 3, bound: 'exact' })
    expect(c['has-task']).toEqual({ value: 1, bound: 'exact' })
    expect(c['no-task']).toEqual({ value: 2, bound: 'exact' })
    expect(c.mine).toEqual({ value: 1, bound: 'exact' })
    expect(c['all-prs']).toEqual({ value: 2, bound: 'exact' })
    expect(c.review).toEqual({ value: 2, bound: 'exact' })
    expect(c.failing).toEqual({ value: 50, bound: 'atLeast' })
  })
  it('reports unknown, never zero, for pending or unavailable sources', () => {
    const c = filterCounts({ ...base, tasks: null, review: undefined, failing: { available: false, reason: 'x', items: [] } })
    expect(c['has-task']).toBeNull()
    expect(c['no-task']).toBeNull()
    expect(c.review).toBeNull()
    expect(c.failing).toBeNull()
  })
  it('needs a viewer login for assigned and mine', () => {
    const c = filterCounts({ ...base, gh: { ...base.gh, viewerLogin: undefined } })
    expect(c.assigned).toBeNull()
    expect(c.mine).toBeNull()
  })
  it('marks list-derived counts as lower bounds once the list hits the 1000 cap', () => {
    const issues = Array.from({ length: 1000 }, (_, i) => issue(i + 1))
    const c = filterCounts({ ...base, gh: data({ issues, prs: [] }), tasks: new Set() })
    expect(c.all).toEqual({ value: 1000, bound: 'atLeast' })
    expect(c['no-task']).toEqual({ value: 1000, bound: 'atLeast' })
  })
  it('exposes the exact qualifier queries', () => {
    expect(REVIEW_QUERY).toBe('is:open review-requested:@me')
    expect(FAILING_QUERY).toBe('is:open status:failure')
  })
})
