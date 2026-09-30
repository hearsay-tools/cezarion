import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GithubData, GithubItem, GithubSearchData, HealthResponse, RunRecord } from '@open-mercato/cezar-api-client'

import { GithubRoute } from './github'
import { GithubSidebar } from './github-sidebar'

/**
 * The GitHub view's sidebar filters (#622) through the real route: URL state, the task join,
 * the search-backed PR filters, the phone's filter screen and the sidebar list itself.
 */

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const issue = (number: number, over: Partial<GithubItem> = {}): GithubItem => ({
  kind: 'issue', number, title: `Issue ${number}`, author: 'ada', createdAt: '2026-07-09T08:00:00.000Z',
  labels: [], body: '', url: `https://github.com/acme/demo/issues/${number}`, comments: 0, ...over,
})
const pr = (number: number, over: Partial<GithubItem> = {}): GithubItem => ({
  kind: 'pr', number, title: `PR ${number}`, author: 'grace', createdAt: '2026-07-11T08:00:00.000Z',
  labels: [], body: '', url: `https://github.com/acme/demo/pull/${number}`, comments: 0, checks: null, ...over,
})
const run = (over: Record<string, unknown>) =>
  ({ id: `r${Math.random()}`, title: 't', workflow: 'quick-task', task: 't', status: 'done', createdAt: '2026-07-20T00:00:00Z', tokensUsed: 0, archived: false, steps: [], ...over }) as unknown as RunRecord

const GITHUB: GithubData = {
  available: true, repo: 'acme/demo', syncedAt: '2026-07-15T08:00:00.000Z', viewerLogin: 'Alice',
  issues: [
    issue(1, { assignees: ['alice'] }), issue(2, { assignees: ['bob'] }), issue(3), issue(4),
  ],
  prs: [pr(10, { author: 'alice' }), pr(11), pr(12)],
}
const HEALTH = {
  version: '0.0.0-test', projects: [], bootProject: 'default', repoRoot: '/repo', repo: { root: '/repo', branch: 'main' },
  checks: [], defaultRunner: 'claude', forge: { available: true },
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false },
} as unknown as HealthResponse

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Stub {
  gh?: GithubData
  runs?: RunRecord[] | 'error'
  uiState?: Record<string, unknown>
  /** `decoded query → response` for qualifier searches. */
  search?: (query: string) => GithubSearchData | Response
}

function stub(opts: Stub = {}) {
  const sent: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    sent.push(path)
    const method = init.method ?? 'GET'
    if (method === 'GET' && /\/runs$/.test(path)) return opts.runs === 'error' ? json({ error: 'boom' }, 400) : json(opts.runs ?? [])
    if (method === 'GET' && path.includes('/github/search')) {
      const q = decodeURIComponent((new URL(path, 'http://x').searchParams.get('q') ?? '').replace(/\+/g, ' '))
      const out = opts.search?.(q) ?? { available: true, items: [] }
      return out instanceof Response ? out : json(out)
    }
    if (method === 'GET' && path.startsWith('/api/v1/github/checks')) return json({ available: true, checks: {} })
    if (method === 'GET' && path.startsWith('/api/v1/github/comments/')) return json({ available: true, comments: [] })
    if (method === 'GET' && (path === '/api/v1/github' || path.startsWith('/api/v1/github?'))) return json(opts.gh ?? GITHUB)
    if (method === 'GET' && path === '/api/v1/ui-state') return json(opts.uiState ?? {})
    if (method === 'GET' && path === '/api/v1/workflows') return json({ workflows: [] })
    if (method === 'GET' && path === '/api/v1/skills') return json([])
    if (method === 'GET' && path === '/api/v1/providers/status') return json({ providers: [] })
    if (method === 'GET' && path === '/api/v1/health') return json(HEALTH)
    if (method === 'GET' && path.startsWith('/api/v1/models')) return json({ runner: 'claude', models: [], source: 'unavailable', stale: false })
    return json({})
  }))
  return sent
}

function Where() {
  const { pathname, search } = useLocation()
  return <output data-testid="where">{pathname}{search}</output>
}

function renderAt(entry: string, extra?: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/github" element={<GithubRoute view="issues" index />} />
          <Route path="/github/prs" element={<GithubRoute view="prs" />} />
          <Route path="/github/issues/:n" element={<GithubRoute view="issues" />} />
          <Route path="/github/prs/:n" element={<GithubRoute view="prs" />} />
        </Routes>
        <Where />
        {extra}
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const numbers = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-row"]')].map((row) => Number(row.dataset.number))
const where = () => screen.getByTestId('where').textContent
const hrefs = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="gh-row"]')].map((a) => a.getAttribute('href'))
const setDesktop = (desktop: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: desktop && query === '(min-width: 768px)', addEventListener() {}, removeEventListener() {} }))

