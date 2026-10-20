import { configureLiveSession, resetLiveSession } from './live-coordinator'
import { focusManager, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { GithubData, GithubItem } from '@open-mercato/cezar-api-client'
import { createQueryClient } from './query-client'
import { useGithubCommentCounts, useGithubPages } from './queries'

/** The paged GitHub list (hearsay-tools/cezarion#1183): one infinite query, a live head read,
 *  and per-page board metadata. Every request goes through `fetch`, routed here by URL. */
const fetchMock = vi.fn<typeof fetch>()
const BASE = '/api/v1/p/shop/github'

const issue = (number: number, over: Partial<GithubItem> = {}): GithubItem => ({
  kind: 'issue', number, title: `Issue ${number}`, author: 'a', createdAt: '2026-10-16T00:00:00Z', labels: [], url: `u${number}`, comments: 0, ...over,
})
const page = (over: Partial<GithubData>): GithubData => ({
  available: true, repo: 'o/r', syncedAt: '2026-10-16T00:00:00Z', issues: [], prs: [],
  issuesTotal: 3, prsTotal: 0, issuesNextCursor: null, prsNextCursor: null, commentsDeferred: true, ...over,
})
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
/** Answers each URL from `routes`; anything else is a test failure. */
function serve(routes: Record<string, () => unknown>) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch ${url}`)
    return json(route())
  })
}
const githubCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(BASE))

function wrapper() {
  const client = createQueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}
async function tick(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })
  vi.useFakeTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  focusManager.setFocused(true)
  setApiScope('shop')
})
afterEach(() => {
  cleanup()
  resetLiveSession()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  focusManager.setFocused(undefined)
  setApiScope(null)
})

describe('useGithubPages', () => {
  it('fetchNextPage sends the next cursors and keeps page 1 unrefetched', async () => {
    serve({
      [`${BASE}?limit=50`]: () => page({ issues: [issue(3), issue(2)], issuesNextCursor: 'i2' }),
      [`${BASE}?limit=50&issuesCursor=i2&prsDone=1`]: () => page({ issues: [issue(2), issue(1)] }),
    })
    const { result } = renderHook(() => useGithubPages(50), { wrapper: wrapper() })
    await tick()
    expect(result.current.data?.issues.map((row) => row.number)).toEqual([3, 2])
    expect(result.current.pages.hasNextPage).toBe(true)
    await act(async () => { await result.current.pages.fetchNextPage() })
    await tick()
    expect(githubCalls()).toEqual([`${BASE}?limit=50`, `${BASE}?limit=50&issuesCursor=i2&prsDone=1`])
    expect(result.current.data?.issues.map((row) => row.number)).toEqual([3, 2, 1])
    expect(result.current.pages.hasNextPage).toBe(false)
  })

  it('a head change with two pages triggers one in-order refetch of both pages', async () => {
    let opened = false
    serve({
      [`${BASE}?limit=50`]: () => opened
        ? page({ issues: [issue(4), issue(3)], issuesTotal: 4, issuesNextCursor: 'i3' })
        : page({ issues: [issue(3), issue(2)], issuesNextCursor: 'i2' }),
      [`${BASE}?limit=50&issuesCursor=i2&prsDone=1`]: () => page({ issues: [issue(1)] }),
      [`${BASE}?limit=50&issuesCursor=i3&prsDone=1`]: () => page({ issues: [issue(2), issue(1)], issuesTotal: 4 }),
    })
    const { result } = renderHook(() => useGithubPages(50), { wrapper: wrapper() })
    await tick()
    await act(async () => { await result.current.pages.fetchNextPage() })
    expect(githubCalls()).toHaveLength(2)
    opened = true // a new issue #4 opens upstream
    await tick(60_000)
    await tick()
    // The live head read, then page 1 and page 2 again, in order, page 2 from page 1's new cursor.
    expect(githubCalls().slice(2)).toEqual([`${BASE}?limit=50`, `${BASE}?limit=50`, `${BASE}?limit=50&issuesCursor=i3&prsDone=1`])
    expect(result.current.data?.issues.map((row) => row.number)).toEqual([4, 3, 2, 1])
    expect(result.current.data?.issuesTotal).toBe(4)
  })

  it('page 2 project metadata patches only page 2', async () => {
    const board = { id: 'P', title: 'Board', url: 'b' }
    serve({
      [`${BASE}?limit=50`]: () => page({ issues: [issue(3, { projectIds: [] })], issuesNextCursor: 'i2', projectsState: 'ready', projects: [board], projectsGeneration: 'g1' }),
      [`${BASE}?limit=50&issuesCursor=i2&prsDone=1`]: () => page({ issues: [issue(1)], projectsState: 'refreshing', projectsGeneration: 'g2' }),
      [`${BASE}/projects?generation=g2`]: () => ({ generation: 'g2', state: 'ready', projects: [board], membership: { 1: ['P'] } }),
    })
    const { result } = renderHook(() => useGithubPages(50), { wrapper: wrapper() })
    await tick()
    const first = result.current.pages.data?.pages[0]
    await act(async () => { await result.current.pages.fetchNextPage() })
    await tick()
    await tick()
    const [page1, page2] = result.current.pages.data!.pages
    expect(page1).toBe(first)
    expect(page2).toMatchObject({ projectsState: 'ready', issues: [{ number: 1, projectIds: ['P'] }] })
    expect(result.current.data?.projectsState).toBe('ready')
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(`${BASE}/projects?generation=g1`)
  })
})

describe('useGithubCommentCounts', () => {
  it('asks once per page group and merges the answers', async () => {
    serve({
      [`${BASE}/comment-counts?kind=issue&numbers=3%2C2`]: () => ({ available: true, counts: { 3: 5, 2: 0 } }),
      [`${BASE}/comment-counts?kind=issue&numbers=1`]: () => ({ available: false, reason: 'offline' }),
    })
    const { result } = renderHook(() => useGithubCommentCounts('issue', [[3, 2], [1]]), { wrapper: wrapper() })
    await tick()
    expect(result.current).toEqual({ 3: 5, 2: 0 })
  })
})
