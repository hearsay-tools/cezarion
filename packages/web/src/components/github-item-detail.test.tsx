import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { setApiScope, type GithubItem } from '@open-mercato/cezar-api-client'

import { GithubItemDetail } from './github-item-detail'

const PR_42: GithubItem = {
  kind: 'pr',
  number: 42,
  title: 'Share the GitHub item detail',
  author: 'grace',
  createdAt: '2026-09-30T08:00:00.000Z',
  labels: [],
  body: 'Moves the detail pane.',
  url: 'https://github.com/acme/demo/pull/42',
  comments: 0,
}

const MERGE_STATE = {
  available: true,
  mergeState: {
    number: 42,
    title: PR_42.title,
    url: PR_42.url,
    state: 'open',
    isDraft: false,
    headRef: 'feat/share',
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
}

const CONFLICTING_STATE = {
  ...MERGE_STATE,
  mergeState: { ...MERGE_STATE.mergeState, mergeable: 'conflicting', eligibility: 'blocked', canMerge: false },
}

let mergeState: typeof MERGE_STATE = MERGE_STATE

beforeEach(() => {
  mergeState = MERGE_STATE
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/merge-state') ? mergeState : { available: true, comments: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderDetail(item: GithubItem, onRunAgent?: () => void) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/p1/tasks/r1/pr/42']}>
        <GithubItemDetail item={item} colors={{}} backLink={null} subNav={null} onRunAgent={onRunAgent} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('GithubItemDetail outside the GitHub view', () => {
  it('renders no back link when backLink is null', () => {
    renderDetail(PR_42)
    expect(document.querySelector('[data-slot="gh-back"]')).toBeNull()
  })

  it('replaces the PR sub-nav with a Files changed link when subNav is null', () => {
    renderDetail(PR_42)
    expect(document.querySelector('nav[aria-label="Pull request detail"]')).toBeNull()
    const link = document.querySelector<HTMLAnchorElement>('[data-slot="gh-files-changed"]')
    expect(link?.textContent).toContain('Files changed')
    expect(link?.getAttribute('href')).toBe('/p/p1/github/prs/42/changes')
    // Conversation is always what shows: the body renders, not the diff.
    expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain('Moves the detail pane.')
  })

  it('still renders the merge box for a PR', async () => {
    renderDetail(PR_42)
    await waitFor(() => expect(document.querySelector('[data-slot="gh-merge-box"]')?.textContent).toContain('Ready to merge'))
  })

  it('renders no Files changed link for an issue', () => {
    renderDetail({ ...PR_42, kind: 'issue', url: 'https://github.com/acme/demo/issues/42' })
    expect(document.querySelector('[data-slot="gh-files-changed"]')).toBeNull()
  })

  it('offers no agent action on a conflicting PR when the caller supplies none', async () => {
    mergeState = CONFLICTING_STATE
    renderDetail(PR_42)
    await waitFor(() => expect(document.querySelector('[data-slot="gh-merge-box"]')?.textContent).toContain('Conflicts: present'))
    expect(screen.queryByRole('button', { name: 'Run agent on this PR' })).toBeNull()
  })

  it('runs the caller-supplied agent action on a conflicting PR', async () => {
    mergeState = CONFLICTING_STATE
    const onRunAgent = vi.fn()
    renderDetail(PR_42, onRunAgent)
    fireEvent.click(await screen.findByRole('button', { name: 'Run agent on this PR' }))
    expect(onRunAgent).toHaveBeenCalledTimes(1)
  })
})

describe('merging from the detail (#692)', () => {
  /** The merge flow's fetch: merge-state, the merge POST, and a ref-status answer that turns
   *  `merged` once the POST has landed — what the server's `forgetRefStatus` makes true. */
  function stubMergeFlow() {
    let merged = false
    const refStatusCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      let body: unknown = { available: true, comments: [] }
      if (url.includes('/merge-state')) body = MERGE_STATE
      else if (url.endsWith('/merge') && init.method === 'POST') {
        merged = true
        body = { merged: true, number: 42, url: PR_42.url, method: 'squash' }
      } else if (url.includes('/ref-status')) {
        refStatusCalls.push(url)
        body = { available: true, prs: { 42: merged ? 'merged' : 'open' }, issues: {}, recheckAfterMs: null }
      } else if (url.endsWith('/health')) body = { bootProject: 'p1' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return refStatusCalls
  }

  async function merge() {
    await waitFor(() => expect(document.querySelector('[data-slot="gh-merge-box"]')?.textContent).toContain('Ready to merge'))
    fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }))
    fireEvent.click(within(document.querySelector('[data-slot="gh-merge-confirm"]') as HTMLElement).getByRole('button', { name: 'Squash and merge' }))
  }

  it('invalidates the item query, so a task tab rereads the merged PR', async () => {
    stubMergeFlow()
    const client = createQueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <GithubItemDetail item={PR_42} colors={{}} backLink={null} subNav={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await merge()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.githubItem('pr', 42) }))
  })

  it('refetches the project’s reference statuses, so its chips turn merged without a reload', async () => {
    const refStatusCalls = stubMergeFlow()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ProjectScopeContext.Provider value={{ projectId: 'p1', apiBase: '/api/v1/p/p1' }}>
          <MemoryRouter>
            <ReferenceStatusProvider projectId="p1" requests={[{ projectId: 'p1', kind: 'PR', number: 42 }]}>
              <ReferenceChip reference={{ kind: 'PR', number: 42, url: PR_42.url }} taskTitle="Share the detail" />
              <GithubItemDetail item={PR_42} colors={{}} backLink={null} subNav={null} />
            </ReferenceStatusProvider>
          </MemoryRouter>
        </ProjectScopeContext.Provider>
      </QueryClientProvider>,
    )
    const chip = () => document.querySelector('[data-slot="pr-chip"]')
    await waitFor(() => expect(chip()?.getAttribute('data-status')).toBe('open'))
    await merge()
    await waitFor(() => expect(chip()?.getAttribute('data-status')).toBe('merged'))
    expect(refStatusCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('invalidates the item of the project it merged in, even after the scope moved on', async () => {
    let releaseMerge: (() => void) | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/merge') && init.method === 'POST') {
        // Held open so the scope can change while the merge is in flight.
        await new Promise<void>((resolve) => { releaseMerge = resolve })
        return respond({ merged: true, number: 42, url: PR_42.url, method: 'squash' })
      }
      if (url.includes('/merge-state')) return respond(MERGE_STATE)
      if (url.endsWith('/health')) return respond({ bootProject: 'p1' })
      return respond({ available: true, comments: [] })
    })
    setApiScope('p1')
    try {
      const client = createQueryClient()
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <GithubItemDetail item={PR_42} colors={{}} backLink={null} subNav={null} />
          </MemoryRouter>
        </QueryClientProvider>,
      )
      await merge()
      await waitFor(() => expect(releaseMerge).toBeDefined())
      // The user has moved to another project before GitHub answered.
      setApiScope('p2')
      releaseMerge!()
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['p1', 'github', 'item', 'pr', 42] }))
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['p1', 'github', 'merge-state', 42] })
      const touched = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
      expect(touched.filter((key) => key.includes('"p2"'))).toEqual([])
    } finally {
      setApiScope(null)
    }
  })

  it('files a merge-state Refresh under the project it was pressed in, after a project switch', async () => {
    let releaseRefresh: (() => void) | undefined
    const refreshed = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, title: 'Refreshed in p1' } }
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/merge-state?refresh=1')) {
        // Held open so the reader can leave for another project first.
        await new Promise<void>((resolve) => { releaseRefresh = resolve })
        return respond(refreshed)
      }
      if (url.includes('/merge-state')) return respond(MERGE_STATE)
      if (url.endsWith('/health')) return respond({ bootProject: 'p1' })
      return respond({ available: true, comments: [] })
    })
    setApiScope('p1')
    try {
      const client = createQueryClient()
      const view = render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <GithubItemDetail item={PR_42} colors={{}} backLink={null} subNav={null} />
          </MemoryRouter>
        </QueryClientProvider>,
      )
      await waitFor(() => expect(document.querySelector('[data-slot="gh-merge-box"]')?.textContent).toContain('Ready to merge'))
      fireEvent.click(within(document.querySelector('[data-slot="gh-merge-box"]') as HTMLElement).getByRole('button', { name: 'Refresh' }))
      await waitFor(() => expect(releaseRefresh).toBeDefined())
      view.unmount()
      setApiScope('p2')
      releaseRefresh!()
      await waitFor(() => expect(client.getQueryData(['p1', 'github', 'merge-state', 42])).toEqual(refreshed))
      expect(client.getQueryData(['p2', 'github', 'merge-state', 42])).toBeUndefined()
    } finally {
      setApiScope(null)
    }
  })
})

