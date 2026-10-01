import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import type { GithubItem } from '@open-mercato/cezar-api-client'

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
})
