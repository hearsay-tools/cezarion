import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
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

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/merge-state') ? MERGE_STATE : { available: true, comments: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderDetail(item: GithubItem) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/p1/tasks/r1/pr/42']}>
        <GithubItemDetail item={item} colors={{}} backLink={null} subNav={null} />
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
    expect(link?.getAttribute('href')).toMatch(/\/github\/prs\/42\/changes$/)
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
})