describe('PR changes cache scope (#734)', () => {
  const changesFor = (path: string, headSha: string) => ({
    available: true, number: 42, headSha, additions: 1, deletions: 0, truncated: false,
    files: [{ path, status: 'added', additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${path}` }],
  })
  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const A_HEAD = 'a'.repeat(40)
  const B_HEAD = 'b'.repeat(40)
  const renderChanges = (client = createQueryClient()) => render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GithubItemDetail item={PR_42} colors={{}} backLink={null} subNav={{ filter: null, changes: true }} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  it('keeps the same PR number in two projects as two cache entries', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/p/p1/') && url.includes('/changes')) return respond(changesFor('only-in-p1.ts', A_HEAD))
      if (url.includes('/p/p2/') && url.includes('/changes')) return respond(changesFor('only-in-p2.ts', B_HEAD))
      if (url.includes('/merge-state')) return respond(MERGE_STATE)
      return respond({ available: true, comments: [] })
    })
    const client = createQueryClient()
    setApiScope('p1')
    try {
      const first = renderChanges(client)
      await waitFor(() => expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).toContain('only-in-p1.ts'))
      first.unmount()
      setApiScope('p2')
      renderChanges(client)
      await waitFor(() => expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).toContain('only-in-p2.ts'))
      expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).not.toContain('only-in-p1.ts')
    } finally {
      setApiScope(null)
    }
  })

  it('files a Refresh under the project it was pressed in, after a project switch', async () => {
    let releaseRefresh: (() => void) | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/p/p1/') && url.includes('/changes?refresh=1')) {
        await new Promise<void>((resolve) => { releaseRefresh = resolve })
        return respond(changesFor('late-from-p1.ts', A_HEAD))
      }
      if (url.includes('/p/p1/') && url.includes('/changes')) return respond(changesFor('old-p1.ts', A_HEAD.replace(/a/g, 'c')))
      if (url.includes('/p/p2/') && url.includes('/changes')) return respond(changesFor('diff-of-p2.ts', B_HEAD))
      if (url.includes('/merge-state')) return respond(MERGE_STATE)
      return respond({ available: true, comments: [] })
    })
    const client = createQueryClient()
    setApiScope('p1')
    try {
      const first = renderChanges(client)
      await waitFor(() => expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).toContain('old-p1.ts'))
      fireEvent.click(within(document.querySelector('[data-slot="gh-pr-changes"]') as HTMLElement).getByRole('button', { name: 'Refresh' }))
      await waitFor(() => expect(releaseRefresh).toBeDefined())
      first.unmount()
      setApiScope('p2')
      renderChanges(client)
      await waitFor(() => expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).toContain('diff-of-p2.ts'))
      releaseRefresh!()
      await waitFor(() => expect(JSON.stringify(client.getQueryData(['p1', 'github', 'pr-changes', 42]))).toContain('late-from-p1.ts'))
      expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).toContain('diff-of-p2.ts')
      expect(document.querySelector('[data-slot="gh-pr-changes"]')?.textContent).not.toContain('late-from-p1.ts')
    } finally {
      setApiScope(null)
    }
  })
})
