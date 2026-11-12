import { ISSUE_142, ISSUE_139, PR_137, GITHUB, COMMENT_TEXT, COMMENT_IMAGE, REVIEW_CHANGES, THREAD, type SentRequest, jsonResponse, stubFetch, renderAt, renderGithubInMain, rows, detail, ghList, ghListHandle, dragGithubList, changesRequested, health, compactHiddenFlags } from './github.testkit'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/api/queries'
import type { GithubCommentsData, GithubData, GithubItem, RunRecord } from '@open-mercato/cezar-api-client'
import { resetToasts } from '@/components/ui/toaster'
import { GITHUB_LIST_WIDTH_STORAGE_KEY, MAX_GITHUB_LIST_WIDTH, MIN_GITHUB_LIST_WIDTH } from '@/lib/github-list-width'

import { groupCommitRuns, type ThreadRow } from './github'
import { ListViewportResizeObserver } from './github-geometry.testkit'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // Radix popovers position with floating-ui, which needs a ResizeObserver; jsdom has none. The
  // list's scroll owner gets a tall viewport so the virtualized rows mount (hearsay-tools/cezarion#1183).
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

it('/github/prs/:n/changes renders PR-only file review navigation and completeness', async () => {
  const sent = stubFetch()
  renderAt('/github/prs/137/changes')
  await changesRequested(sent, 137)
  expect(await screen.findByText('2 changed files')).not.toBeNull()
  expect(screen.getByRole('navigation', { name: 'Pull request detail' }).textContent).toContain('ConversationChanges')
  expect(screen.getByRole('status').textContent).toContain('One patch was omitted.')
  expect(screen.getByLabelText('Next file').hasAttribute('disabled')).toBe(false)
})

it.each(['/github/prs/137', '/github/prs/137/changes'])('keeps the PR list beside %s, like Issues', async (route) => {
  stubFetch()
  renderAt(route)
  await screen.findByRole('heading', { name: 'Pull requests · All open' })
  expect(document.querySelector('[data-route="github"]')?.hasAttribute('data-pr-detail')).toBe(false)
  expect(document.querySelector('[data-slot="gh-list"]')).not.toBeNull()
  expect(rows().length).toBeGreaterThan(0)
})

