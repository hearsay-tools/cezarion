import { githubItemSchema } from '@open-mercato/cezar-api-client/contract/github'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { GithubCommentsData, GithubItem, GithubPrChangesData, GithubPrMergeState, GithubPrMergeStateResponse, GithubTimelineEvent } from '@open-mercato/cezar-api-client'

import { GithubItemDetail } from './github-item-detail'

const PR_42: GithubItem = {
  kind: githubItemSchema.shape.kind.enum.pr,
  number: 42,
  title: 'Share the GitHub item detail',
  author: 'grace',
  createdAt: '2026-09-30T08:00:00.000Z',
  labels: [],
  body: 'Moves the detail pane.',
  url: 'https://github.com/acme/demo/pull/42',
  comments: 0,
}

const MERGE_STATE: Extract<GithubPrMergeStateResponse, { available: true }> = {
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

const CONFLICTING_STATE: typeof MERGE_STATE = {
  ...MERGE_STATE,
  mergeState: { ...MERGE_STATE.mergeState, mergeable: 'conflicting', eligibility: 'blocked', canMerge: false },
}

let mergeState: GithubPrMergeStateResponse = MERGE_STATE

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
  resetToasts()
  vi.unstubAllGlobals()
})

function renderDetail(item: GithubItem, onRunAgent?: () => void, props: Partial<Parameters<typeof GithubItemDetail>[0]> = {}) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/p1/tasks/r1/pr/42']}>
        <GithubItemDetail item={item} colors={{}} backLink={null} subNav={null} onRunAgent={onRunAgent} {...props} />
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

  it('shows confirmed optional reviews as passing and enables normal merging', async () => {
    mergeState = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, reviewDecision: 'not-required', checks: [{ name: 'test', state: 'passing', required: true }] } }
    renderDetail(PR_42)
    const label = await screen.findByText('Reviews: not required')
    expect(label.closest('li')?.querySelector('[data-slot="gh-merge-status-passing"]')).not.toBeNull()
    expect(screen.getByText('test · passing · required')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Squash and merge' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('Merge without waiting for requirements')).toBeNull()
  })

  it.each(['approved', 'changes-requested', 'review-required', 'unknown'] as const)(
    'preserves the %s review label and merge controls', async (reviewDecision) => {
      const ready = reviewDecision === 'approved'
      mergeState = { ...MERGE_STATE, mergeState: {
        ...MERGE_STATE.mergeState, reviewDecision, canMerge: ready, canOverride: !ready,
        eligibility: ready ? 'ready' : reviewDecision === 'unknown' ? 'unknown' : 'blocked',
      } }
      renderDetail(PR_42)
      await screen.findByText(`Reviews: ${reviewDecision.replaceAll('-', ' ')}`)
      expect(screen.getByRole('button', { name: 'Squash and merge' }).hasAttribute('disabled')).toBe(!ready)
    },
  )

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

