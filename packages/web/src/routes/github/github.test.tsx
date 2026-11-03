/** GitHub list paging and cross-state search. */
import { ISSUE_142, ISSUE_139, PR_137, GITHUB, type SentRequest, jsonResponse, stubFetch, renderAt, rows, detail } from './github.testkit'
import path from 'node:path'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GithubItem } from '@open-mercato/cezar-api-client'
import { resetToasts } from '@/components/ui/toaster'
import { ListViewportResizeObserver } from './github-geometry.testkit'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // Radix popovers position with floating-ui, which needs a ResizeObserver; jsdom has none. The
  // list's scroll owner gets a tall viewport so the virtualized rows mount (#1183).
  vi.stubGlobal('ResizeObserver', ListViewportResizeObserver)
  // The #408 follow-up persistence (remembered selection + per-item draft) is localStorage-
  // backed and jsdom's localStorage survives across tests in this file — start every test clean.
  localStorage.clear()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('scroll-driven paging (hearsay-tools/cezarion#1183, port of open-mercato/cezar#1374)', () => {
  /** jsdom has no IntersectionObserver; this one lets a test say "the sentinel scrolled into view". */
  let observers: { target: Element | null; root: Element | null; fire: (visible: boolean) => void }[]
  beforeEach(() => {
    observers = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void, opts: { root?: Element | null | undefined }) {
          const record = { target: null as Element | null, root: opts.root ?? null, fire: (v: boolean) => cb([{ isIntersecting: v }]) }
          observers.push(record)
          this.observe = (el: Element) => { record.target = el }
          this.disconnect = () => { record.target = null }
        }
        observe: (el: Element) => void
        disconnect: () => void
        unobserve() {}
      },
    )
  })

  const ISSUE_120: GithubItem = { ...ISSUE_139, number: 120, title: 'Older issue', url: 'https://github.com/acme/demo/issues/120' }
  const listPage = (path: string) => path === '/api/v1/github' || path.startsWith('/api/v1/github?')
  const sentinel = () => document.querySelector('[data-slot="gh-load-more"]')
  const live = () => observers.filter((o) => o.target !== null)

  /** First list page carries a cursor; the cursored page carries ISSUE_120 and ends the list. */
  function stubPaged(): SentRequest[] {
    const sent = stubFetch()
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input)
      if ((init?.method ?? 'GET') === 'GET' && listPage(path)) {
        sent.push({ path, method: 'GET', body: undefined })
        return path.includes('issuesCursor=')
          ? jsonResponse({ ...GITHUB, issues: [ISSUE_120], prs: [], issuesNextCursor: null, prsNextCursor: null })
          : jsonResponse({ ...GITHUB, issuesNextCursor: 'c1', prsNextCursor: null })
      }
      return base(input, init)
    })
    return sent
  }

  it('fetches the next page when the sentinel intersects, with no button', async () => {
    const sent = stubPaged()
    renderAt('/github?filter=all')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
    await waitFor(() => expect(live()).toHaveLength(1))
    // Observed against the element that really scrolls the list: with no shell `main` around it,
    // that is the list pane itself.
    expect(live()[0]!.root?.getAttribute('data-slot')).toBe('gh-list')
    expect(live()[0]!.target).toBe(sentinel())

    act(() => live()[0]!.fire(true))
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139', '120']))
    expect(sent.filter((r) => listPage(r.path) && r.path.includes('issuesCursor=c1'))).toHaveLength(1)
    // The last page is in: no sentinel, no observer, nothing left to offer.
    expect(sentinel()).toBeNull()
    expect(live()).toHaveLength(0)
  })

  it('does not fetch while the sentinel stays out of view', async () => {
    const sent = stubPaged()
    renderAt('/github?filter=all')
    await waitFor(() => expect(live()).toHaveLength(1))
    act(() => live()[0]!.fire(false))
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.filter((r) => r.path.includes('issuesCursor='))).toHaveLength(0)
    expect(rows()).toHaveLength(2)
  })

  it('a failed page stops auto-paging and Retry is the only way on', async () => {
    const sent = stubPaged()
    const paged = vi.mocked(fetch).getMockImplementation()!
    let failNext = true
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('issuesCursor=') && failNext) {
        failNext = false
        sent.push({ path: String(input), method: 'GET', body: undefined })
        return jsonResponse({ error: 'boom' }, 400)
      }
      return paged(input, init)
    })
    renderAt('/github?filter=all')
    await waitFor(() => expect(live()).toHaveLength(1))
    act(() => live()[0]!.fire(true))
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(sentinel()?.textContent).toContain('Could not load more.')
    expect(retry.getAttribute('data-slot')).toBe('gh-load-more-retry')
    expect(live()).toHaveLength(0)
    expect(sent.filter((r) => r.path.includes('issuesCursor='))).toHaveLength(1)

    fireEvent.click(retry)
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139', '120']))
  })

  it('a page GitHub could not serve (HTTP 200, available: false) keeps Retry instead of ending the list', async () => {
    const sent = stubPaged()
    const paged = vi.mocked(fetch).getMockImplementation()!
    let failNext = true
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('issuesCursor=') && failNext) {
        failNext = false
        sent.push({ path: String(input), method: 'GET', body: undefined })
        // The server's degrade contract: a timeout or lost auth answers 200 with a reason.
        return jsonResponse({ available: false, reason: 'GitHub did not answer in time. Refresh to try again.', issues: [], prs: [] })
      }
      return paged(input, init)
    })
    renderAt('/github?filter=all')
    await waitFor(() => expect(live()).toHaveLength(1))
    act(() => live()[0]!.fire(true))
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(sentinel()?.textContent).toContain('Could not load more.')
    expect(rows()).toHaveLength(2)
    expect(sent.filter((r) => r.path.includes('issuesCursor='))).toHaveLength(1)

    fireEvent.click(retry)
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139', '120']))
  })

  it('a preset with no match on the loaded pages still pages on to find one', async () => {
    const sent = stubPaged()
    const paged = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input)
      // Page 1's issues are both assigned to someone else; the viewer's issue is on page 2.
      if ((init?.method ?? 'GET') === 'GET' && listPage(path)) {
        sent.push({ path, method: 'GET', body: undefined })
        return path.includes('issuesCursor=')
          ? jsonResponse({ ...GITHUB, viewerLogin: 'octocat', issues: [{ ...ISSUE_120, assignees: ['octocat'] }], prs: [], issuesNextCursor: null, prsNextCursor: null })
          : jsonResponse({
            ...GITHUB, viewerLogin: 'octocat', issuesNextCursor: 'c1', prsNextCursor: null,
            issues: GITHUB.issues.map((issue) => ({ ...issue, assignees: ['someone-else'] })),
          })
      }
      return paged(input, init)
    })
    renderAt('/github?filter=assigned')
    await waitFor(() => expect(live()).toHaveLength(1))
    expect(rows()).toHaveLength(0)
    act(() => live()[0]!.fire(true))
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['120']))
    expect(sent.filter((r) => listPage(r.path) && r.path.includes('issuesCursor=c1'))).toHaveLength(1)
  })

  it('under a text narrow, Load more reaches matches on later pages without auto-paging', async () => {
    const sent = stubPaged()
    renderAt('/github?filter=all')
    await waitFor(() => expect(rows()).toHaveLength(2))
    // 'session' matches #142 on page 1; page 2's #120 is titled to match too.
    const paged = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('issuesCursor=')) {
        sent.push({ path: String(input), method: 'GET', body: undefined })
        return jsonResponse({ ...GITHUB, issues: [{ ...ISSUE_120, title: 'Older session bug' }], prs: [], issuesNextCursor: null, prsNextCursor: null })
      }
      return paged(input, init)
    })
    fireEvent.change(document.querySelector('[data-slot="gh-search"]')!, { target: { value: 'session' } })
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142']))
    // No observer: a narrowed list would keep the sentinel in view and crawl every page.
    expect(live()).toHaveLength(0)
    expect(sent.filter((r) => r.path.includes('issuesCursor='))).toHaveLength(0)
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142', '120']))
    expect(sent.filter((r) => r.path.includes('issuesCursor='))).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('Refresh during a pending page load keeps the fresh first page', async () => {
    let finishPage!: (response: Response) => void
    stubPaged()
    const paged = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.includes('issuesCursor=')) return new Promise<Response>((resolve) => { finishPage = resolve })
      if (path.includes('refresh=1') && listPage(path)) {
        return jsonResponse({ ...GITHUB, issues: [{ ...ISSUE_142, title: 'Fresh title' }], prs: [], issuesNextCursor: null, prsNextCursor: null })
      }
      return paged(input, init)
    })
    renderAt('/github?filter=all')
    await waitFor(() => expect(live()).toHaveLength(1))
    act(() => live()[0]!.fire(true))
    await waitFor(() => expect(finishPage).toBeTypeOf('function'))
    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142']))
    // The old page lands after the refresh: it must not restore the pre-refresh pages.
    await act(async () => { finishPage(jsonResponse({ ...GITHUB, issues: [ISSUE_120], prs: [], issuesNextCursor: null, prsNextCursor: null })) })
    await new Promise((r) => setTimeout(r, 20))
    expect(rows().map((row) => row.dataset.number)).toEqual(['142'])
    expect(rows()[0]?.textContent).toContain('Fresh title')
  })

  it('a text search pauses paging; the No task yet preset keeps paging', async () => {
    stubPaged()
    renderAt('/github?filter=all')
    await waitFor(() => expect(sentinel()).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="gh-search"]')!, { target: { value: '142' } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    // Paused, not gone: the next page waits for Load more.
    expect(live()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
    cleanup()
    observers = []
    stubPaged()
    renderAt('/github?filter=no-task')
    await waitFor(() => expect(rows()).toHaveLength(2))
    await waitFor(() => expect(live()).toHaveLength(1))
    act(() => live()[0]!.fire(true))
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139', '120']))
  })

  it('no sentinel when the first page is the whole list', async () => {
    stubFetch()
    renderAt('/github?filter=all')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(sentinel()).toBeNull()
  })
})