describe('the GitHub tab lists', () => {
  it('restores one stored width for Issues and PRs', async () => {
    localStorage.setItem(GITHUB_LIST_WIDTH_STORAGE_KEY, '400')
    stubFetch()
    renderAt('/github')
    await screen.findByRole('heading', { name: 'Issues · All open' })
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('400px')

    cleanup()
    stubFetch()
    renderAt('/github/prs')
    await screen.findByRole('heading', { name: 'Pull requests · All open' })
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('400px')
  })

  it('exposes the separator range and persists pointer changes', async () => {
    stubFetch()
    renderAt('/github')
    await screen.findByRole('heading', { name: 'Issues · All open' })
    const handle = ghListHandle()
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(handle.getAttribute('aria-label')).toBe('Resize the GitHub list')
    expect(handle.getAttribute('aria-valuemin')).toBe(String(MIN_GITHUB_LIST_WIDTH))
    expect(handle.getAttribute('aria-valuemax')).toBe(String(MAX_GITHUB_LIST_WIDTH))
    expect(handle.className).toContain('touch-none')

    dragGithubList(360, 440)
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('440px')
    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    expect(localStorage.getItem(GITHUB_LIST_WIDTH_STORAGE_KEY)).toBe('440')
    expect(document.activeElement).toBe(handle)

    dragGithubList(440, 2_000)
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('520px')
    dragGithubList(520, -2_000)
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('280px')
  })

  it('supports keyboard bounds and reset while ignoring non-primary pointer input', async () => {
    stubFetch()
    renderAt('/github')
    await screen.findByRole('heading', { name: 'Issues · All open' })
    const handle = ghListHandle()
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('376px')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('520px')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('280px')
    fireEvent.doubleClick(handle)
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('360px')

    handle.setPointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { button: 2, pointerId: 1, clientX: 360 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500 })
    expect(ghList().style.getPropertyValue('--github-list-width')).toBe('360px')
    expect(handle.setPointerCapture).not.toHaveBeenCalled()
  })

  it('keeps the mobile structure and hides the resize handle below md', async () => {
    stubFetch()
    renderAt('/github')
    await screen.findByRole('heading', { name: 'Issues · All open' })
    expect(ghList().className).toContain('w-full')
    expect(ghList().className).toContain('md:w-[var(--github-list-width)]')
    expect(ghListHandle().className).toContain('hidden')
    expect(ghListHandle().className).toContain('md:block')

    cleanup()
    stubFetch()
    renderAt('/github/issues/142')
    await screen.findByRole('heading', { name: 'Issues · All open' })
    expect(ghList().className).not.toContain('max-md:max-h-64')
    expect(ghList().className.split(' ')).not.toContain('hidden')
    expect(document.querySelector('[data-slot="gh-detail"]')?.className).toContain('flex')
  })

  // jsdom lays nothing out, so the classes are all this can check. The real-layout proof
  // (the title can scroll away, then filters stay and each pane scrolls) lives in e2e.
  it('lets the GitHub title leave while filters and panes stay in flow until dock (#523)', async () => {
    stubFetch()
    renderAt('/github')
    await screen.findByRole('heading', { name: 'Issues · All open' })

    const route = document.querySelector('[data-route="github"]') as HTMLElement
    const masthead = document.querySelector('[data-slot="gh-masthead"]') as HTMLElement
    const workspace = document.querySelector('[data-slot="gh-workspace"]') as HTMLElement
    const header = document.querySelector('[data-slot="gh-header"]') as HTMLElement
    const detail = document.querySelector('[data-slot="gh-detail"]') as HTMLElement

    expect(route.className.split(' ')).not.toContain('md:h-full')
    expect(masthead).not.toBeNull()
    expect(masthead.contains(screen.getByRole('heading', { name: 'Issues · All open' }))).toBe(true)
    expect(header.contains(document.querySelector('[data-slot="gh-tabs"]'))).toBe(true)
    expect(header.contains(document.querySelector('[data-slot="gh-filter-toolbar"]'))).toBe(true)
    expect(workspace.contains(header)).toBe(true)
    expect(route.className).toContain('md:pb-4')
    expect(workspace.className).toContain('md:h-[calc(var(--gh-workspace-height,calc(100dvh-4rem))-1rem)]')
    expect(workspace.className).toContain('md:flex-none')
    expect(header.className).not.toContain('sticky')
    expect(header.className).toContain('shrink-0')
    expect(document.querySelector('[data-slot="gh-panes"]')?.className).not.toContain('sticky')
    expect(ghList().className).toContain('min-w-0')
    expect(ghList().className).toContain('md:overflow-x-hidden')
    expect(ghList().className).toContain('md:overflow-y-auto')
    expect(detail.className).toContain('md:overflow-y-auto')
  })

  // jsdom lays nothing out, so this stubs the docking geometry: a desktop viewport, a workspace
  // wide enough for columns, and a workspace top below main's top. The real-layout proof stays in
  // `github-layout.e2e.ts`; this pins which wheel input the route takes over while docking.
  it('routes wheel input over the panes to main until the workspace docks (#523)', async () => {
    stubFetch()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 48rem)' || query === '(min-width: 768px)', addEventListener() {}, removeEventListener() {},
    }))
    const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!.get!
    const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!.get!
    let workspaceTop = 120
    const spies = [
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
        return this.matches('[data-slot="gh-workspace"]') ? 1_200 : clientWidth.call(this)
      }),
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
        return this.matches('[data-slot="main"]') ? 800 : clientHeight.call(this)
      }),
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const top = this.matches('[data-slot="gh-workspace"]') ? workspaceTop : 0
        return { x: 0, y: top, top, left: 0, right: 0, bottom: top, width: 0, height: 0, toJSON: () => ({}) } as DOMRect
      }),
    ]
    try {
      const main = renderGithubInMain()
      let scrollTop = 0
      Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value } })
      await screen.findByRole('heading', { name: 'Issues · All open' })
      // Columns fit, so the route docks the workspace to main's height.
      const route = document.querySelector<HTMLElement>('[data-route="github"]')!
      await waitFor(() => expect(route.style.getPropertyValue('--gh-workspace-height')).toBe('800px'))
      await waitFor(() => expect(rows().length).toBeGreaterThan(0))
      const row = rows()[0]!
      // Pixels, lines and pages all move main; the pane under the pointer does not scroll first.
      expect(fireEvent.wheel(row, { deltaY: 40 })).toBe(false)
      expect(fireEvent.wheel(row, { deltaY: 2, deltaMode: 1 })).toBe(false)
      expect(fireEvent.wheel(row, { deltaY: 1, deltaMode: 2 })).toBe(false)
      expect(scrollTop).toBe(40 + 2 * 16 + 800)
      // Zoom, horizontal input, input outside the panes and a docked workspace keep native scrolling.
      expect(fireEvent.wheel(row, { deltaY: 40, ctrlKey: true })).toBe(true)
      expect(fireEvent.wheel(row, { deltaX: 50, deltaY: 10 })).toBe(true)
      expect(fireEvent.wheel(document.querySelector('[data-slot="gh-search"]')!, { deltaY: 40 })).toBe(true)
      workspaceTop = 1
      expect(fireEvent.wheel(row, { deltaY: 40 })).toBe(true)
      expect(scrollTop).toBe(40 + 2 * 16 + 800)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('compacts the phone header so the first result can share the 360×640 viewport (#325)', async () => {
    stubFetch()
    renderAt('/github')
    const title = await screen.findByRole('heading', { name: 'Issues · All open' })
    const route = document.querySelector('[data-route="github"]')
    const header = document.querySelector('[data-slot="gh-header"]')
    expect(route?.className).toMatch(/gap-3/)
    expect(route?.className).toMatch(/md:gap-\[22px\]/)
    expect(header?.className).toMatch(/gap-3/)
    expect(header?.className).toMatch(/md:gap-\[22px\]/)
    expect(title.className).toMatch(/text-2xl/)
    expect(title.className).toMatch(/md:text-\[15px\]/)
    expect(document.querySelector('[data-slot="gh-repo"]')?.textContent).toBe('acme/demo')
    for (const control of [
      document.querySelector('[data-slot="gh-search"]'),
      document.querySelector('[data-slot="gh-label-filter"]'),
      document.querySelector('[data-slot="gh-refresh"]'),
      screen.getByRole('button', { name: 'Clear filters' }),
      screen.getByRole('button', { name: 'Assignee' }),
      screen.getByRole('button', { name: 'Assigned to me' }),
    ]) {
      expect(control?.className).toMatch(/min-h-11|gh-utility/)
      expect(control?.className).toMatch(/min-w-11|w-full|gh-utility/)
    }
  })

  it('/github renders the header, both count tabs, the issue rows, and the first issue’s detail', async () => {
    stubFetch()
    renderAt('/github')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-header"]')).not.toBeNull())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Issues · All open')
    expect(document.querySelector('[data-slot="gh-repo"]')?.textContent).toBe('acme/demo')

    const tabs = [...document.querySelectorAll('[data-slot="gh-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))
    expect(tabs).toEqual([
      { text: 'Issues · 2', href: '/github', current: 'page' },
      { text: 'Pull requests · 1', href: '/github/prs', current: null },
    ])

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139'])
    // Rows are deep links, not click handlers.
    expect(rows()[0]?.getAttribute('href')).toBe('/github/issues/142')

    // No URL selection → the first item's detail renders (legacy parity), marked current.
    expect(rows()[0]?.getAttribute('aria-current')).toBe('page')
    await waitFor(() => expect(detail()?.textContent).toContain('Login form drops session'))
  })

  // #801: the tab's only cross-link into automations follows the capability — advertising
  // "Set up automations" on a server that answers 409 would be a dead end.
  it('offers the automations shortcut only while the capability is on', async () => {
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(document.querySelector('[data-slot="gh-header"]')).not.toBeNull())
    expect(screen.queryByRole('link', { name: 'Set up automations' })).toBeNull()

    cleanup()
    stubFetch({
      'GET /api/v1/health': () => jsonResponse({
        ...health(['claude']),
        capabilities: { ...health(['claude']).capabilities, automations: true },
      }),
    })
    renderAt('/github')
    expect(await screen.findByRole('link', { name: 'Set up automations' })).not.toBeNull()
  })

  it('/github/prs lists pull requests', async () => {
    stubFetch()
    renderAt('/github/prs')

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.getAttribute('href')).toBe('/github/prs/137')
  })

  it('a PR row hydrates its checks glyph lazily by outcome (#664); an issue row shows none', async () => {
    // The list tier no longer ships `statusCheckRollup` — rows come back `checks: null` and the
    // glyph is filled in from GET /api/v1/github/checks for the on-screen window (#664).
    const p201: GithubItem = { ...PR_137, number: 201, url: 'u201', checks: null }
    const p202: GithubItem = { ...PR_137, number: 202, url: 'u202', checks: null }
    const p203: GithubItem = { ...PR_137, number: 203, url: 'u203', checks: null }
    const pr137: GithubItem = { ...PR_137, checks: null }
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, prs: [pr137, p201, p202, p203] }),
      'GET /api/v1/github/checks?prs=137%2C201%2C202%2C203': () =>
        jsonResponse({ available: true, checks: { 137: 'failing', 201: 'passing', 202: 'pending', 203: null } }),
    })
    renderAt('/github/prs')

    await waitFor(() => expect(rows()).toHaveLength(4))
    const glyph = (number: string) =>
      document.querySelector(`[data-slot="gh-row"][data-number="${number}"] [data-slot="gh-row-checks"]`)

    // The glyph appears a beat later, once the lazy checks query resolves.
    await waitFor(() => expect(glyph('137')?.getAttribute('data-checks')).toBe('failing'))
    expect(glyph('137')?.textContent).toBe('✗')
    expect(glyph('201')?.getAttribute('data-checks')).toBe('passing')
    expect(glyph('201')?.textContent).toBe('✓')
    expect(glyph('202')?.getAttribute('data-checks')).toBe('pending')
    expect(glyph('202')?.textContent).toBe('○')
    expect(glyph('203')).toBeNull() // null from the checks map → no CI → no glyph

    // Issues never carry `checks`, and the checks query is skipped on the Issues view.
    cleanup()
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
    expect(document.querySelector('[data-slot="gh-row-checks"]')).toBeNull()
  })

  it('warms the thread on row hover so opening it is instant (#664)', async () => {
    const threadRequests: string[] = []
    stubFetch()
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace('?archived=recent', '')
      if (path.startsWith('/api/v1/github/comments/')) threadRequests.push(path)
      return (origFetch as typeof fetch)(input, init as RequestInit)
    })

    renderAt('/github') // issues view; the first issue's thread loads for the detail pane
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
    await waitFor(() => expect(threadRequests.length).toBeGreaterThan(0))
    expect(threadRequests.some((p) => p === '/api/v1/github/comments/issue/139')).toBe(false)

    // Hovering a different row prefetches ITS thread before any click.
    fireEvent.mouseEnter(document.querySelector<HTMLElement>('[data-slot="gh-row"][data-number="139"]')!)
    await waitFor(() =>
      expect(threadRequests.some((p) => p === '/api/v1/github/comments/issue/139')).toBe(true),
    )
  })

  it('shows a comment-count badge only on rows with comments (#499)', async () => {
    stubFetch()
    renderAt('/github')

    await waitFor(() => expect(rows()).toHaveLength(2))
    const badge = (number: string) =>
      document.querySelector(`[data-slot="gh-row"][data-number="${number}"] [data-slot="gh-comment-count"]`)

    // #142 has 3 comments → a labelled badge; #139 has 0 → none, so quiet rows look untouched.
    expect(badge('142')?.getAttribute('data-count')).toBe('3')
    expect(badge('142')?.getAttribute('aria-label')).toBe('3 comments')
    expect(badge('142')?.textContent).toContain('3')
    expect(badge('139')).toBeNull()
  })

  it('shows the exact open count from the single fast load — no 30+ guesswork (#664)', async () => {
    // The two-shot is gone: one fast fetch (limit 1000, no rollup) returns the whole open set, so
    // the tab reports the real count instead of the old fast-batch "30+" placeholder.
    const many: GithubData = {
      ...GITHUB,
      issues: Array.from({ length: 45 }, (_, i) => ({ ...ISSUE_142, number: i + 1, url: `u${i}` })),
    }
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(many),
    })
    renderAt('/github')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-tabs"]')).not.toBeNull())
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-tabs"] a')?.textContent).toBe('Issues · 45'),
    )
  })

  it('a row deep link selects that item and renders its detail', async () => {
    stubFetch()
    renderAt('/github/issues/139')

    await waitFor(() => expect(detail()?.textContent).toContain('Add --json flag'))
    expect(document.querySelector('[data-slot="gh-row"][data-number="139"]')?.getAttribute('aria-current')).toBe('page')
    // A blank body renders the honest placeholder, not an empty markdown shell.
    expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain('(no description)')
  })

  it('an unknown number renders the honest not-found state, not a crash', async () => {
    // Not in the open list, so the tab asks GitHub for it by number (#692); GitHub has none.
    stubFetch({ 'GET /api/v1/github/items/issue/9999': () => jsonResponse({ available: true, item: null }) })
    renderAt('/github/issues/9999')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Not found' })).toBeTruthy(),
    )
    // Since #730 the advice is actionable — a closed or merged item IS reachable through the
    // search box — so the copy must point there rather than shrug "it may be closed".
    expect(document.querySelector('[data-slot="gh-detail"]')?.textContent).toContain(
      'Search for 9999 above',
    )
  })

  it('dragging a row carries the hand-to-agent prompt as text/plain', async () => {
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(rows()).toHaveLength(2))

    const setData = vi.fn()
    fireEvent.dragStart(rows()[0]!, { dataTransfer: { setData, effectAllowed: 'none' } })
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      expect.stringContaining('Fix GitHub issue #142: Login form drops session on refresh'),
    )
    expect(setData.mock.calls[0]?.[1]).toContain(ISSUE_142.url)
  })
})