describe('Issues filters in the URL', () => {
  it('?filter=assigned shows the viewer’s issues, survives a reload, and keeps the filter in row links', async () => {
    stub()
    const first = renderAt('/github?filter=assigned')
    await waitFor(() => expect(numbers()).toEqual([1]))
    expect(hrefs()).toEqual(['/github/issues/1?filter=assigned'])
    first.unmount()
    renderAt('/github?filter=assigned')
    await waitFor(() => expect(numbers()).toEqual([1]))
  })

  it('an unknown value falls back to the whole list', async () => {
    stub()
    renderAt('/github?filter=nonsense')
    await waitFor(() => expect(numbers()).toEqual([1, 2, 3, 4]))
  })

  it('without a GitHub login, Assigned to me explains itself instead of showing everything', async () => {
    stub({ gh: { ...GITHUB, viewerLogin: undefined } })
    renderAt('/github?filter=assigned')
    await waitFor(() => expect(document.querySelector('[data-slot="gh-filter-gate"]')?.getAttribute('data-kind')).toBe('blocked'))
    expect(document.querySelector('[data-slot="gh-filter-gate"]')?.textContent).toContain('GitHub login unavailable')
    expect(numbers()).toEqual([])
  })

  it('has-task / no-task join non-archived runs that reference an own-repo issue', async () => {
    const runs = [
      run({ issueNumber: 1 }),
      run({ issueNumber: 2, archived: true }),
      run({ referencedIssueUrl: 'https://github.com/other/repo/issues/3' }),
      run({ referencedIssueUrl: 'https://github.com/acme/demo/issues/4' }),
    ]
    stub({ runs })
    const has = renderAt('/github?filter=has-task')
    await waitFor(() => expect(numbers()).toEqual([1, 4]))
    has.unmount()
    renderAt('/github?filter=no-task')
    await waitFor(() => expect(numbers()).toEqual([2, 3]))
  })

  it('does not classify everything as "no task" while the runs are unavailable', async () => {
    stub({ runs: 'error' })
    renderAt('/github?filter=no-task')
    expect(await screen.findByText(/task list is unavailable/)).not.toBeNull()
    expect(numbers()).toEqual([])
  })

  it('editing the assignee selection by hand leaves the assigned preset', async () => {
    stub({ gh: { ...GITHUB, issues: GITHUB.issues.map((i) => i) } })
    renderAt('/github?filter=assigned')
    await waitFor(() => expect(numbers()).toEqual([1]))
    fireEvent.click(screen.getByRole('button', { name: 'Assigned to me' }))
    await waitFor(() => expect(where()).toBe('/github?filter=all'))
    expect(numbers()).toEqual([1, 2, 3, 4])
  })
})