describe('cross-state search fallback (#730)', () => {
  const MERGED_PR: GithubItem = {
    kind: 'pr',
    number: 4507,
    title: 'reconcile payment-session amount with order total',
    author: 'wojciechszyjka',
    createdAt: '2026-07-25T07:08:17.000Z',
    labels: ['security'],
    body: 'A merged PR — never present in the open list.',
    url: 'https://github.com/acme/demo/pull/4507',
    comments: 20,
    isDraft: false,
    checks: null,
  }

  const searchBox = () => document.querySelector<HTMLInputElement>('[data-slot="gh-search"]')!
  const hits = () => document.querySelector('[data-slot="gh-search-hits"]')

  it.each(['4507', '#4507'])('searches exact numeric %s despite an open substring match', async (query) => {
    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, prs: [{ ...PR_137, number: 14507 }] }),
      [`GET /api/v1/github/search?kind=pr&q=${encodeURIComponent(query)}`]: () => jsonResponse({ available: true, items: [MERGED_PR] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.change(searchBox(), { target: { value: query } })
    await waitFor(() => expect(hits()?.textContent).toContain(MERGED_PR.title))
    expect(rows().map(row => row.dataset.number)).toEqual(['14507', '4507'])
    expect(sent.filter(r => r.path.includes('/github/search?'))).toHaveLength(1)
  })

  it.each(['unavailable', 'empty'])('reports exact lookup %s alongside local substring rows', async (outcome) => {
    let finish!: (response: Response) => void
    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, prs: [{ ...PR_137, number: 14507 }] }),
      'GET /api/v1/github/search?kind=pr&q=4507': () => new Promise(resolve => { finish = resolve }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(sent.some(r => r.path.includes('/github/search?'))).toBe(true))
    expect(screen.getByText(/Searching GitHub/)).toBeTruthy()
    finish(jsonResponse(outcome === 'empty' ? { available: true, items: [] } : { available: false, reason: 'offline' }))
    await screen.findByText(outcome === 'empty' ? /No additional pull requests/ : /GitHub could not be searched: offline/)
    expect(rows().map(row => row.dataset.number)).toEqual(['14507'])
    expect(screen.queryByText(/No open pull requests/)).toBeNull()
  })

  it.each([false, true])('shows refresh failure beside cached hits and recovers with local matches %s', async (withLocal) => {
    let outcome: 'success' | 'failure' | 'recovered' = 'success'
    const listData = { ...GITHUB, prs: withLocal ? [{ ...PR_137, number: 14507 }] : [PR_137] }
    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(listData),
      'GET /api/v1/github?limit=50&refresh=1': () => jsonResponse(listData),
      'GET /api/v1/github/search?kind=pr&q=4507': () => outcome === 'failure'
        ? jsonResponse({ error: 'Search refresh unavailable' }, 400)
        : jsonResponse({ available: true, items: [{ ...MERGED_PR, title: outcome === 'recovered' ? 'Updated remote title' : MERGED_PR.title }] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull())
    fireEvent.click(hits()!.querySelector('a')!)
    // Reuse the cached hit before refreshing, preserving the URL-selected detail.
    fireEvent.change(searchBox(), { target: { value: '' } })
    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull())
    expect(sent.filter(r => r.path.includes('/github/search?'))).toHaveLength(1)
    outcome = 'failure'
    fireEvent.click(screen.getByTitle('Refresh from GitHub'))
    await screen.findByText(/Showing previous results.*Search refresh unavailable/)
    expect(hits()?.textContent).toContain(MERGED_PR.title)
    expect(detail()?.textContent).toContain(MERGED_PR.title)
    expect(searchBox().value).toBe('4507')
    expect(rows().map(row => row.dataset.number)).toEqual(withLocal ? ['14507', '4507'] : ['4507'])
    outcome = 'recovered'
    fireEvent.click(screen.getByTitle('Refresh from GitHub'))
    await waitFor(() => expect(hits()?.textContent).toContain('Updated remote title'))
    expect(screen.queryByText(/Showing previous results/)).toBeNull()
    expect(detail()?.textContent).toContain('Updated remote title')
    expect(searchBox().value).toBe('4507')
  })

  it.each(['Stream', 'another query', '4508', ''])('hides old hits immediately on change to %s and retains URL-selected detail', async (next) => {
    const sent = stubFetch({
      'GET /api/v1/github/search?kind=pr&q=4507': () => jsonResponse({ available: true, items: [MERGED_PR] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull())
    fireEvent.click(hits()!.querySelector('a')!)
    await waitFor(() => expect(detail()?.textContent).toContain(MERGED_PR.title))
    fireEvent.change(searchBox(), { target: { value: 'intermediate keystrokes' } })
    fireEvent.change(searchBox(), { target: { value: next } })
    expect(hits()).toBeNull()
    expect(detail()?.textContent).toContain(MERGED_PR.title)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
    expect(hits()).toBeNull()
    expect(detail()?.textContent).toContain(MERGED_PR.title)
    expect(sent.filter(r => r.path.includes('/github/search?')).map(r => r.path)).toEqual([
      '/api/v1/github/search?kind=pr&q=4507',
      ...(next === '' || next === 'Stream' ? [] : [`/api/v1/github/search?kind=pr&q=${encodeURIComponent(next).replace(/%20/g, '+')}`]),
    ])
    const requestCount = sent.filter(r => r.path.includes('/github/search?')).length
    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()?.textContent).toContain(MERGED_PR.title))
    expect(detail()?.textContent).toContain(MERGED_PR.title)
    expect(sent.filter(r => r.path.includes('/github/search?'))).toHaveLength(requestCount)
  })

  it.each([null, 9999])('hydrates searched PR checks within 100 numbers with selected detail %s', async (selected) => {
    const openPrs = Array.from({ length: 105 }, (_, i) => ({ ...MERGED_PR, number: i + 1, title: `Open work ${i}`, url: `https://github.com/acme/demo/pull/${i + 1}`, checks: null }))
    const expectedNumbers = [...(selected === null ? [] : [selected]), MERGED_PR.number, ...openPrs.slice(0, selected === null ? 99 : 98).map(pr => pr.number)]
    const checksPath = `/api/v1/github/checks?prs=${encodeURIComponent(expectedNumbers.join(','))}`
    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, prs: openPrs }),
      'GET /api/v1/github/search?kind=pr&q=4507': () => jsonResponse({ available: true, items: [MERGED_PR] }),
      [`GET ${checksPath}`]: () => jsonResponse({ available: true, checks: { 4507: 'passing' } }),
    })
    renderAt(selected === null ? '/github/prs' : `/github/prs/${selected}`)
    await waitFor(() => expect(rows()).toHaveLength(105))
    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(
      document.querySelector('[data-slot="gh-row"][data-number="4507"] [data-slot="gh-row-checks"]')?.getAttribute('data-checks'),
    ).toBe('passing'))
    expect(sent.some(r => r.path === checksPath)).toBe(true)
    const requests = sent.filter(r => r.path.startsWith('/api/v1/github/checks?'))
    expect(requests.every(r => new URL(r.path, 'http://localhost').searchParams.get('prs')!.split(',').length <= 100)).toBe(true)
    // Clearing the query restores the already cached open-list window, with no lingering search demand.
    fireEvent.change(searchBox(), { target: { value: '' } })
    await waitFor(() => expect(rows()).toHaveLength(105))
    expect(hits()).toBeNull()
    expect(sent.filter(r => r.path.startsWith('/api/v1/github/checks?'))).toHaveLength(requests.length)
  })

  it('finds a merged PR the open list never contained — the bug in #730', async () => {
    const sent = stubFetch({
      'GET /api/v1/github/search?kind=pr&q=4507': () =>
        jsonResponse({ available: true, items: [MERGED_PR] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1)) // only the one OPEN pr

    fireEvent.change(searchBox(), { target: { value: '4507' } })

    await waitFor(() => expect(hits()).not.toBeNull())
    expect(hits()?.textContent).toContain('reconcile payment-session amount')
    expect(hits()?.textContent).toContain('Found on GitHub')
    expect(sent.some((r) => r.path === '/api/v1/github/search?kind=pr&q=4507')).toBe(true)
  })

  const CLOSED_ISSUE: GithubItem = {
    kind: 'issue',
    number: 4507,
    title: 'payment session amount drifts from the order total',
    author: 'wojciechszyjka',
    createdAt: '2026-07-25T07:08:17.000Z',
    labels: ['bug'],
    body: 'A closed issue — never present in the open list.',
    url: 'https://github.com/acme/demo/issues/4507',
    comments: 4,
  }

  /**
   * CLICKING a hit, not deep-linking to it — the test above renders `/github/prs/4507` directly
   * and types, so it never exercises the navigation a real user makes.
   *
   * These two cover the click path on both tabs against this file's richer fixtures. They do NOT
   * pin the route wiring: the map in `renderAt` is a hand-written copy of `routes.tsx`, so it
   * cannot catch a defect that lives in the real one — and one did (a wrapper component on
   * `/github` remounted the route on the hop and reset the search text). That guard is
   * `github-route-wiring.test.tsx`, which drives the real `AppRoutes`.
   */
  it('keeps a clicked cross-state hit open across the /github → /github/issues/:n hop', async () => {
    stubFetch({
      'GET /api/v1/github/search?kind=issue&q=4507': () =>
        jsonResponse({ available: true, items: [CLOSED_ISSUE] }),
    })
    renderAt('/github')
    await waitFor(() => expect(rows()).toHaveLength(2)) // the two OPEN issues

    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull())

    fireEvent.click(within(hits() as HTMLElement).getByRole('link'))

    // The query survived the navigation, so the hit is still rendered AND still selectable.
    await waitFor(
      () => expect(detail()?.textContent).toContain('payment session amount drifts')
    )
    expect(searchBox().value).toBe('4507')
    expect(hits()).not.toBeNull()
    expect(detail()?.textContent ?? '').not.toContain('is not among the open issues')
  })

  it('keeps a clicked cross-state hit open across the /github/prs → /github/prs/:n hop', async () => {
    stubFetch({
      'GET /api/v1/github/search?kind=pr&q=4507': () =>
        jsonResponse({ available: true, items: [MERGED_PR] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull())

    fireEvent.click(within(hits() as HTMLElement).getByRole('link'))

    await waitFor(
      () => expect(detail()?.textContent).toContain('reconcile payment-session amount')
    )
    expect(searchBox().value).toBe('4507')
    expect(hits()).not.toBeNull()
  })

  it('opens a searched item in the detail pane, like any listed row', async () => {
    stubFetch({
      'GET /api/v1/github/search?kind=pr&q=4507': () =>
        jsonResponse({ available: true, items: [MERGED_PR] }),
    })
    renderAt('/github/prs/4507')
    // The deep link renders before the list resolves; wait for the header to exist before typing.
    await waitFor(() => expect(document.querySelector('[data-slot="gh-search"]')).not.toBeNull())

    fireEvent.change(searchBox(), { target: { value: '4507' } })

    await waitFor(
      () => expect(detail()?.textContent).toContain('reconcile payment-session amount')
    )
  })

  it('does not shell out while the local filter still matches something', async () => {
    const sent = stubFetch()
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    // 'Stream' matches the open PR_137 locally — the forge must not be asked.
    fireEvent.change(searchBox(), { target: { value: 'Stream' } })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700)) // past the 350 ms debounce
    })

    expect(rows()).toHaveLength(1)
    expect(sent.some((r) => r.path.includes('/github/search'))).toBe(false)
  })

  it('says it is searching rather than claiming nothing exists', async () => {
    stubFetch({
      // Never resolves within the assertion window — the tab must not declare "no match" yet.
      'GET /api/v1/github/search?kind=pr&q=4507': () =>
        new Promise<Response>(() => {}) as unknown as Response,
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.change(searchBox(), { target: { value: '4507' } })

    await waitFor(
      () => expect(document.querySelector('[data-slot="gh-empty"]')?.textContent).toContain('Searching GitHub')
    )
  })

  it('reports an unavailable search with the server’s own reason', async () => {
    stubFetch({
      'GET /api/v1/github/search?kind=pr&q=4507': () =>
        jsonResponse({ available: false, reason: 'HTTP 403: rate limit exceeded', items: [] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.change(searchBox(), { target: { value: '4507' } })

    await waitFor(
      () =>
        expect(document.querySelector('[data-slot="gh-empty"]')?.textContent).toContain(
          'rate limit exceeded',
        )
    )
  })

  it('drops the empty-state wrapper entirely once hits arrive, so its padding leaves no gap (#838)', async () => {
    stubFetch({
      'GET /api/v1/github/search?kind=pr&q=4507': () =>
        jsonResponse({ available: true, items: [MERGED_PR] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull())

    // The verdict was already null in this state; what #838 fixes is the `px-4 py-4` container
    // still rendering around it, which read as an empty ~2 rem band above "Found on GitHub".
    expect(document.querySelector('[data-slot="gh-empty"]')).toBeNull()
  })

  it('states plainly that nothing matched in ANY state when the search comes back empty', async () => {
    stubFetch() // the default search stub answers `{available: true, items: []}`
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.change(searchBox(), { target: { value: 'nothing-matches-this' } })

    await waitFor(
      () =>
        expect(document.querySelector('[data-slot="gh-empty"]')?.textContent).toContain(
          'open, closed or merged',
        )
    )
  })

  it('stops rendering hits once the local filter matches the query again (#856)', async () => {
    // A second open PR carrying a label PR_137 does not, so the label filter can empty the local
    // narrow for a query that otherwise matches — the only way to reach the forge fallback while
    // an open item is a genuine match for the text.
    const PR_200: GithubItem = {
      kind: 'pr',
      number: 200,
      title: 'Docs pass',
      author: 'lin',
      createdAt: '2026-07-12T08:00:00.000Z',
      labels: ['docs'],
      body: '',
      url: 'https://github.com/acme/demo/pull/200',
      comments: 0,
      isDraft: false,
      checks: null,
    }
    const MERGED_STREAM: GithubItem = { ...MERGED_PR, title: 'Stream reconcile' }

    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, prs: [PR_137, PR_200] }),
      // A real `gh search prs Stream` answers with the OPEN #137 alongside the merged one — which
      // is what made the stale payload render #137 a second time.
      'GET /api/v1/github/search?kind=pr&q=Stream': () =>
        jsonResponse({ available: true, items: [PR_137, MERGED_STREAM] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(2))

    // 1. Narrow to `docs`, which #137 does not carry. The popover stays open on select.
    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-label-filter"]')!)
    const docsOption = await waitFor(() =>
      [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
        (el) => el.textContent?.trim() === 'docs',
      )!,
    )
    fireEvent.click(docsOption)
    await waitFor(() => expect(rows()).toHaveLength(1)) // only #200 survives the label narrow

    // 2. Search `Stream`: the local narrow (`Stream` + `docs`) is empty, so the forge is asked and
    //    the answer is cached under the key ('pr', 'Stream'). The hits themselves stay off screen
    //    while `docs` is on — they are narrowed by the same filter — so the request is the signal.
    fireEvent.change(searchBox(), { target: { value: 'Stream' } })
    await waitFor(
      () =>
        expect(sent.some((r) => r.path === '/api/v1/github/search?kind=pr&q=Stream')).toBe(true)
    )
    // Let the response land in the cache before the filter is cleared, so the assertion below is
    // about a cached payload outliving its `enabled` flag and not about a request in flight.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    // 3. Clear the label filter. #137 matches `Stream` locally again, so the fallback is no longer
    //    wanted — but the query TEXT never changed, so the cache key did not either. Before #856
    //    the stale payload kept rendering and #137 appeared in both lists at once.
    const clearOption = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((el) =>
      el.textContent?.startsWith('Clear'),
    )!
    fireEvent.click(clearOption)

    await waitFor(() => expect(document.querySelector('[data-slot="gh-rows"]')).not.toBeNull())
    const numbersIn = (slot: string) =>
      [...document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"] [data-slot="gh-row"]`)].map(
        (row) => row.dataset.number,
      )
    expect(numbersIn('gh-rows')).toEqual(['137'])
    // Nothing may appear in both lists — the assertion the issue asks for.
    const listed = new Set(numbersIn('gh-rows'))
    expect(numbersIn('gh-search-hits').filter((n) => listed.has(n))).toEqual([])
    expect(document.querySelector('[data-slot="gh-search-hits"]')).toBeNull()
  })

  it('never repeats a listed item under "Found on GitHub" mid-debounce either (#856)', async () => {
    // The other half of #856, and the reason the `searchWanted` gate alone is not enough: while a
    // freshly typed query debounces, the payload on screen is still the PREVIOUS query's, and
    // `searchWanted` is still derived from that same stale text — so the gate reads true. The hits
    // must disappear immediately, including items the local list now shows.
    const MERGED_STREAM: GithubItem = { ...MERGED_PR, title: 'Stream reconcile' }
    stubFetch({
      // As a real `gh search prs 4507` would: the open #137 comes back beside the merged one.
      'GET /api/v1/github/search?kind=pr&q=4507': () =>
        jsonResponse({ available: true, items: [PR_137, MERGED_STREAM] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull())

    // `Stream` matches the open #137 locally, so it enters the list above — while the hits still
    // hold the payload keyed on `4507`, which contains #137 too.
    fireEvent.change(searchBox(), { target: { value: 'Stream' } })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50)) // inside the 350 ms debounce
    })

    const numbers = rows().map((row) => row.dataset.number)
    expect(numbers).toEqual([...new Set(numbers)]) // no number rendered twice
    expect(numbers).toContain('137')
  })

  it('does not claim "open, closed or merged" when no query ever reached the forge', async () => {
    // A label-only narrow never searches — `shouldSearchForge` requires a non-empty query — so the
    // cross-state verdict would be unfounded certainty of exactly the kind #730 removed, just
    // reached from the label dropdown instead of the search box. Two labels no single item carries
    // together is the cheapest way to empty the list without typing anything.
    const PR_200: GithubItem = {
      kind: 'pr',
      number: 200,
      title: 'Docs pass',
      author: 'lin',
      createdAt: '2026-07-12T08:00:00.000Z',
      labels: ['docs'],
      body: '',
      url: 'https://github.com/acme/demo/pull/200',
      comments: 0,
      isDraft: false,
      checks: null,
    }
    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, prs: [PR_137, PR_200] }),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(2))

    // AND-narrow to `docs` + `perf`: #200 carries only the first, #137 only the second.
    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-label-filter"]')!)
    for (const name of ['docs', 'perf']) {
      const option = await waitFor(() =>
        [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
          (el) => el.textContent?.trim() === name,
        )!,
      )
      fireEvent.click(option)
    }

    await waitFor(() => expect(rows()).toHaveLength(0))
    const verdict = document.querySelector('[data-slot="gh-empty"]')?.textContent ?? ''
    expect(verdict).toContain('No open pull requests match your filter')
    expect(verdict).not.toContain('open, closed or merged')
    expect(sent.some((r) => r.path.includes('/github/search'))).toBe(false)
  })

  it('says the search failed when the REQUEST failed, not just when the driver degraded', async () => {
    // The driver's own `{available: false, reason}` was handled from the start; a request that
    // never landed was not. A `q` past the route's 256-char cap is the deterministic way there —
    // a 400 the client turns into a rejected query, which used to fall through to the flat
    // "nothing in any state" and assert the opposite of what the tab actually knows.
    const overLong = 'x'.repeat(300)
    stubFetch({
      [`GET /api/v1/github/search?kind=pr&q=${overLong}`]: () =>
        jsonResponse({ error: 'invalid search query' }, 400),
    })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.change(searchBox(), { target: { value: overLong } })

    await waitFor(
      () => {
        const verdict = document.querySelector('[data-slot="gh-empty"]')?.textContent ?? ''
        expect(verdict).toContain('GitHub could not be searched')
        expect(verdict).not.toContain('open, closed or merged')
      }
    )
  })
})

describe('cross-state search preserves fork filters', () => {
  const boards = [{ id: 'P1', title: 'First', url: 'https://github.com/users/acme/projects/1' },
    { id: 'P2', title: 'Delivery', url: 'https://github.com/users/acme/projects/2' }]
  const listData = { ...GITHUB, viewerLogin: 'alice', projects: boards, issues: [
    { ...ISSUE_142, title: 'payment open', assignees: ['bob'], projectIds: ['P1'] },
    { ...ISSUE_139, assignees: ['alice'], projectIds: ['P2'] },
  ] }
  const remote = [
    { ...ISSUE_142, number: 901, title: 'payment first', url: 'https://github.com/acme/demo/issues/901', labels: ['bug'], assignees: ['Alice'], projectIds: ['P1'] },
    { ...ISSUE_142, number: 902, title: 'payment second', url: 'https://github.com/acme/demo/issues/902', labels: ['bug'], assignees: ['bob'], projectIds: ['P2'] },
    { ...ISSUE_142, number: 903, title: 'payment third', url: 'https://github.com/acme/demo/issues/903', labels: ['bug'], assignees: ['alice'], projectIds: ['P2'] },
    { ...ISSUE_142, number: 904, title: 'payment fourth', url: 'https://github.com/acme/demo/issues/904', labels: ['enhancement'], assignees: ['alice'], projectIds: ['P2'] },
  ]
  const hits = () => document.querySelector('[data-slot="gh-search-hits"]')
  const hitTitles = () => Array.from(hits()?.querySelectorAll('li') ?? []).map(row => row.textContent).join('|')
  it('uses the full local narrow to trigger search, then ANDs labels and board with OR assignees', async () => {
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(listData),
      'GET /api/v1/github/search?kind=issue&q=payment': () => jsonResponse({ available: true, items: remote }),
    })
    renderAt('/github')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project board' }), { target: { value: 'P2' } })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'payment' } })
    await waitFor(() => expect(hits()).not.toBeNull())
    expect(hitTitles()).not.toContain('payment first')
    fireEvent.click(screen.getByRole('button', { name: 'Assigned to me' }))
    expect(hitTitles()).not.toContain('payment second')
    fireEvent.click(screen.getByRole('button', { name: /Assignee/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }))
    fireEvent.keyDown(screen.getByRole('checkbox', { name: 'bob' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /Labels/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'bug' }))
    expect(hitTitles()).toContain('payment second')
    expect(hitTitles()).toContain('payment third')
    expect(hitTitles()).not.toContain('payment fourth')
  })

  it('keeps the selected remote detail when filters hide its row', async () => {
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(listData),
      'GET /api/v1/github/search?kind=issue&q=remote': () => jsonResponse({ available: true, items: [remote[0]] }),
    })
    renderAt('/github')
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'remote' } })
    await waitFor(() => expect(hits()).not.toBeNull())
    fireEvent.click(within(hits() as HTMLElement).getByRole('link'))
    expect(detail()?.textContent).toContain('payment first')
    fireEvent.change(screen.getByRole('combobox', { name: 'Project board' }), { target: { value: 'P2' } })
    expect(hits()).toBeNull()
    expect(detail()?.textContent).toContain('payment first')
  })

  it('refresh retries an incomplete search without losing the active filter', async () => {
    let attempts = 0
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(listData),
      'GET /api/v1/github?limit=50&refresh=1': () => jsonResponse(listData),
      'GET /api/v1/github/search?kind=issue&q=remote': () => jsonResponse(++attempts === 1
        ? { available: true, items: [{ ...remote[0], projectIds: undefined }], projectsReason: 'Project board lookup timed out.' }
        : { available: true, items: [remote[2]] }),
    })
    renderAt('/github')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project board' }), { target: { value: 'P2' } })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'remote' } })
    await screen.findByText(/Cannot apply the selected filters/)
    fireEvent.click(screen.getByTitle('Refresh from GitHub'))
    await waitFor(() => expect(hitTitles()).toContain('payment third'))
    expect((screen.getByRole('combobox', { name: 'Project board' }) as HTMLSelectElement).value).toBe('P2')
  })

  it('does not claim exhaustive absence when filters discard a truncated search window', async () => {
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(listData),
      'GET /api/v1/github/search?kind=issue&q=remote': () => jsonResponse({ available: true, items: [remote[0]], truncated: true }),
    })
    renderAt('/github')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project board' }), { target: { value: 'P2' } })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'remote' } })
    await waitFor(() => expect(document.querySelector('[data-slot="gh-empty"]')?.textContent).toContain('first matches'))
    expect(document.querySelector('[data-slot="gh-empty"]')?.textContent).not.toContain('open, closed or merged')
  })

  it('reports incomplete search board metadata without clearing query or selected board', async () => {
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(listData),
      'GET /api/v1/github/search?kind=issue&q=remote': () => jsonResponse({ available: true,
        items: [{ ...remote[0], projectIds: undefined }], projectsReason: 'Project board lookup timed out.' }),
    })
    renderAt('/github')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project board' }), { target: { value: 'P2' } })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'remote' } })
    await waitFor(() => expect(document.querySelector('[data-slot="gh-empty"]')?.textContent).toContain('Project board lookup timed out.'))
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('remote')
    expect((screen.getByRole('combobox', { name: 'Project board' }) as HTMLSelectElement).value).toBe('P2')
    expect(hits()).toBeNull()
    expect(document.querySelector('[data-slot="gh-empty"]')?.textContent).not.toContain('open, closed or merged')
  })
})

it('debounces to the settled query and never searches after clearing to a label-only narrow', async () => {
  const sent = stubFetch()
  renderAt('/github')
  const box = await screen.findByRole('searchbox')
  fireEvent.change(box, { target: { value: 'oldtext' } })
  fireEvent.change(box, { target: { value: 'settledtext' } })
  expect(sent.some(r => r.path.includes('/github/search'))).toBe(false)
  await waitFor(() => expect(sent.filter(r => r.path.includes('/github/search'))).toHaveLength(1))
  expect(sent.find(r => r.path.includes('/github/search'))?.path).toContain('q=settledtext')
  fireEvent.change(box, { target: { value: 'cancelledtext' } })
  fireEvent.change(box, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Labels' }))
  fireEvent.click(await screen.findByRole('option', { name: 'bug' }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
  expect(sent.filter(r => r.path.includes('/github/search'))).toHaveLength(1)
})