describe('remembering the last-selected tab (#417)', () => {
  it('clicking Pull requests persists the choice via PUT /api/v1/ui-state', async () => {
    const sent = stubFetch()
    renderAt('/github')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(screen.getByRole('link', { name: /Pull requests/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
        true,
      ),
    )
    const put = sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')
    expect(put?.body).toEqual({ githubView: 'prs' })
  })

  it('opening /github restores "prs" when that was the last-selected tab', async () => {
    stubFetch({ 'GET /api/v1/ui-state': () => jsonResponse({ githubView: 'prs' }) })
    renderAt('/github')

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.getAttribute('href')).toBe('/github/prs/137')
  })

  it('opening /github falls back to Issues when nothing was ever remembered', async () => {
    stubFetch({ 'GET /api/v1/ui-state': () => jsonResponse({}) })
    renderAt('/github')

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]?.getAttribute('href')).toBe('/github/issues/142')
  })

  it('clicking Issues while "prs" is remembered switches to Issues instead of bouncing back', async () => {
    // The regression this guards: without eagerly patching the query cache on click, the
    // index route would still read the stale "prs" remembered choice and redirect the click
    // straight back to /github/prs, making the Issues tab unclickable.
    stubFetch({ 'GET /api/v1/ui-state': () => jsonResponse({ githubView: 'prs' }) })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.click(screen.getByRole('link', { name: /^Issues/ }))

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139'])
  })
})

describe('the GitHub detail pane', () => {
  it('a PR renders the meta line, ± stat, label chips and the checks badge', async () => {
    stubFetch()
    renderAt('/github/prs/137')

    await waitFor(() => expect(detail()).not.toBeNull())
    const meta = document.querySelector('[data-slot="gh-meta"]')?.textContent ?? ''
    expect(meta).toContain('#137')
    expect(meta).toContain('pull request')
    expect(meta).toContain('opened by grace')
    // The comment count renders as an icon+count badge (#499), labelled for screen readers.
    const detailCount = document.querySelector('[data-slot="gh-meta"] [data-slot="gh-comment-count"]')
    expect(detailCount?.getAttribute('data-count')).toBe('1')
    expect(detailCount?.getAttribute('aria-label')).toBe('1 comment')
    expect(document.querySelector('[data-slot="gh-diffstat"]')?.textContent).toBe('+120 −30')
    expect(document.querySelector('[data-slot="gh-open-link"]')?.getAttribute('href')).toBe(PR_137.url)

    expect(document.querySelector('[data-slot="gh-label"]')?.textContent).toBe('perf')
    const checks = document.querySelector('[data-slot="gh-checks"]')
    expect(checks?.getAttribute('data-checks')).toBe('failing')
    expect(checks?.textContent).toContain('checks failing')
  })

  it('the checks badge links to the PR checks tab on GitHub, open in a new tab (#415)', async () => {
    stubFetch()
    renderAt('/github/prs/137')

    await waitFor(() => expect(detail()).not.toBeNull())
    const checks = document.querySelector('[data-slot="gh-checks"]')
    expect(checks?.tagName).toBe('A')
    expect(checks?.getAttribute('href')).toBe(`${PR_137.url}/checks`)
    expect(checks?.getAttribute('target')).toBe('_blank')
    expect(checks?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('hydrates the selected PR body and diffstat from the thread detail (hearsay-tools/cezarion#1183)', async () => {
    stubFetch({
      'GET /api/v1/github/comments/pr/137': () => jsonResponse({
        ...THREAD,
        detail: { body: 'Hydrated PR description', additions: 240, deletions: 12 },
      }),
    })
    renderAt('/github/prs/137')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain('Hydrated PR description'))
    expect(document.querySelector('[data-slot="gh-diffstat"]')?.textContent).toBe('+240 −12')
  })

  it('an issue whose list row has no body shows the detail body', async () => {
    const { body: _body, ...bodiless } = ISSUE_142
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, issues: [bodiless, ISSUE_139] }),
      'GET /api/v1/github/comments/issue/142': () => jsonResponse({ ...THREAD, detail: { body: 'Body from the detail tier' } }),
    })
    renderAt('/github/issues/142')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain('Body from the detail tier'))
    expect(document.querySelector('[data-slot="gh-body"]')?.textContent).not.toContain('(no description)')
  })

  it('renders the issue body through the markdown pipeline', async () => {
    stubFetch()
    renderAt('/github/issues/142')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain(
        'Repro: log in, hit reload',
      ),
    )
  })

  it.each(['/github/prs/137', '/github/prs/137/changes'])('shows authoritative merge state and confirms the reviewed head on %s', async (route) => {
    const sent = stubFetch({
      'GET /api/v1/github/prs/137/merge-state': () => jsonResponse({
        available: true,
        mergeState: {
          number: 137,
          title: PR_137.title,
          url: PR_137.url,
          state: 'open',
          isDraft: false,
          headRef: 'feat/sse',
          baseRef: 'main',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'mergeable',
          reviewDecision: 'approved',
          checks: [{ name: 'test', state: 'passing', required: true, url: 'https://example.com/check' }],
          methods: ['squash', 'rebase'],
          defaultMethod: 'squash',
          eligibility: 'ready',
          blockers: [],
          canMerge: true,
          canOverride: false,
        },
      }),
      'GET /api/v1/github/prs/137/merge-state?refresh=1': () => jsonResponse({
        available: true,
        mergeState: {
          number: 137,
          title: PR_137.title,
          url: PR_137.url,
          state: 'open',
          isDraft: false,
          headRef: 'feat/sse',
          baseRef: 'main',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'mergeable',
          reviewDecision: 'approved',
          checks: [],
          methods: ['squash'],
          defaultMethod: 'squash',
          eligibility: 'ready',
          blockers: [],
          canMerge: true,
          canOverride: false,
        },
      }),
      'POST /api/v1/github/prs/137/merge': () => jsonResponse({
        merged: true,
        number: 137,
        url: PR_137.url,
        method: 'squash',
      }),
    })
    renderAt(route)

    await waitFor(() => expect(document.querySelector('[data-slot="gh-merge-box"]')?.textContent).toContain('Ready to merge'))
    expect(document.querySelectorAll('[data-slot="gh-merge-status-passing"]')).toHaveLength(3)
    fireEvent.click(within(document.querySelector('[data-slot="gh-merge-box"]')!).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(sent.some((request) => request.path.endsWith('merge-state?refresh=1'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }))
    expect(sent.some((request) => request.method === 'POST')).toBe(false)
    expect(await screen.findByText(/This will merge/)).toBeTruthy()
    fireEvent.click(within(document.querySelector('[data-slot="gh-merge-confirm"]')!).getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => expect(sent.find((request) => request.method === 'POST')?.body).toEqual({
      method: 'squash',
      expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
    }))
  })

  it('allows an explicit rules override while warning that GitHub still authorizes it', async () => {
    const sent = stubFetch({
      'GET /api/v1/github/prs/137/merge-state': () => jsonResponse({
        available: true,
        mergeState: {
          number: 137,
          title: PR_137.title,
          url: PR_137.url,
          state: 'open',
          isDraft: false,
          headRef: 'feat/sse',
          baseRef: 'main',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'mergeable',
          reviewDecision: 'review-required',
          checks: [{ name: 'test', state: 'pending', required: true }],
          methods: ['squash'],
          defaultMethod: 'squash',
          eligibility: 'blocked',
          blockers: [{ code: 'reviews', message: 'A required review is missing.' }],
          canMerge: false,
          canOverride: true,
        },
      }),
      'POST /api/v1/github/prs/137/merge': () => jsonResponse({
        merged: true,
        number: 137,
        url: PR_137.url,
        method: 'squash',
      }),
    })
    renderAt('/github/prs/137')

    const override = await screen.findByRole('checkbox', { name: /Merge without waiting for requirements/ })
    expect(screen.getByRole('button', { name: 'Squash and merge' }).hasAttribute('disabled')).toBe(true)
    expect(document.querySelectorAll('[data-slot="gh-merge-status-failing"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="gh-merge-status-pending"]')).toHaveLength(1)
    fireEvent.click(override)
    fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }))
    expect(await screen.findByText(/asking GitHub to bypass unmet repository requirements/)).toBeTruthy()
    fireEvent.click(within(document.querySelector('[data-slot="gh-merge-confirm"]')!).getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => expect(sent.find((request) => request.method === 'POST')?.body).toEqual({
      method: 'squash',
      expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      overrideRules: true,
    }))
  })

  it('focuses the hand-to-agent prompt from a conflicting PR\'s merge box', async () => {
    stubFetch({
      'GET /api/v1/github/prs/137/merge-state': () => jsonResponse({
        available: true,
        mergeState: {
          number: 137,
          title: PR_137.title,
          url: PR_137.url,
          state: 'open',
          isDraft: false,
          headRef: 'feat/sse',
          baseRef: 'main',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'conflicting',
          reviewDecision: 'approved',
          checks: [],
          methods: ['squash'],
          defaultMethod: 'squash',
          eligibility: 'blocked',
          blockers: [],
          canMerge: false,
          canOverride: false,
        },
      }),
    })
    renderAt('/github/prs/137')

    // The hand-to-agent panel has its own "Run agent on this PR" submit; this is the merge box's.
    await waitFor(() => expect(document.querySelector('[data-slot="gh-merge-box"]')?.textContent).toContain('Conflicts: present'))
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-slot="gh-merge-box"]')!).getByRole('button', { name: 'Run agent on this PR' }))
    expect(document.activeElement).toBe(document.querySelector('[data-slot="gh-custom-prompt"]'))
  })
})