describe('detail metadata and discussion fallbacks', () => {
  const stubThread = (thread: GithubCommentsData) => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes('/merge-state') ? MERGE_STATE : thread,
    )))
  }

  it('uses an empty hydrated body and zero diff counts instead of stale list values', async () => {
    stubThread({ available: true, comments: [], detail: { body: '', additions: 0, deletions: 0 } })
    renderDetail({ ...PR_42, additions: 50, deletions: 20 })
    await screen.findByText('(no description)')
    expect(screen.queryByText(PR_42.body!)).toBeNull()
    expect(document.querySelector('[data-slot="gh-diffstat"]')).toBeNull()
  })

  it.each([
    ['pr', 6, undefined, '+6 −0'], ['pr', undefined, 4, '+0 −4'], ['issue', 6, 4, null],
  ] as const)('renders %s diff counts %s/%s with zero for the absent side', (kind, additions, deletions, expected) => {
    renderDetail({ ...PR_42, kind, ...(additions === undefined ? {} : { additions }), ...(deletions === undefined ? {} : { deletions }) })
    expect(document.querySelector('[data-slot="gh-diffstat"]')?.textContent ?? null).toBe(expected)
  })

  it.each([[0, null], [2, '2 comments'], [undefined, '5 comments']] as const)(
    'uses resolved comment count %s over the list count', (comments, label) => {
      renderDetail({ ...PR_42, comments: 5 }, undefined, { comments })
      expect(document.querySelector('[data-slot="gh-comment-count"]')?.getAttribute('aria-label') ?? null).toBe(label)
    },
  )

  it('replaces a broken avatar with its first letter and uses a question mark for an empty login', async () => {
    const comment = { id: 1, author: 'grace', avatarUrl: 'https://avatars.example/grace', body: '',
      kind: 'comment' as const, createdAt: PR_42.createdAt, url: `${PR_42.url}#comment-1` }
    stubThread({ available: true, comments: [comment, { ...comment, id: 2, author: '', avatarUrl: '' }] })
    renderDetail(PR_42)
    await screen.findByText('Activity · 2 comments')
    const entries = document.querySelectorAll('[data-slot="gh-thread-entry"]')
    const image = entries[0]!.querySelector('img')!
    expect(image.getAttribute('src')).toBe(comment.avatarUrl)
    fireEvent.error(image)
    expect(entries[0]!.querySelector('img')).toBeNull()
    expect(entries[0]!.querySelector('[data-slot="gh-avatar-fallback"]')?.textContent).toBe('g')
    expect(entries[1]!.querySelector('[data-slot="gh-avatar-fallback"]')?.textContent).toBe('?')
    expect(screen.getAllByText('(no body)')).toHaveLength(2)
  })

  it.each(['approved', 'commented', 'dismissed'] as const)('renders the %s review state beside its body', async (reviewState) => {
    stubThread({ available: true, comments: [{ id: 1, author: 'grace', body: 'Reviewed the change.',
      kind: 'review', reviewState, createdAt: PR_42.createdAt, url: `${PR_42.url}#review-1` }] })
    renderDetail(PR_42)
    const chip = await screen.findByText(reviewState)
    expect(chip.getAttribute('data-review-state')).toBe(reviewState)
    expect(screen.getByText('Reviewed the change.')).toBeTruthy()
  })

  it.each([
    ['assigned', 'assigned someone'], ['unassigned', 'unassigned someone'],
    ['renamed', 'renamed this to —'], ['cross-referenced', 'referenced this in another thread'],
    ['unlabeled', 'removed the'], ['reopened', 'reopened this'],
  ] satisfies [GithubTimelineEvent['kind'], string][])(
    'renders a %s event when optional details are absent', async (kind, phrase) => {
      stubThread({ available: true, comments: [], events: [{ id: kind, kind, actor: 'grace', createdAt: PR_42.createdAt }] })
      renderDetail(PR_42)
      await screen.findByText('Activity · 0 comments')
      const row = document.querySelector('[data-slot="gh-event-row"]') as HTMLElement
      expect(row.textContent).toContain(phrase)
      expect(within(row).queryByRole('link')).toBeNull()
      expect(row.querySelector('[data-slot="gh-event-label"]')).toBeNull()
    },
  )

  it('collapses an expanded two-commit group without losing the summary', async () => {
    stubThread({ available: true, comments: [], events: [1, 2].map((n) => ({
      id: `commit-${n}`, kind: 'committed', actor: 'grace', createdAt: PR_42.createdAt,
      message: `Change ${n}`, sha: `${n}`.repeat(40),
    })) })
    renderDetail(PR_42)
    const summary = await screen.findByRole('button', { name: /added 2 commits/ })
    fireEvent.click(summary)
    expect(screen.getByText('Change 1')).toBeTruthy()
    expect(screen.getByText('Change 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /added 2 commits/ }))
    expect(screen.getByRole('button', { name: /added 2 commits/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Change 1')).toBeNull()
    expect(screen.queryByText('Change 2')).toBeNull()
  })
})

describe('merge requirements in the detail', () => {
  it.each([
    ['merged', { state: 'merged', eligibility: 'terminal', canMerge: false }, 'Merged'],
    ['closed', { state: 'closed', eligibility: 'terminal', canMerge: false }, 'Closed'],
    ['draft', { isDraft: true, canMerge: false }, 'Draft'],
    ['conflicting', { mergeable: 'conflicting', canMerge: false }, 'Conflicts must be resolved'],
    ['blocked', { eligibility: 'blocked', canMerge: false }, 'Merge blocked'],
  ] satisfies [string, Partial<GithubPrMergeState>, string][])(
    'shows the %s heading', async (_name, patch: Partial<GithubPrMergeState>, title) => {
      mergeState = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, ...patch } }
      renderDetail(PR_42)
      await screen.findByRole('heading', { name: title })
      const method = screen.queryByRole('combobox', { name: 'Merge method' })
      expect(Boolean(method)).toBe(patch.state === undefined)
    },
  )

  it.each([
    ['mergeable', 'none', 'passing', null],
    ['conflicting', 'present', 'failing', 'true'],
    ['unknown', 'unknown', 'unknown', null],
  ] as const)('shows %s conflict status', async (mergeable, label, icon, attribute) => {
    mergeState = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, mergeable } }
    renderDetail(PR_42)
    const row = (await screen.findByText(`Conflicts: ${label}`)).closest('li')!
    expect(row.querySelector(`[data-slot="gh-merge-status-${icon}"]`)).not.toBeNull()
    expect(document.querySelector('[data-slot="gh-merge-box"]')?.getAttribute('data-conflicting')).toBe(attribute)
  })

  it('shows unknown reviews, requirement warning and blockers without claiming readiness', async () => {
    mergeState = { ...MERGE_STATE, mergeState: {
      ...MERGE_STATE.mergeState, reviewDecision: 'unknown', eligibility: 'unknown', canMerge: false,
      blockers: [{ code: 'reviews', message: 'Review requirements could not be read.' }],
    } }
    renderDetail(PR_42)
    await screen.findByRole('heading', { name: 'Merge blocked · Requirements unknown' })
    expect(screen.getByText('Reviews: unknown').closest('li')?.querySelector('[data-slot="gh-merge-status-unknown"]')).not.toBeNull()
    expect(screen.getByText(/Passing checks do not establish merge readiness/)).toBeTruthy()
    expect(screen.getByText('Review requirements could not be read.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Squash and merge' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows an empty check list and the abbreviated branch head', async () => {
    renderDetail(PR_42, vi.fn())
    await screen.findByText('No checks configured')
    expect(screen.getByText('feat/share (0123456) → main')).toBeTruthy()
    expect(screen.queryByText(/Passing checks do not establish merge readiness/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Run agent on this PR' })).toBeNull()
  })

  it('keeps requiredness and safe details links on their own check rows', async () => {
    mergeState = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, checks: [
      { name: 'unit', state: 'passing', required: true, url: 'https://checks.example/unit' },
      { name: 'optional', state: 'failing', required: false, url: 'javascript:void(0)' },
      { name: 'queued', state: 'pending', required: null },
      { name: 'unreported', state: 'unknown', required: false, url: '' },
    ] } }
    renderDetail(PR_42)
    const unit = (await screen.findByText('unit · passing · required')).closest('li')!
    const link = within(unit).getByRole('link', { name: 'details' })
    expect(link.getAttribute('href')).toBe('https://checks.example/unit')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    for (const [label, status] of [
      ['optional · failing', 'failing'], ['queued · pending · requiredness unknown', 'pending'],
      ['unreported · unknown', 'unknown'],
    ]) {
      const row = screen.getByText(label!).closest('li')!
      expect(row.querySelector(`[data-slot="gh-merge-status-${status}"]`)).not.toBeNull()
      expect(within(row).queryByRole('link')).toBeNull()
    }
  })

  it('shows the unavailable reason instead of merge controls', async () => {
    mergeState = { available: false, reason: 'GitHub is not installed.' }
    renderDetail(PR_42)
    await screen.findByText('Merge status unavailable')
    expect(screen.getByText('GitHub is not installed.')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Merge method' })).toBeNull()
  })
})

describe('merge method selection', () => {
  it.each([
    [null, 'Rebase and merge'], ['merge', 'Create a merge commit'],
  ] as const)('uses default %s or the first allowed method', async (defaultMethod, label) => {
    mergeState = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, methods: ['rebase', 'merge'], defaultMethod } }
    renderDetail(PR_42)
    await screen.findByRole('button', { name: label })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Rebase and merge', 'Create a merge commit'])
  })

  it('uses the selected method, cancels confirmation and drops a method removed on refresh', async () => {
    mergeState = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, methods: ['squash', 'rebase'] } }
    renderDetail(PR_42)
    const select = await screen.findByRole('combobox', { name: 'Merge method' })
    fireEvent.change(select, { target: { value: 'rebase' } })
    expect((select as HTMLSelectElement).value).toBe('rebase')
    fireEvent.click(screen.getByRole('button', { name: 'Rebase and merge' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: /Rebase and merge pull request/ })).toBeTruthy()
    expect(within(dialog).queryByText(/bypass unmet repository requirements/)).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    mergeState = MERGE_STATE
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByRole('button', { name: 'Squash and merge' })
    expect((select as HTMLSelectElement).value).toBe('squash')
  })

  it('offers no merge action when no method is allowed', async () => {
    mergeState = { ...MERGE_STATE, mergeState: { ...MERGE_STATE.mergeState, methods: [], defaultMethod: null } }
    renderDetail(PR_42)
    await screen.findByRole('heading', { name: 'Ready to merge' })
    expect(screen.queryByRole('combobox', { name: 'Merge method' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Squash and merge' })).toBeNull()
  })

  it('keeps the loading state until requirements arrive', async () => {
    let answer!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { answer = resolve })
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => String(input).includes('/merge-state')
      ? pending
      : Promise.resolve(new Response(JSON.stringify({ available: true, comments: [] }))))
    renderDetail(PR_42)
    expect(document.querySelector('[data-slot="gh-merge-loading"]')).not.toBeNull()
    expect(screen.queryByText('Merge status unavailable')).toBeNull()
    answer(new Response(JSON.stringify(MERGE_STATE)))
    await screen.findByRole('heading', { name: 'Ready to merge' })
    expect(document.querySelector('[data-slot="gh-merge-loading"]')).toBeNull()
  })

  it('shows the fallback reason when the requirements request fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('Offline')))
    renderDetail(PR_42)
    await screen.findByText('GitHub could not load merge requirements.')
    expect(screen.getByText('Merge status unavailable')).toBeTruthy()
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

  it('closes confirmation after a successful merge', async () => {
    stubMergeFlow()
    renderDetail(PR_42)
    await merge()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('locks confirmation during the request and keeps a failed merge available to retry', async () => {
    let answer!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { answer = resolve })
    let stateReads = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      if (url.endsWith('/merge') && init.method === 'POST') return pending
      if (url.includes('/merge-state')) stateReads++
      return Promise.resolve(new Response(JSON.stringify(url.includes('/merge-state') ? MERGE_STATE : { available: true, comments: [] })))
    })
    renderDetail(PR_42)
    await merge()
    const dialog = await screen.findByRole('dialog')
    expect((await within(dialog).findByRole('button', { name: 'Merging…' })).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    answer(new Response(JSON.stringify({ error: 'Head changed; refresh before merging.' }), { status: 409 }))
    await within(dialog).findByText('Head changed; refresh before merging.')
    expect(within(dialog).getByRole('button', { name: 'Squash and merge' }).hasAttribute('disabled')).toBe(false)
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false)
    await waitFor(() => expect(stateReads).toBe(2))
  })

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
            {/* #922: the chip carries the PR URL, so its scope guard needs the project's repo base
             *  to prove #42 is the project's own PR before it reads the local status batch. */}
            <ReferenceStatusProvider projectId="p1" repoBase="https://github.com/acme/demo" requests={[{ projectId: 'p1', kind: 'PR', number: 42 }]}>
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
      // The paged list (hearsay-tools/cezarion#1183) drops the merged PR on its next read.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['p1', 'github', 'pages', 50] })
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

describe('PR changed files', () => {
  const changesFor = (path: string, headSha: string): Extract<GithubPrChangesData, { available: true }> => ({
    available: true, number: 42, headSha, additions: 1, deletions: 0, truncated: false,
    files: [{ path, status: 'added', additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${path}` }],
  })
  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const A_HEAD = 'a'.repeat(40)
  const B_HEAD = 'b'.repeat(40)
  const renderChanges = (client = createQueryClient(), item = PR_42) => render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GithubItemDetail item={item} colors={{}} backLink={null} subNav={{ filter: null, changes: true }} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const seedChanges = (data: GithubPrChangesData) => {
    const client = createQueryClient()
    client.setQueryData(queryKeys.githubPrChanges(42), data)
    return client
  }
  const threeFiles = () => ({
    ...changesFor('src/Alpha.ts', A_HEAD),
    files: [
      changesFor('src/Alpha.ts', A_HEAD).files[0]!,
      changesFor('src/beta.ts', A_HEAD).files[0]!,
      changesFor('docs/guide.md', A_HEAD).files[0]!,
    ],
  })
  const selectedFile = () => {
    return (screen.getByRole('combobox', { name: 'Select changed file' }) as HTMLSelectElement).value
  }
  const shownPath = () => document.querySelector('[data-slot="diff-file"]')?.getAttribute('data-path')

  it('selects files with both navigation buttons, the list and the phone selector', async () => {
    renderChanges(seedChanges(threeFiles()))
    await waitFor(() => expect(shownPath()).toBe('src/Alpha.ts'))
    expect(screen.getByRole('button', { name: 'Previous file' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Next file' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Next file' }))
    await waitFor(() => expect(shownPath()).toBe('src/beta.ts'))
    expect(selectedFile()).toBe('src/beta.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Next file' }))
    await waitFor(() => expect(shownPath()).toBe('docs/guide.md'))
    expect(screen.getByRole('button', { name: 'Next file' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous file' }))
    await waitFor(() => expect(shownPath()).toBe('src/beta.ts'))
    fireEvent.click(screen.getByRole('button', { name: /added · src\/Alpha.ts/ }))
    await waitFor(() => expect(shownPath()).toBe('src/Alpha.ts'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Select changed file' }), { target: { value: 'docs/guide.md' } })
    await waitFor(() => expect(shownPath()).toBe('docs/guide.md'))
    expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(1)
  })

  it('filters paths without case sensitivity and keeps a selection only while it matches', async () => {
    renderChanges(seedChanges(threeFiles()))
    await waitFor(() => expect(shownPath()).toBe('src/Alpha.ts'))
    const filter = screen.getByRole('textbox', { name: 'Filter changed files' })
    fireEvent.change(filter, { target: { value: 'SRC/' } })
    expect(selectedFile()).toBe('src/Alpha.ts')
    const selector = screen.getByRole('combobox', { name: 'Select changed file' })
    expect(within(selector).getAllByRole('option').map((option) => option.textContent)).toEqual(['src/Alpha.ts', 'src/beta.ts'])
    fireEvent.change(filter, { target: { value: 'BETA' } })
    await waitFor(() => expect(shownPath()).toBe('src/beta.ts'))
    expect(screen.getByRole('button', { name: 'Previous file' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Next file' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(filter, { target: { value: 'no-such-file' } })
    expect(screen.getByText('No changed files match this filter.')).toBeTruthy()
    expect(document.querySelector('[data-slot="diff-file"]')).toBeNull()
    expect(within(selector).queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Next file' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(filter, { target: { value: '' } })
    await waitFor(() => expect(shownPath()).toBe('src/beta.ts'))
  })

  it.each([
    ['binary', 'binary'], ['too-large', 'too-large'], [undefined, 'not-provided'],
  ] as const)('explains a missing %s patch and keeps the renamed path and statistics', async (reason, label) => {
    const data: GithubPrChangesData = {
      ...changesFor('new.dat', A_HEAD), additions: 7, deletions: 3,
      files: [{ path: 'new.dat', previousPath: 'old.dat', status: 'renamed', additions: 7, deletions: 3,
        ...(reason ? { patchUnavailableReason: reason } : {}) }],
    }
    renderChanges(seedChanges(data))
    expect(await screen.findByText(`Patch unavailable: ${label}.`)).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-slot="diff-file"]')?.textContent).toContain('old.dat'))
    expect(screen.getByText(`head ${A_HEAD.slice(0, 8)}`).getAttribute('title')).toBe(A_HEAD)
    const diff = document.querySelector('[data-slot="diff-file"]') as HTMLElement
    expect(within(diff).getByText('+7')).toBeTruthy()
    expect(within(diff).getByText('−3')).toBeTruthy()
    expect(Boolean(within(diff).queryByText('Binary file — no text diff.'))).toBe(reason === 'binary')
  })

  it.each([
    [PR_42.url, undefined, true], ['javascript:void(0)', 'The file limit was reached.', false],
  ] as const)('explains truncated changes for %s with only a safe GitHub fallback', (url, reason, linked) => {
    renderChanges(seedChanges({ ...changesFor('a.ts', A_HEAD), truncated: true, ...(reason ? { reason } : {}) }), { ...PR_42, url })
    const status = screen.getByRole('status')
    expect(status.textContent).toContain(reason ?? 'This response is incomplete.')
    const link = within(status).queryByRole('link', { name: 'Open all files on GitHub' })
    expect(Boolean(link)).toBe(linked)
    if (link) {
      expect(link.getAttribute('href')).toBe(`${PR_42.url}/files`)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('keeps the selected file on a same-head refresh and resets it when the head changes', async () => {
    const client = seedChanges(threeFiles())
    let next = threeFiles()
    const refreshUrls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/changes')) { refreshUrls.push(url); return respond(next) }
      return respond(MERGE_STATE)
    })
    renderChanges(client)
    await waitFor(() => expect(shownPath()).toBe('src/Alpha.ts'))
    fireEvent.click(screen.getByRole('button', { name: 'Next file' }))
    await waitFor(() => expect(shownPath()).toBe('src/beta.ts'))
    const refresh = within(document.querySelector('[data-slot="gh-pr-changes"]') as HTMLElement).getByRole('button', { name: 'Refresh' })
    fireEvent.click(refresh)
    await waitFor(() => expect(refreshUrls).toHaveLength(1))
    await waitFor(() => expect(client.getQueryData(queryKeys.githubPrChanges(42))).toEqual(next))
    expect(selectedFile()).toBe('src/beta.ts')
    expect(screen.queryByText('The reviewed revision changed.')).toBeNull()
    next = { ...threeFiles(), headSha: B_HEAD }
    fireEvent.click(refresh)
    await screen.findByText('The reviewed revision changed.')
    await waitFor(() => expect(shownPath()).toBe('src/Alpha.ts'))
    expect(refreshUrls.every((url) => url.endsWith('/prs/42/changes?refresh=1'))).toBe(true)
  })

  it('shows an unavailable reason and a failed request instead of an empty diff', async () => {
    const first = renderChanges(seedChanges({ available: false, reason: 'The repository is offline.' }))
    expect(screen.getByText('The repository is offline.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Filter changed files' })).toBeNull()
    first.unmount()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input).includes('/changes')
      ? new Response(JSON.stringify({ error: 'Offline' }), { status: 503 }) : respond(MERGE_STATE))
    renderChanges()
    expect(screen.getByText('Loading changed files…').getAttribute('aria-live')).toBe('polite')
    await screen.findByText('Changed files could not be loaded.')
    expect(screen.queryByText('No changed files match this filter.')).toBeNull()
  })

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