describe('Pull request filters', () => {
  it('Mine matches the author login case-insensitively', async () => {
    stub()
    renderAt('/github/prs?filter=mine')
    await waitFor(() => expect(numbers()).toEqual([10]))
    expect(hrefs()).toEqual(['/github/prs/10?filter=mine'])
  })

  it('Review requested renders the search HITS, including one past the open list, and opens its detail', async () => {
    const queries: string[] = []
    stub({
      search: (q) => {
        queries.push(q)
        return { available: true, items: [pr(12), pr(9999, { title: 'Far beyond the cap' })], truncated: true }
      },
    })
    renderAt('/github/prs?filter=review')
    await waitFor(() => expect(numbers()).toEqual([12, 9999]))
    expect(queries).toContain('is:open review-requested:@me')
    expect(document.querySelector('[data-slot="gh-filter-note"]')?.textContent).toContain('first 2 matches')
    fireEvent.click(document.querySelector('[data-slot="gh-row"][data-number="9999"]')!)
    await waitFor(() => expect(where()).toBe('/github/prs/9999?filter=review'))
    expect(await screen.findByRole('heading', { name: /#9999 Far beyond the cap/ })).not.toBeNull()
  })

  it('Checks failing uses its own qualifier', async () => {
    const queries: string[] = []
    stub({ search: (q) => { queries.push(q); return { available: true, items: [pr(11)] } } })
    renderAt('/github/prs?filter=failing')
    await waitFor(() => expect(numbers()).toEqual([11]))
    expect(queries).toEqual(['is:open status:failure'])
  })

  it('shows the reason, not an empty list, when the search is unavailable', async () => {
    stub({ search: () => ({ available: false, reason: 'rate limited', items: [] }) })
    renderAt('/github/prs?filter=review')
    expect(await screen.findByText(/rate limited/)).not.toBeNull()
    expect(numbers()).toEqual([])
  })

  it('a search-backed filter with zero hits says so and is not the "unfiltered" list', async () => {
    stub({ search: () => ({ available: true, items: [] }) })
    renderAt('/github/prs?filter=review')
    await screen.findByText(/match your filter/)
    expect(numbers()).toEqual([])
  })
})

describe('the phone filter screen and entry rules', () => {
  it('bare /github on a phone is the filter screen; a row pushes the list with a way back', async () => {
    setDesktop(false)
    stub({ uiState: { githubView: 'prs' } })
    renderAt('/github')
    const screenEl = await screen.findByRole('heading', { name: 'GitHub' })
    expect(screenEl).not.toBeNull()
    expect(document.querySelector('[data-slot="github-filter-screen"]')).not.toBeNull()
    expect(where()).toBe('/github')
    await waitFor(() => expect(document.querySelector('[data-gh-filter="assigned"] [data-slot="gh-filter-count"]')?.textContent).toBe('1'))
    fireEvent.click(document.querySelector('[data-gh-filter="assigned"]')!)
    await waitFor(() => expect(numbers()).toEqual([1]))
    expect(where()).toBe('/github?filter=assigned')
    fireEvent.click(screen.getByText('Back to filters'))
    await waitFor(() => expect(document.querySelector('[data-slot="github-filter-screen"]')).not.toBeNull())
  })

  it('an explicit filter bypasses the remembered-tab redirect, bare desktop /github keeps it', async () => {
    setDesktop(true)
    stub({ uiState: { githubView: 'prs' } })
    const explicit = renderAt('/github?filter=all')
    await waitFor(() => expect(numbers()).toEqual([1, 2, 3, 4]))
    expect(where()).toBe('/github?filter=all')
    explicit.unmount()
    renderAt('/github')
    await waitFor(() => expect(where()).toBe('/github/prs'))
  })

  it('Back from an unfiltered issue on a phone returns to a list, not the filter screen', async () => {
    setDesktop(false)
    stub()
    renderAt('/github/issues/2')
    const back = await screen.findByText('Back to the list')
    expect(back.closest('a')?.getAttribute('href')).toBe('/github?filter=all')
  })

  it('bare /github/prs stays a list on a phone (deep links keep working)', async () => {
    setDesktop(false)
    stub()
    renderAt('/github/prs')
    await waitFor(() => expect(numbers()).toEqual([10, 11, 12]))
  })
})

describe('GithubSidebar', () => {
  const sidebarAt = (entry: string) => render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}><GithubSidebar scope="default" /></MemoryRouter>
    </QueryClientProvider>,
  )
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-gh-filter="${id}"]`)!
  const count = (id: string) => row(id).querySelector('[data-slot="gh-filter-count"]')?.textContent

  it('lists the seven filters with counts, exact and lower-bound, and never a fake zero', async () => {
    stub({
      runs: [run({ issueNumber: 3 })],
      search: (q) => (q.includes('review')
        ? { available: true, items: [pr(12)] }
        : { available: false, reason: 'nope', items: [] }),
    })
    sidebarAt('/github?filter=all')
    await waitFor(() => expect(count('review')).toBe('1'))
    expect(count('assigned')).toBe('1')
    expect(count('has-task')).toBe('1')
    expect(count('no-task')).toBe('3')
    expect(count('all')).toBe('4')
    expect(count('mine')).toBe('1')
    expect(count('all-prs')).toBe('3')
    // A failed search is unknown, not zero.
    expect(count('failing')).toBeUndefined()
    expect(row('all').getAttribute('aria-current')).toBe('page')
    expect(row('assigned').getAttribute('href')).toBe('/github?filter=assigned')
    expect(row('review').getAttribute('href')).toBe('/github/prs?filter=review')
  })

  it('reads N+ with an explanation when the search hit its cap', async () => {
    const hits = Array.from({ length: 50 }, (_, i) => pr(100 + i))
    stub({ search: () => ({ available: true, items: hits, truncated: true }) })
    sidebarAt('/github/prs?filter=failing')
    await waitFor(() => expect(count('failing')).toBe('50+'))
    expect(row('failing').querySelector('[data-slot="gh-filter-count"]')?.getAttribute('title')).toContain('at most 50')
    expect(row('failing').getAttribute('aria-current')).toBe('page')
  })

  it('disables the identity rows without a login and the task rows without runs', async () => {
    stub({ gh: { ...GITHUB, viewerLogin: undefined }, runs: 'error' })
    sidebarAt('/github')
    await waitFor(() => expect(row('assigned').getAttribute('aria-disabled')).toBe('true'))
    expect(row('mine').getAttribute('aria-disabled')).toBe('true')
    await waitFor(() => expect(row('has-task').getAttribute('aria-disabled')).toBe('true'))
    expect(row('review').getAttribute('aria-disabled')).toBeNull()
  })

  it('shares the list request with the routed view instead of asking again', async () => {
    const sent = stub()
    sidebarAt('/github')
    await waitFor(() => expect(count('all')).toBe('4'))
    expect(sent.filter((p) => p.startsWith('/api/v1/github?')).length).toBe(1)
    // No request per PR: only the list, the runs, and the two qualifier searches.
    expect(sent.filter((p) => p.includes('/github/checks'))).toEqual([])
  })
})