describe('the comment thread', () => {
  const thread = (kind: 'issue' | 'pr', n: number, data: GithubCommentsData) => ({
    [`GET /api/v1/github/comments/${kind}/${n}`]: () => jsonResponse(data),
  })
  const threadSection = () => document.querySelector('[data-slot="gh-thread"]')
  const entries = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-thread-entry"]')]

  it('renders an "Activity · N comments" section with each body through the markdown pipeline', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT, COMMENT_IMAGE] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    // Retitled by #525: heading a twenty-row list `Comments · 2` would be incoherent once events
    // render, so the section is "Activity" and the comment count becomes a secondary.
    expect(document.querySelector('[data-slot="gh-thread-header"]')?.textContent).toBe(
      'Activity · 2 comments',
    )
    expect(entries()).toHaveLength(2)
    expect(entries()[0]?.textContent).toContain('maya')
    expect(entries()[0]?.querySelector('[data-slot="gh-thread-body"]')?.textContent).toContain(
      'Confirmed on my end too',
    )
  })

  it('renders an image comment as an <img> through the shared Markdown component', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_IMAGE] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    const img = document.querySelector<HTMLImageElement>('[data-slot="gh-thread-body"] img')
    expect(img?.getAttribute('src')).toBe('https://example.com/shot.png')
  })

  it('renders nothing when BOTH streams are empty — the count badge already said so', async () => {
    stubFetch(thread('issue', 139, { available: true, comments: [], events: [] }))
    renderAt('/github/issues/139')

    await waitFor(() => expect(detail()?.textContent).toContain('Add --json flag'))
    expect(threadSection()).toBeNull()
    expect(document.querySelector('[data-slot="gh-thread-error"]')).toBeNull()
  })

  it('shows a one-line reason + open-on-GitHub link when the thread is unavailable', async () => {
    stubFetch(thread('issue', 142, { available: false, reason: 'gh not installed', comments: [] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-thread-error"]')).not.toBeNull())
    const error = document.querySelector('[data-slot="gh-thread-error"]')!
    expect(error.textContent).toContain('gh not installed')
    expect(error.querySelector('a')?.getAttribute('href')).toBe(ISSUE_142.url)
  })

  it('renders a review entry with a state chip (green/red tone tables)', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [COMMENT_TEXT, REVIEW_CHANGES] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(entries()).toHaveLength(2))
    const review = document.querySelector('[data-slot="gh-thread-entry"][data-kind="review"]')
    const chip = review?.querySelector('[data-slot="gh-review-chip"]')
    expect(chip?.getAttribute('data-review-state')).toBe('changes_requested')
    expect(chip?.textContent).toBe('changes requested')
    expect(chip?.className).toContain('text-danger')
  })

  it('uses the real avatar when present and a letter fallback when absent', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT, COMMENT_IMAGE] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(entries()).toHaveLength(2))
    // COMMENT_TEXT has an avatarUrl → an <img>; COMMENT_IMAGE has none → a letter block.
    expect(entries()[0]?.querySelector('[data-slot="gh-avatar"]')?.getAttribute('src')).toBe(
      COMMENT_TEXT.avatarUrl,
    )
    const fallback = entries()[1]?.querySelector('[data-slot="gh-avatar-fallback"]')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toBe('n') // first letter of "noAvatar"
  })

  // ---- timeline events (#525) ----------------------------------------------

  const events = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-event-row"]')]
  const SHA = 'abc1234' + 'f'.repeat(33)
  const EVT = {
    committed: {
      id: `evt-${SHA}`, kind: 'committed' as const, actor: 'Ada Lovelace',
      createdAt: '2026-01-02T00:00:00Z', sha: SHA, message: 'bound the timeline page loop',
    },
    labeled: {
      id: 'evt-1', kind: 'labeled' as const, actor: 'octocat',
      createdAt: '2026-01-03T00:00:00Z', label: { name: 'bug', color: 'd73a4a' },
    },
    merged: { id: 'evt-2', kind: 'merged' as const, actor: 'octocat', createdAt: '2026-01-04T00:00:00Z' },
    crossRef: {
      id: 'evt-3', kind: 'cross-referenced' as const, actor: 'octocat',
      createdAt: '2026-01-05T00:00:00Z', refNumber: 520, refTitle: 'Sibling work',
      refIsPr: true, url: 'https://github.com/o/r/pull/520',
    },
  }

  it('renders a row per event kind, each carrying data-kind for keying', async () => {
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [
        EVT.committed, EVT.labeled, EVT.merged, EVT.crossRef,
        { id: 'evt-4', kind: 'assigned', actor: 'octocat', createdAt: '2026-01-06T00:00:00Z', subject: 'maya' },
        { id: 'evt-5', kind: 'renamed', actor: 'octocat', createdAt: '2026-01-07T00:00:00Z', subject: 'A better title' },
        { id: 'evt-6', kind: 'head_ref_force_pushed', actor: 'octocat', createdAt: '2026-01-08T00:00:00Z' },
        { id: 'evt-7', kind: 'closed', actor: 'octocat', createdAt: '2026-01-09T00:00:00Z' },
      ],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(8))
    expect(events().map((e) => e.dataset.kind)).toEqual([
      'committed', 'labeled', 'merged', 'cross-referenced',
      'assigned', 'renamed', 'head_ref_force_pushed', 'closed',
    ])
    expect(events()[0]?.textContent).toContain('Ada Lovelace')
    expect(events()[0]?.textContent).toContain('abc1234') // short sha
    expect(events()[0]?.textContent).toContain('bound the timeline page loop')
    expect(events()[2]?.textContent).toContain('merged this')
    expect(events()[3]?.textContent).toContain('#520')
    expect(events()[4]?.textContent).toContain('assigned maya')
    expect(events()[5]?.textContent).toContain('renamed this to A better title')
    expect(events()[6]?.textContent).toContain('force-pushed')
  })

  it('renders a PR with events but ZERO comments — the motivating case', async () => {
    // The empty guard used to key on comments alone, which would hide the whole feature on a
    // merged PR carrying commits, labels and a merge event but no conversation.
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.committed, EVT.merged] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    expect(events()).toHaveLength(2)
    expect(entries()).toHaveLength(0)
    expect(document.querySelector('[data-slot="gh-thread-header"]')?.textContent).toBe(
      'Activity · 0 comments',
    )
  })

  it('interleaves comments and events chronologically', async () => {
    // The server returns two independently-capped arrays and deliberately does NOT merge them;
    // ordering is presentation. This is the merge.
    stubFetch(thread('pr', 137, {
      available: true,
      comments: [{ ...COMMENT_TEXT, createdAt: '2026-01-03T12:00:00Z' }],
      events: [
        { ...EVT.committed, createdAt: '2026-01-02T00:00:00Z' },
        { ...EVT.merged, createdAt: '2026-01-04T00:00:00Z' },
      ],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(2))
    const rows = [...document.querySelectorAll('[data-slot="gh-thread-entry"], [data-slot="gh-event-row"]')]
    expect(rows.map((r) => (r as HTMLElement).dataset.slot ?? r.getAttribute('data-slot'))).toEqual([
      'gh-event-row', 'gh-thread-entry', 'gh-event-row',
    ])
  })

  it('sends refresh=1 on the BARE /github route too, where no :n is in the URL', async () => {
    // The regression the first fix batch shipped: keying the open thread off the `:n` route param
    // left the DEFAULT landing pages refreshing nothing, because with no `:n` the tab still shows
    // a thread — `selected` falls back to items[0]. The refresh must follow what is rendered.
    const threadRequests: string[] = []
    stubFetch({ 'GET /api/v1/github?refresh=1': () => jsonResponse(GITHUB) })
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace('?archived=recent', '')
      if (path.startsWith('/api/v1/github/comments/')) threadRequests.push(path)
      return (origFetch as typeof fetch)(input, init as RequestInit)
    })

    renderAt('/github') // no :n at all
    await waitFor(() => expect(threadRequests.length).toBe(1))

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)

    await waitFor(() => expect(threadRequests.some((p) => p.includes('refresh=1'))).toBe(true))
  })

  it('does not blank the open thread while refreshing it', async () => {
    // The other half of that regression: the removeQueries predicate wiped the MOUNTED thread,
    // resetting it to pending so the loading skeleton flashed under the user on every refresh.
    stubFetch({ 'GET /api/v1/github?refresh=1': () => jsonResponse(GITHUB) })
    renderAt('/github/issues/142')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-thread"]')).not.toBeNull())

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)

    // The thread stays rendered throughout — never replaced by the loading skeleton.
    await waitFor(() => expect(document.querySelector('[data-slot="gh-thread"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="gh-thread-loading"]')).toBeNull()
  })

  it('orders a comment and an event made in the SAME second by their true order', async () => {
    // The two streams carry different precisions: events go through toISOString() (`…00.000Z`),
    // comments keep GitHub's `…00Z`. A raw string compare puts '.' (46) before 'Z' (90), so the
    // event would always win a same-second tie regardless of what actually happened first.
    stubFetch(thread('pr', 137, {
      available: true,
      comments: [{ ...COMMENT_TEXT, createdAt: '2026-01-03T10:00:00Z' }],
      events: [{ ...EVT.merged, createdAt: '2026-01-03T10:00:00.000Z' }],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    const rows = [...document.querySelectorAll('[data-slot="gh-thread-entry"], [data-slot="gh-event-row"]')]
    // Same instant → stable sort keeps insertion order, and comments are inserted first.
    expect(rows[0]?.getAttribute('data-slot')).toBe('gh-thread-entry')
  })

  it('does not let an unparseable timestamp scramble the order', async () => {
    // normalizeReviews emits createdAt: '' for a PENDING review that has a body, and
    // Date.parse('') is NaN. An NaN comparator result coerces to +0, which makes the sort
    // INCONSISTENT rather than crashing — the row lands wherever the engine leaves it. Pinned
    // to the top explicitly instead.
    stubFetch(thread('pr', 137, {
      available: true,
      comments: [
        { ...COMMENT_TEXT, id: 91, createdAt: '' },
        { ...COMMENT_TEXT, id: 92, createdAt: '2026-01-03T00:00:00Z' },
      ],
      events: [{ ...EVT.merged, createdAt: '2026-01-02T00:00:00Z' }],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(entries()).toHaveLength(2))
    const rows = [...document.querySelectorAll('[data-slot="gh-thread-entry"], [data-slot="gh-event-row"]')]
    // The timestamp-less row first, then the ordered ones — deterministic, whatever else changes.
    expect(rows.map((r) => r.getAttribute('data-slot'))).toEqual([
      'gh-thread-entry', 'gh-event-row', 'gh-thread-entry',
    ])
  })

  it('tints a label chip from the event colour', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.labeled] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    const chip = document.querySelector<HTMLElement>('[data-slot="gh-event-label"]')
    expect(chip?.textContent).toBe('bug')
    expect(chip?.style.borderColor).not.toBe('') // tinted, not the muted fallback
  })

  it('links a cross-reference out to the referenced thread', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.crossRef] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    expect(events()[0]?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/520')
  })

  it('renders comments unchanged when the server sent no events at all', async () => {
    // The degraded path: the server fell back to the legacy comments-only fetch, so `events` is
    // absent. The thread must render exactly as it did pre-#525.
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(entries()).toHaveLength(1))
    expect(events()).toHaveLength(0)
    expect(threadSection()).not.toBeNull()
  })

  it.each([
    ['passing', '✓', 'text-success'],
    ['failing', '✗', 'text-danger'],
    ['pending', '○', 'text-muted-foreground'],
  ])('renders the %s CI glyph on a commit row', async (state, glyph, tone) => {
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [{ ...EVT.committed, checks: state as 'passing' | 'failing' | 'pending' }],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    const badge = document.querySelector<HTMLElement>('[data-slot="gh-commit-checks"]')
    expect(badge?.getAttribute('data-checks')).toBe(state)
    expect(badge?.textContent).toBe(glyph)
    expect(badge?.className).toContain(tone)
  })

  it('renders no glyph when checks is null AND when it is absent', async () => {
    // null = the commit has no CI configured; absent = the rollup query failed or was skipped.
    // They look identical here on purpose, but stay distinct on the wire.
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [
        // Distinct authors so the Phase-2 commit-run grouping does not collapse them — this case
        // is about glyph rendering, not grouping.
        { ...EVT.committed, id: 'evt-null', actor: 'Ada Lovelace', checks: null },
        { ...EVT.committed, id: 'evt-absent', actor: 'Grace Hopper' }, // no `checks` key at all
      ],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(2))
    expect(document.querySelectorAll('[data-slot="gh-commit-checks"]')).toHaveLength(0)
  })

  it('collapses a run of consecutive commits by one author, and expands on click', async () => {
    const commit = (n: number, actor = 'Ada Lovelace') => ({
      id: `evt-c${n}`, kind: 'committed' as const, actor,
      createdAt: `2026-01-0${n}T00:00:00Z`, sha: String(n).repeat(40).slice(0, 40),
      message: `commit number ${n}`, checks: 'passing' as const,
    })
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [commit(1), commit(2), commit(3)],
    }))
    renderAt('/github/prs/137')

    const group = () => document.querySelector<HTMLElement>('[data-slot="gh-commit-group"]')
    await waitFor(() => expect(group()).not.toBeNull())

    // Collapsed: one summary row, no individual commit rows.
    expect(group()?.dataset.open).toBe('false')
    expect(group()?.textContent).toContain('added 3 commits')
    expect(group()?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(events()).toHaveLength(0)

    fireEvent.click(group()!.querySelector('button')!)

    // Expanded: each commit keeps its own message AND its own glyph — nothing is lost to the
    // collapse, which is why grouping is client-side and the wire stays flat.
    await waitFor(() => expect(events()).toHaveLength(3))
    expect(group()?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(events()[0]?.textContent).toContain('commit number 1')
    expect(events()[2]?.textContent).toContain('commit number 3')
    expect(document.querySelectorAll('[data-slot="gh-commit-checks"]')).toHaveLength(3)
  })

  it('does not group a lone commit into a "1 commit" expander', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.committed] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    expect(document.querySelector('[data-slot="gh-commit-group"]')).toBeNull()
  })

  it('manual Refresh bypasses the list cache and updates the selected issue body', async () => {
    const sent = stubFetch({
      'GET /api/v1/github?limit=50&refresh=1': () => jsonResponse({
        ...GITHUB, issues: [{ ...ISSUE_142, body: 'Edited upstream requirements' }, ISSUE_139],
      }),
    })
    renderAt('/github/issues/142')
    await screen.findByText(ISSUE_142.body!)
    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)
    await screen.findByText('Edited upstream requirements')
    expect(screen.queryByText(ISSUE_142.body!)).toBeNull()
    expect(sent.some(({ path }) => path === '/api/v1/github?limit=50&refresh=1')).toBe(true)
  })

  it('tabs show the server totals, not the loaded length (hearsay-tools/cezarion#1183)', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ ...ISSUE_139, number: 1000 + i, url: `https://github.com/acme/demo/issues/${1000 + i}` }))
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({
        ...GITHUB, issues: many, issuesTotal: 88, prsTotal: 12, issuesNextCursor: 'c45', prsNextCursor: 'p1',
      }),
    })
    renderAt('/github?filter=all')
    expect(await screen.findByText('Issues · 88')).toBeTruthy()
    expect(screen.getByText('Pull requests · 12')).toBeTruthy()
  })

  it('a deferred row shows no badge until its count lands, then shows it', async () => {
    let answer!: (response: Response) => void
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({
        ...GITHUB, issues: [{ ...ISSUE_142, comments: 0 }, { ...ISSUE_139, comments: 0 }], commentsDeferred: true,
      }),
      'GET /api/v1/github/comment-counts?kind=issue&numbers=142%2C139': () => new Promise<Response>((resolve) => { answer = resolve }),
    })
    renderAt('/github?filter=all')
    await waitFor(() => expect(rows()).toHaveLength(2))
    await waitFor(() => expect(answer).toBeTypeOf('function'))
    expect(document.querySelector('[data-slot="gh-comment-count"]')).toBeNull()
    await act(async () => { answer(jsonResponse({ available: true, counts: { 142: 3, 139: 0 } })) })
    await waitFor(() => expect(document.querySelector('[data-slot="gh-row"] [data-slot="gh-comment-count"]')?.getAttribute('data-count')).toBe('3'))
    // Rows only: the previewed detail shows the same hydrated count in its own meta line.
    expect(document.querySelectorAll('[data-slot="gh-row"] [data-slot="gh-comment-count"]')).toHaveLength(1)
  })

  it('the open detail shows the hydrated comment count, not the deferred placeholder', async () => {
    stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({
        ...GITHUB, issues: [{ ...ISSUE_142, comments: 0 }, { ...ISSUE_139, comments: 0 }], commentsDeferred: true,
      }),
      'GET /api/v1/github/comment-counts?kind=issue&numbers=142%2C139': () => jsonResponse({ available: true, counts: { 142: 4, 139: 0 } }),
    })
    renderAt('/github/issues/142')
    await waitFor(() => expect(
      document.querySelector('[data-slot="gh-meta"] [data-slot="gh-comment-count"]')?.getAttribute('data-count'),
    ).toBe('4'))
  })

  it('Refresh collapses to a fresh first page', async () => {
    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, issuesNextCursor: 'c2', prsNextCursor: null }),
      'GET /api/v1/github?limit=50&refresh=1': () => jsonResponse({
        ...GITHUB, issues: [{ ...ISSUE_142, title: 'Fresh title' }], issuesNextCursor: 'c1', prsNextCursor: null,
      }),
    })
    const client = renderAt('/github?filter=all')
    await waitFor(() => expect(rows()).toHaveLength(2))
    // A second page is loaded (the scroll sentinel lands in a later change).
    const key = queryKeys.githubPages(50)
    await act(async () => {
      client.setQueryData(key, (current: { pages: GithubData[]; pageParams: unknown[] } | undefined) => ({
        pages: [...current!.pages, { ...GITHUB, issues: [{ ...ISSUE_139, number: 7, url: 'https://github.com/acme/demo/issues/7' }], prs: [] }],
        pageParams: [...current!.pageParams, { issuesCursor: 'c2', prsDone: true }],
      }))
    })
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)
    await waitFor(() => expect(rows().map((row) => row.dataset.number)).toEqual(['142']))
    expect(rows()[0]!.textContent).toContain('Fresh title')
    expect(client.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(key)).toMatchObject({ pages: [expect.anything()], pageParams: [{}] })
    expect(sent.some(({ path }) => path === '/api/v1/github?limit=50&refresh=1')).toBe(true)
  })

  it('sends refresh=1 for the OPEN THREAD when the tab is manually refreshed', async () => {
    // Asserts the PROPERTY (fresh data is actually requested), not the mechanism (a request went
    // out). The first attempt at this fix only invalidated the query key, which made the client
    // re-request WITHOUT `refresh=1` — and the route only busts its 60 s commentsCache when that
    // param is present, so the user got the same stale object back and the test still passed.
    const threadRequests: string[] = []
    const sent = stubFetch({
      'GET /api/v1/github?refresh=1': () => jsonResponse(GITHUB),
    })
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace('?archived=recent', '')
      if (path.startsWith('/api/v1/github/comments/')) threadRequests.push(path)
      return (origFetch as typeof fetch)(input, init as RequestInit)
    })

    renderAt('/github/issues/142')
    await waitFor(() => expect(threadRequests.length).toBe(1))
    expect(threadRequests[0]).toBe('/api/v1/github/comments/issue/142') // initial load: no refresh

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)

    // The re-request MUST carry refresh=1, or the server hands back its cached thread.
    await waitFor(() =>
      expect(threadRequests.some((p) => p === '/api/v1/github/comments/issue/142?refresh=1')).toBe(true),
    )
    expect(sent.length).toBeGreaterThan(0)
  })

  it('shows a truncation row linking to GitHub when the thread was trimmed', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT], truncated: true }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    const trunc = document.querySelector('[data-slot="gh-thread-truncated"]')
    expect(trunc?.textContent).toContain('thread truncated')
    expect(trunc?.getAttribute('href')).toBe(ISSUE_142.url)
  })
})

