import { describe, expect, it } from 'vitest'
import type { GithubData, GithubItem } from '@open-mercato/cezar-api-client'
import { flattenGithubPages, githubSideExhausted, nextGithubPageParam, reconcileGithubHead } from './github-pages'

const issue = (number: number, over: Partial<GithubItem> = {}): GithubItem => ({
  kind: 'issue', number, title: `Issue ${number}`, author: 'a', createdAt: '2026-10-16T00:00:00Z', labels: [], url: `u${number}`, comments: 0, ...over,
})
const pr = (number: number): GithubItem => ({ ...issue(number), kind: 'pr', title: `PR ${number}` })
const page = (over: Partial<GithubData> = {}): GithubData => ({
  available: true, repo: 'o/r', syncedAt: '2026-10-16T00:00:00Z', issues: [], prs: [],
  issuesTotal: 0, prsTotal: 0, issuesNextCursor: null, prsNextCursor: null, commentsDeferred: true, ...over,
})

describe('nextGithubPageParam', () => {
  it('issues exhausted while prs continue yields {issuesDone:true, prsCursor}', () => {
    expect(nextGithubPageParam(page({ issuesNextCursor: null, prsNextCursor: 'p2' }))).toEqual({ issuesDone: true, prsCursor: 'p2' })
    expect(nextGithubPageParam(page({ issuesNextCursor: 'i2', prsNextCursor: null }))).toEqual({ issuesCursor: 'i2', prsDone: true })
    expect(nextGithubPageParam(page({ issuesNextCursor: 'i2', prsNextCursor: 'p2' }))).toEqual({ issuesCursor: 'i2', prsCursor: 'p2' })
  })

  it('stops when both sides are done or the server does not page', () => {
    expect(nextGithubPageParam(page())).toBeUndefined()
    const older = page()
    delete (older as { issuesNextCursor?: unknown }).issuesNextCursor
    delete (older as { prsNextCursor?: unknown }).prsNextCursor
    expect(nextGithubPageParam(older)).toBeUndefined()
    expect(nextGithubPageParam({ available: false, reason: 'offline', issues: [], prs: [] })).toBeUndefined()
  })
})

describe('flattenGithubPages', () => {
  it('a row repeated across pages appears once', () => {
    const flat = flattenGithubPages([
      page({ issues: [issue(3), issue(2)], prs: [pr(9)], issuesTotal: 4, prsTotal: 1, viewerLogin: 'me', labelColors: { bug: 'f00' }, issuesNextCursor: 'c' }),
      page({ issues: [issue(2, { title: 'later copy' }), issue(1)], labelColors: { ui: '0f0' }, issuesNextCursor: null }),
    ])!
    expect(flat.issues.map((i) => [i.number, i.title])).toEqual([[3, 'Issue 3'], [2, 'Issue 2'], [1, 'Issue 1']])
    expect(flat.prs.map((p) => p.number)).toEqual([9])
    expect(flat).toMatchObject({ issuesTotal: 4, prsTotal: 1, viewerLogin: 'me', labelColors: { bug: 'f00', ui: '0f0' }, issuesNextCursor: null, commentsDeferred: true })
    expect(flat.projectsGeneration).toBeUndefined()
  })

  it('takes page 1 availability and is undefined with no pages', () => {
    expect(flattenGithubPages([])).toBeUndefined()
    expect(flattenGithubPages([{ available: false, reason: 'offline', issues: [], prs: [] }])).toMatchObject({ available: false, reason: 'offline' })
  })

  it('project state stays refreshing while any page refreshes', () => {
    const board = { id: 'P', title: 'B', url: 'u' }
    expect(flattenGithubPages([
      page({ projectsState: 'ready', projects: [board] }),
      page({ projectsState: 'refreshing' }),
      page({ projectsState: 'unavailable', projectsReason: 'denied' }),
    ])).toMatchObject({ projectsState: 'refreshing', projects: [board] })
    expect(flattenGithubPages([
      page({ projectsState: 'ready' }),
      page({ projectsState: 'unavailable', projectsReason: 'denied', projects: [board] }),
    ])).toMatchObject({ projectsState: 'unavailable', projectsReason: 'denied', projects: [board] })
    expect(flattenGithubPages([page({ projectsState: 'ready' }), page({ projectsState: 'ready' })])?.projectsState).toBe('ready')
  })
})

describe('githubSideExhausted', () => {
  it('reads null or an absent cursor as done', () => {
    expect(githubSideExhausted(page({ issuesNextCursor: 'c' }), 'issues')).toBe(false)
    expect(githubSideExhausted(page({ issuesNextCursor: 'c' }), 'prs')).toBe(true)
    expect(githubSideExhausted({ available: true, issues: [], prs: [] }, 'issues')).toBe(true)
    expect(githubSideExhausted(undefined, 'issues')).toBe(false)
  })
})

describe('reconcileGithubHead', () => {
  const loaded = [
    page({ issues: [issue(5), issue(4)], prs: [pr(9)], issuesTotal: 6, prsTotal: 1, issuesNextCursor: 'c' }),
    page({ issues: [issue(3)], issuesTotal: 6, prsTotal: 1 }),
  ]

  it('a new issue at the top with two pages loaded asks for a refetch', () => {
    expect(reconcileGithubHead(loaded, page({ issues: [issue(6), issue(5)], prs: [pr(9)], issuesTotal: 7, prsTotal: 1 }))).toBe('refetch')
    // Same numbers, a changed total (a row past page 1 closed) also refetches.
    expect(reconcileGithubHead(loaded, page({ issues: [issue(5), issue(4)], prs: [pr(9)], issuesTotal: 5, prsTotal: 1 }))).toBe('refetch')
  })

  it('an unchanged head with two pages patches titles in place', () => {
    const head = page({ issues: [issue(5, { title: 'renamed' }), issue(4)], prs: [pr(9)], issuesTotal: 6, prsTotal: 1, issuesNextCursor: 'c' })
    const next = reconcileGithubHead(loaded, head)
    expect(next).not.toBe('refetch')
    expect((next as GithubData[])[0]).toBe(head)
    expect((next as GithubData[])[1]).toBe(loaded[1])
  })

  it('carries page 1 project membership while the new head is still refreshing', () => {
    const withBoards = [page({ issues: [issue(5, { projectIds: ['P'] })], projectsState: 'ready' })]
    const head = page({ issues: [issue(5)], projectsState: 'refreshing' })
    const [patched] = reconcileGithubHead(withBoards, head) as GithubData[]
    expect(patched!.issues[0]!.projectIds).toEqual(['P'])
    const otherRepo = page({ repo: 'o/other', issues: [issue(5)], projectsState: 'refreshing' })
    expect((reconcileGithubHead(withBoards, otherRepo) as GithubData[])[0]!.issues[0]!.projectIds).toBeUndefined()
  })
})