describe('the unavailable forge state', () => {
  it('renders the server reason and the gh hint, and Try again refetches with refresh=1', async () => {
    const unavailable: GithubData = { available: false, reason: 'gh not installed', issues: [], prs: [] }
    const sent = stubFetch({
      'GET /api/v1/github?limit=50': () => jsonResponse(unavailable),
      'GET /api/v1/github?limit=50&refresh=1': () => jsonResponse(unavailable),
    })
    renderAt('/github')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'GitHub is unavailable here' })).toBeTruthy(),
    )
    expect(screen.getByText('gh not installed')).toBeTruthy()
    // One fast fetch now (#664): the single limit=50 load is what proved the forge unreachable.
    expect(sent.some((request) => request.path === '/api/v1/github?limit=50')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(sent.some((request) => request.path === '/api/v1/github?limit=50&refresh=1')).toBe(true),
    )
  })
})

describe('groupCommitRuns', () => {
  const commit = (id: string, actor: string): ThreadRow => ({
    row: 'event',
    event: { id, kind: 'committed', actor, createdAt: '2026-01-01T00:00:00Z', sha: 'a'.repeat(40) },
  })
  const label = (id: string): ThreadRow => ({
    row: 'event',
    event: { id, kind: 'labeled', actor: 'octocat', createdAt: '2026-01-01T00:00:00Z' },
  })
  const comment = (id: number): ThreadRow => ({
    row: 'comment',
    comment: { id, author: 'maya', createdAt: '2026-01-01T00:00:00Z', body: 'hi', kind: 'comment', url: 'u' },
  })

  it('groups consecutive commits by the same author', () => {
    const out = groupCommitRuns([commit('a', 'Ada'), commit('b', 'Ada'), commit('c', 'Ada')])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ group: 'commits' })
    expect((out[0] as { commits: unknown[] }).commits).toHaveLength(3)
  })

  it('ends a run at an author change', () => {
    const out = groupCommitRuns([commit('a', 'Ada'), commit('b', 'Ada'), commit('c', 'Grace'), commit('d', 'Grace')])
    expect(out).toHaveLength(2)
    expect(out.every((g) => g.group === 'commits')).toBe(true)
  })

  it('ends a run at any non-commit row', () => {
    const out = groupCommitRuns([commit('a', 'Ada'), commit('b', 'Ada'), label('l'), commit('c', 'Ada'), commit('d', 'Ada')])
    expect(out.map((g) => g.group)).toEqual(['commits', 'single', 'commits'])
  })

  it('does not group a single commit', () => {
    const out = groupCommitRuns([commit('a', 'Ada')])
    expect(out).toEqual([{ group: 'single', entry: commit('a', 'Ada') }])
  })

  it('leaves a comment-only thread completely untouched', () => {
    const entries = [comment(1), comment(2)]
    expect(groupCommitRuns(entries)).toEqual(entries.map((entry) => ({ group: 'single', entry })))
  })

  it('handles an empty list', () => {
    expect(groupCommitRuns([])).toEqual([])
  })
})

describe('issue assignee and board controls', () => {
  const filteredData = { ...GITHUB, viewerLogin: 'alice', projects: [{ id: 'P1', title: 'Delivery', url: 'https://github.com/users/acme/projects/1' }], issues: [
    { ...ISSUE_142, assignees: ['alice'], projectIds: ['P1'] },
    { ...ISSUE_139, assignees: ['bob'], projectIds: [] },
  ] }
  it('composes Assigned to me with the board and search, then clears every filter', async () => {
    stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse(filteredData) })
    renderAt('/github')
    fireEvent.click(await screen.findByRole('button', { name: 'Assigned to me' }))
    expect(rows().map(r => r.textContent).join()).toContain(ISSUE_142.title)
    expect(rows().map(r => r.textContent).join()).not.toContain(ISSUE_139.title)
    expect(screen.queryByText('Project board')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Project board' }), { target: { value: 'P1' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search issues' }), { target: { value: 'no match' } })
    expect(rows()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    // The emptied list unmounted its virtualizer (hearsay-tools/cezarion#1183); the remount sizes its viewport on the
    // next ResizeObserver tick, which a browser delivers before paint.
    await waitFor(() => expect(rows()).toHaveLength(2))
  })
  it('marks Assigned to me active only when the viewer is the sole assignee, including manual selection', async () => {
    stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse(filteredData) })
    renderAt('/github')
    const me = await screen.findByRole('button', { name: 'Assigned to me' })
    expect(me.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }))
    expect(me.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }))
    expect(me.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }))
    expect(me.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }))
    expect(me.getAttribute('aria-pressed')).toBe('false')
  })
  it('keeps issue filters off the PR list when changing tabs', async () => {
    stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse(filteredData) })
    renderAt('/github')
    fireEvent.click(await screen.findByRole('button', { name: 'Assigned to me' }))
    fireEvent.click(screen.getByRole('link', { name: /Pull requests ·/ }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.queryByRole('button', { name: 'Assigned to me' })).toBeNull()
    expect(rows()[0]?.textContent).toContain(PR_137.title)
  })
})

it('selects multiple assignees and retains filter chrome during refresh', async () => {
  let finish!: (response: Response) => void
  const data = { ...GITHUB, viewerLogin: 'alice', projects: [], issues: [
    { ...ISSUE_142, assignees: ['alice'] }, { ...ISSUE_139, assignees: ['bob'] },
  ] }
  stubFetch({
    'GET /api/v1/github?limit=50': () => jsonResponse(data),
    'GET /api/v1/github?limit=50&refresh=1': () => new Promise(resolve => { finish = resolve }),
  })
  renderAt('/github')
  fireEvent.click(await screen.findByRole('button', { name: 'Assignee' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'alice' }))
  expect(rows()).toHaveLength(1)
  fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }))
  expect(rows()).toHaveLength(2)
  fireEvent.keyDown(screen.getByRole('checkbox', { name: 'bob' }), { key: 'Escape' })
  fireEvent.click(screen.getByTitle('Refresh from GitHub'))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.getByRole('button', { name: 'Assignee · 2' })).toBeTruthy()
  expect(rows()).toHaveLength(2)
  await act(async () => finish(jsonResponse(data)))
  expect(screen.getByRole('button', { name: 'Assignee · 2' })).toBeTruthy()
})

it('keeps legacy metadata usable with disabled personal filtering and no board picker', async () => {
  stubFetch()
  renderAt('/github')
  const me = await screen.findByRole('button', { name: 'Assigned to me' })
  expect((me as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('combobox', { name: 'Project board' })).toBeNull()
  expect(rows()).toHaveLength(2)
})

it('renders a disabled No boards picker on the filter row when projects is empty', async () => {
  stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, viewerLogin: 'alice', projects: [] }) })
  renderAt('/github')
  const picker = await screen.findByRole('combobox', { name: 'Project board' }) as HTMLSelectElement
  expect(picker.disabled).toBe(true)
  expect([...picker.options].map(option => option.textContent)).toEqual(['No boards'])
  expect(screen.queryByText('No linked project boards.')).toBeNull()
  expect(picker.className).toMatch(/min-h-11/)
  expect(document.querySelector('[data-slot="gh-issue-filters"]')?.contains(picker)).toBe(true)
})

it.each([[], undefined])('does not restore a stale board selection after refresh returns projects=%j', async projects => {
  const boardData = { ...GITHUB, projects: [{ id: 'P1', title: 'Delivery', url: 'https://github.com/users/acme/projects/1' }], issues: [
    { ...ISSUE_142, projectIds: ['P1'] }, { ...ISSUE_139, projectIds: [] },
  ] }
  let refreshes = 0
  stubFetch({
    'GET /api/v1/github?limit=50': () => jsonResponse(boardData),
    'GET /api/v1/github?limit=50&refresh=1': () => jsonResponse(++refreshes === 1 ? { ...boardData, projects } : boardData),
  })
  renderAt('/github')
  fireEvent.change(await screen.findByRole('combobox', { name: 'Project board' }), { target: { value: 'P1' } })
  expect(rows()).toHaveLength(1)
  fireEvent.click(screen.getByTitle('Refresh from GitHub'))
  await waitFor(() => expect(rows()).toHaveLength(2))
  expect(screen.getByRole('button', { name: 'Clear filters' }).hasAttribute('disabled')).toBe(true)
  await waitFor(() => expect((screen.getByTitle('Refresh from GitHub') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTitle('Refresh from GitHub'))
  const picker = await screen.findByRole('combobox', { name: 'Project board' })
  expect((picker as HTMLSelectElement).value).toBe('')
  expect(rows()).toHaveLength(2)
})

it('keeps passing checks with unknown requirements blocked', async () => {
  stubFetch({ 'GET /api/v1/github/prs/137/merge-state': () => jsonResponse({ available: true, mergeState: {
    number: 137, title: PR_137.title, url: PR_137.url, state: 'open', isDraft: false,
    headRef: 'feature', baseRef: 'main', headSha: '0123456789abcdef0123456789abcdef01234567',
    mergeable: 'mergeable', reviewDecision: 'unknown', checks: [{ name: 'fixture-check', state: 'passing', required: null }],
    methods: ['squash'], defaultMethod: 'squash', eligibility: 'unknown', blockers: [], canMerge: false, canOverride: true,
  } }) })
  renderAt('/github/prs/137')
  await screen.findByText('Merge blocked · Requirements unknown')
  expect(screen.getByRole('button', { name: 'Squash and merge' }).hasAttribute('disabled')).toBe(true)
  expect((screen.getByRole('checkbox', { name: /Merge without waiting/ }) as HTMLInputElement).checked).toBe(false)
  expect(screen.getByText(/fixture-check · passing · requiredness unknown/)).toBeTruthy()
})

it('hides phone-list rows past the second unless that row is the open detail (#344)', async () => {
  const third = { ...ISSUE_139, number: 138, url: 'https://github.com/acme/demo/issues/138' }
  stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, issues: [ISSUE_142, ISSUE_139, third] }) })
  renderAt('/github/issues/142')
  await screen.findByRole('button', { name: 'View all 3 issues' })
  expect(compactHiddenFlags()).toEqual([false, false, true])
})

it('keeps the selected phone-list row when it sits past the second (#344)', async () => {
  const third = { ...ISSUE_139, number: 138, url: 'https://github.com/acme/demo/issues/138' }
  stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, issues: [ISSUE_142, ISSUE_139, third] }) })
  renderAt('/github/issues/138')
  await screen.findByRole('button', { name: 'View all 3 issues' })
  expect(compactHiddenFlags()).toEqual([false, false, false])
  expect(rows()[2]?.getAttribute('aria-current')).toBe('page')
})

it('wraps each list row in one item that carries the divider and the phone-preview flag (hearsay-tools/cezarion#1183)', async () => {
  const third = { ...ISSUE_139, number: 138, url: 'https://github.com/acme/demo/issues/138' }
  stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, issues: [ISSUE_142, ISSUE_139, third] }) })
  renderAt('/github/issues/142')
  await screen.findByRole('button', { name: 'View all 3 issues' })
  const items = rows().map((row) => row.closest('[data-slot="gh-row-item"]'))
  // The virtualizer wraps every child in its own element, so `ul > li` and `li + li` no longer
  // reach the rows: the item itself says whether it draws a divider or hides on a phone.
  expect(items.map((item) => item?.getAttribute('role'))).toEqual(['listitem', 'listitem', 'listitem'])
  expect(items.map((item) => item?.hasAttribute('data-divided'))).toEqual([false, true, true])
  expect(document.querySelectorAll('[data-slot="gh-rows"] li')).toHaveLength(0)
})

it('lets a mobile detail preview reveal every issue without losing its selected item', async () => {
  const third = { ...ISSUE_139, number: 138, url: 'https://github.com/acme/demo/issues/138' }
  stubFetch({ 'GET /api/v1/github?limit=50': () => jsonResponse({ ...GITHUB, issues: [ISSUE_142, ISSUE_139, third] }) })
  renderAt('/github/issues/142')
  const expand = await screen.findByRole('button', { name: 'View all 3 issues' })
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  expect(compactHiddenFlags()).toEqual([false, false, true])
  fireEvent.click(expand)
  expect(screen.getByRole('button', { name: 'Show fewer issues' }).getAttribute('aria-expanded')).toBe('true')
  expect(rows()).toHaveLength(3)
  expect(compactHiddenFlags()).toEqual([false, false, false])
  expect(rows()[0]?.getAttribute('aria-current')).toBe('page')
})

it.each(['ready', 'unavailable', 'network'] as const)('keeps the board filter and unknown rows while project metadata refreshes, then settles as %s', async state => {
  const generation = '00000000-0000-4000-8000-000000000662'
  const boardData = { ...GITHUB, projects: [{ id: 'P1', title: 'Delivery', url: 'https://github.com/orgs/acme/projects/1' }], issues: [
    { ...ISSUE_142, projectIds: ['P1'] }, { ...ISSUE_139, projectIds: [] },
  ] }
  let finish!: (value: Response) => void
  stubFetch({
    'GET /api/v1/github?limit=50': () => jsonResponse(boardData),
    'GET /api/v1/github?limit=50&refresh=1': () => jsonResponse({ ...boardData, projectsState: 'refreshing', projectsGeneration: generation,
      issues: [boardData.issues[0], { ...ISSUE_139 }] }),
    [`GET /api/v1/github/projects?generation=${generation}`]: () => new Promise<Response>(resolve => { finish = resolve }),
  })
  renderAt('/github')
  const picker = await screen.findByRole('combobox', { name: 'Project board' })
  fireEvent.change(picker, { target: { value: 'P1' } })
  expect(rows()).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText(/Refreshing project boards/)
  expect((picker as HTMLSelectElement).value).toBe('P1')
  expect(rows()).toHaveLength(2)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  finish(state === 'network' ? new Response('offline', { status: 503 }) : jsonResponse(state === 'ready'
    ? { generation, state, projects: boardData.projects, membership: { 142: ['P1'], 139: [] } }
    : { generation, state, reason: 'Project lookup failed.' }))
  await waitFor(() => expect(screen.queryByText(/Refreshing project boards/)).toBeNull())
  expect((picker as HTMLSelectElement).value).toBe('P1')
  expect(rows()).toHaveLength(state === 'ready' ? 1 : 2)
  if (state !== 'ready') expect(screen.getByText(/Previous memberships are shown/)).toBeTruthy()
})

describe('deep links to items outside the open list (#692)', () => {
  const MERGED_PR: GithubItem = {
    ...PR_137,
    number: 150,
    title: 'Merged long ago',
    url: 'https://github.com/acme/demo/pull/150',
    body: 'This one already landed.',
  }
  const CLOSED_ISSUE: GithubItem = {
    ...ISSUE_142,
    number: 160,
    title: 'Closed as completed',
    url: 'https://github.com/acme/demo/issues/160',
  }
  const itemRequests = (sent: SentRequest[]) => sent.filter((request) => request.path.includes('/github/items/'))

  it('renders a merged PR’s changes view from /github/prs/N/changes', async () => {
    const sent = stubFetch({ 'GET /api/v1/github/items/pr/150': () => jsonResponse({ available: true, item: MERGED_PR }) })
    renderAt('/github/prs/150/changes')
    await waitFor(() => expect(detail()?.textContent).toContain('Merged long ago'))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).toContain('src/new.ts'))
    expect(itemRequests(sent).map((request) => request.path)).toEqual(['/api/v1/github/items/pr/150'])
  })

  it('renders a merged PR’s conversation from /github/prs/N', async () => {
    stubFetch({ 'GET /api/v1/github/items/pr/150': () => jsonResponse({ available: true, item: MERGED_PR }) })
    renderAt('/github/prs/150')
    await waitFor(() => expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain('This one already landed.'))
  })

  it('renders a closed issue from /github/issues/N', async () => {
    stubFetch({ 'GET /api/v1/github/items/issue/160': () => jsonResponse({ available: true, item: CLOSED_ISSUE }) })
    renderAt('/github/issues/160')
    await waitFor(() => expect(detail()?.textContent).toContain('Closed as completed'))
  })

  it('shows the detail loading state, not Not found, while the item is fetched', async () => {
    stubFetch({ 'GET /api/v1/github/items/pr/150': () => new Promise<Response>(() => {}) })
    renderAt('/github/prs/150')
    await waitFor(() => expect(document.querySelector('[data-slot="gh-detail-loading"]')).not.toBeNull())
    expect(screen.queryByRole('heading', { level: 2, name: 'Not found' })).toBeNull()
  })

  it('says why when GitHub cannot be asked', async () => {
    stubFetch({ 'GET /api/v1/github/items/pr/150': () => jsonResponse({ available: false, reason: 'gh is not logged in' }) })
    renderAt('/github/prs/150')
    expect(await screen.findByText('gh is not logged in')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 2, name: 'Not found' })).toBeNull()
  })

  it('Refresh from GitHub re-asks gh for the deep-linked item, past its cache', async () => {
    let refreshed = false
    const sent = stubFetch({
      'GET /api/v1/github/items/pr/150': () => jsonResponse({ available: true, item: MERGED_PR }),
      'GET /api/v1/github/items/pr/150?refresh=1': () => {
        refreshed = true
        return jsonResponse({ available: true, item: { ...MERGED_PR, title: 'Merged, then retitled' } })
      },
    })
    renderAt('/github/prs/150')
    await waitFor(() => expect(detail()?.textContent).toContain('Merged long ago'))
    fireEvent.click(screen.getByTitle('Refresh from GitHub'))
    await waitFor(() => expect(refreshed).toBe(true))
    await waitFor(() => expect(detail()?.textContent).toContain('Merged, then retitled'))
    expect(itemRequests(sent).map((request) => request.path)).toEqual([
      '/api/v1/github/items/pr/150',
      '/api/v1/github/items/pr/150?refresh=1',
    ])
  })

  it('a failed exact fetch recovers through Refresh from GitHub', async () => {
    stubFetch({
      'GET /api/v1/github/items/pr/150': () => jsonResponse({ error: 'boom' }, 500),
      'GET /api/v1/github/items/pr/150?refresh=1': () => jsonResponse({ available: true, item: MERGED_PR }),
    })
    renderAt('/github/prs/150')
    // The client retries a 5xx once on its own (query-client.ts) before the error shows.
    expect(await screen.findByRole('heading', { level: 2, name: 'Could not load #150' }, { timeout: 5000 })).toBeTruthy()
    fireEvent.click(screen.getByTitle('Refresh from GitHub'))
    await waitFor(() => expect(detail()?.textContent).toContain('Merged long ago'))
  })

  it('Could not load #N offers its own Retry, past the item cache', async () => {
    const sent = stubFetch({
      'GET /api/v1/github/items/pr/150': () => jsonResponse({ available: false, reason: 'gh is not logged in' }),
      'GET /api/v1/github/items/pr/150?refresh=1': () => jsonResponse({ available: true, item: MERGED_PR }),
    })
    renderAt('/github/prs/150')
    expect(await screen.findByText('gh is not logged in')).toBeTruthy()
    fireEvent.click(within(document.querySelector('[data-slot="gh-detail"]') as HTMLElement).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(detail()?.textContent).toContain('Merged long ago'))
    expect(itemRequests(sent).map((request) => request.path)).toContain('/api/v1/github/items/pr/150?refresh=1')
  })

  it('does not ask GitHub for an item the open list already holds', async () => {
    const sent = stubFetch()
    renderAt('/github/prs/137/changes')
    await waitFor(() => expect(detail()?.textContent).toContain('Stream tokens over SSE'))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-pr-changes"]')).not.toBeNull())
    expect(itemRequests(sent)).toEqual([])
  })
})

describe('issue linked tasks (#750)', () => {
  const task = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
    id, title: id, task: id, workflow: 'quick-task', status: RUN_STATUS.done,
    createdAt: '2026-09-01T12:00:00Z', tokensUsed: 0, archived: false, steps: [],
    issueNumber: 142, ...over,
  })
  const expand = async () => fireEvent.click(await screen.findByRole('button', { name: /^Linked tasks/ }))
  const linked = () => screen.getByRole('region', { name: /Linked tasks/ })

  it('opens a single linked task from a direct project-scoped issue URL', async () => {
    stubFetch({ 'GET /api/v1/run-summaries': () => jsonResponse([task('diagnosis')]) })
    renderAt('/p/boot/github/issues/142')
    await expand()
    const link = await screen.findByRole('link', { name: /diagnosis/ })
    expect(link.getAttribute('href')).toBe('/p/boot/tasks/diagnosis')
    expect(within(linked()).getByRole('heading').textContent).toBe('Linked tasks (1)')
    fireEvent.click(link)
    expect(await screen.findByText('Task destination')).toBeTruthy()
  })

  it('lists diagnosis and fix separately, newest first, with archived history and no duplicate or foreign tasks', async () => {
    stubFetch({ 'GET /api/v1/run-summaries': () => jsonResponse([
      task('diagnosis', { archived: true, referencedIssueUrl: ISSUE_142.url }),
      task('fix', { status: RUN_STATUS.running, createdAt: '2026-10-01T12:00:00Z' }),
      task('fix', { status: RUN_STATUS.running, createdAt: '2026-10-01T12:00:00Z' }),
      task('foreign', { referencedIssueUrl: 'https://github.com/other/repo/issues/142' }),
      task('pr-only', { issueNumber: undefined, prNumber: 142 }),
    ]) })
    renderAt('/github/issues/142')
    await expand()
    await screen.findByRole('heading', { name: 'Linked tasks (2)' })
    const links = within(linked()).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/tasks/fix', '/tasks/diagnosis'])
    expect(within(links[0]!).getByRole('img', { name: 'running' }).getAttribute('data-tone')).toBe('running')
    expect(within(links[1]!).getByRole('img', { name: 'done' }).getAttribute('data-tone')).toBe('success')
    expect(links[0]?.textContent).not.toContain('running')
    expect(links[1]?.textContent).not.toContain('done')
    expect(links[1]?.textContent).toContain('Archived')
    expect(links[1]?.querySelector('time')?.dateTime).toBe('2026-09-01T12:00:00Z')
  })

  it('shows loading before an empty answer and reacts to the existing live runs cache', async () => {
    let resolve!: (response: Response) => void
    stubFetch({ 'GET /api/v1/run-summaries': () => new Promise<Response>((r) => { resolve = r }) })
    const client = renderAt('/github/issues/142')
    await expand()
    expect(await screen.findByText('Loading linked tasks…')).toBeTruthy()
    await act(async () => resolve(jsonResponse([])))
    expect(await screen.findByText('No linked tasks yet.')).toBeTruthy()
    act(() => client.setQueryData(['default', 'runs', 'list'], [task('new-task')]))
    expect(await screen.findByRole('link', { name: /new-task/ })).toBeTruthy()
  })

  it('retries a failed runs request without hiding the issue', async () => {
    let fail = true
    stubFetch({ 'GET /api/v1/run-summaries': () => fail
      ? jsonResponse({ error: 'Unavailable' }, 403)
      : jsonResponse([task('recovered')]) })
    renderAt('/github/issues/142')
    await expand()
    const retry = await screen.findByRole('button', { name: 'Retry linked tasks' })
    expect(detail()?.textContent).toContain(ISSUE_142.title)
    fail = false
    fireEvent.click(retry)
    expect(await screen.findByRole('link', { name: /recovered/ })).toBeTruthy()
  })

  it('includes archived tasks for an exact issue absent from the open list', async () => {
    stubFetch({
      'GET /api/v1/run-summaries': () => jsonResponse([task('old-task', { issueNumber: 4507, archived: true })]),
      'GET /api/v1/github/items/issue/4507': () => jsonResponse({ available: true, item: { ...ISSUE_142, number: 4507 } }),
    })
    renderAt('/github/issues/4507')
    await expand()
    expect(await screen.findByRole('link', { name: /old-task/ })).toBeTruthy()
  })

  it('collapses when switching issues and when reopening the same issue through the real route', async () => {
    stubFetch({ 'GET /api/v1/run-summaries': () => jsonResponse([task('diagnosis')]) })
    renderAt('/github/issues/142')
    const toggle = () => screen.getByRole('button', { name: /^Linked tasks/ })
    await screen.findByRole('button', { name: 'Linked tasks (1)' })
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    await expand()
    fireEvent.click(rows().find(row => row.textContent?.includes(ISSUE_139.title))!)
    await waitFor(() => expect(detail()?.textContent).toContain(ISSUE_139.title))
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(rows().find(row => row.textContent?.includes(ISSUE_142.title))!)
    await screen.findByRole('button', { name: 'Linked tasks (1)' })
    await expand()
    fireEvent.click(screen.getByRole('link', { name: /Back to the list/ }))
    // The list keeps its first issue mounted as a desktop preview, even on a phone.
    await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('false'))
    await expand()
    fireEvent.click(rows().find(row => row.textContent?.includes(ISSUE_142.title))!)
    await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('false'))
  })
})
