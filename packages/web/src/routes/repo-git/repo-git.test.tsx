import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { ChangesPayload, GithubData, HealthResponse, RepoBranchEntry, RepoBranchesResponse, RepoCommitPayload, RepoResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RepoGitRoute } from './repo-git'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  status: [],
  log: [
    { hash: 'abc1234', subject: 'feat: add the thing', author: 'Ada', when: '2 hours ago', at: '2026-09-30T10:00:00', source: { runId: 'run-698', title: 'Picker pill prefixes', prNumber: 698 } },
    { hash: 'def5678', subject: 'fix: stop the bug', author: 'Linus', when: '3 days ago', at: '2026-09-27T12:00:00' },
  ],
  branches: ['feature', 'main'],
  baseBranch: null,
  tracking: null,
}

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, preview: false },
}

const CHANGES: ChangesPayload = {
  files: [
    {
      path: 'notes.md',
      status: 'added',
      adds: 2,
      dels: 0,
      binary: false,
      patch: 'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    },
    {
      path: 'src/util/a.ts',
      status: 'modified',
      adds: 3,
      dels: 1,
      binary: false,
      patch:
        'diff --git a/src/util/a.ts b/src/util/a.ts\n--- a/src/util/a.ts\n+++ b/src/util/a.ts\n@@ -1,2 +1,4 @@\n context\n-gone\n+one\n+two\n+three\n',
    },
  ],
  stat: { adds: 5, dels: 1, files: 2 },
}

const COMMIT: RepoCommitPayload = {
  sha: 'abc1234def5678abc1234def5678abc1234def56',
  subject: 'feat: add the thing',
  author: 'Ada',
  when: '2 hours ago',
  files: [CHANGES.files[0]!],
  stat: { adds: 2, dels: 0, files: 1 },
}

const GITHUB: GithubData = {
  available: true,
  repo: 'acme/demo',
  issues: [],
  prs: [
    {
      kind: 'pr',
      number: 7,
      title: 'Improve everything',
      author: 'ada',
      createdAt: '2026-07-15T08:00:00.000Z',
      labels: [],
      body: '',
      url: 'https://github.com/acme/demo/pull/7',
      comments: 0,
      checks: 'passing',
    },
  ],
}

function branch(partial: Partial<RepoBranchEntry> & Pick<RepoBranchEntry, 'name' | 'class'>): RepoBranchEntry {
  return {
    runId: null,
    title: null,
    runStatus: null,
    ahead: 0,
    lastCommit: { sha: 'f00dfeed1234', subject: 'last commit', at: '2026-09-27T12:00:00Z' },
    diffStat: null,
    pr: null,
    ...partial,
  }
}

const BRANCHES: RepoBranchesResponse = {
  base: 'main',
  prStateKnown: true,
  branches: [
    branch({ name: 'main', class: 'active' }),
    branch({ name: 'feature', class: 'other' }),
    branch({ name: 'cez/51ab2d7e', class: 'not-landed', runId: 'run-51', title: 'Retention sweep for archived runs', runStatus: 'done', ahead: 4, diffStat: { additions: 212, deletions: 40 } }),
    branch({ name: 'cez/7c1e09aa', class: 'not-landed', runId: 'run-7c', title: 'Webhook retries on 5xx', runStatus: 'done', ahead: 2, diffStat: { additions: 88, deletions: 12 }, pr: { number: 705, url: 'https://github.com/acme/demo/pull/705', state: 'open' } }),
    branch({ name: 'cez/9d04c1f2', class: 'orphan', ahead: 3, diffStat: { additions: 140, deletions: 22 }, lastCommit: { sha: '9d04c1f2abcd', subject: 'feat(git): worktree sizes in the panel', at: '2026-09-25T12:00:00Z' } }),
    branch({ name: 'cez/aaaaaaaa', class: 'merged', runId: 'run-aa', title: 'Merged one', pr: { number: 690, url: 'https://github.com/acme/demo/pull/690', state: 'merged' } }),
    branch({ name: 'cez/bbbbbbbb', class: 'merged' }),
    branch({ name: 'cez/cccccccc', class: 'empty', runId: 'run-cc', title: 'Never committed' }),
  ],
  counts: { notLanded: 3, cleanup: 3 },
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (task-changes.test.tsx): records requests, serves the repo
 *  fixtures, and lets a test override specific `METHOD path` keys. */
function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).replace('?archived=recent', '')
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(REPO)
      if (method === 'GET' && path === '/api/v1/repo/branches') return jsonResponse(BRANCHES)
      if (method === 'GET' && path === '/api/v1/run-summaries') return jsonResponse([])
      if (method === 'GET' && path === '/api/v1/repo/pull') return jsonResponse({ branches: ['feature', 'main'] })
      if (method === 'GET' && path === '/api/v1/repo/changes') return jsonResponse(CHANGES)
      if (method === 'GET' && path === '/api/v1/repo/commit/abc1234?structured=1') return jsonResponse(COMMIT)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/github?limit=20') return jsonResponse(GITHUB)
      return jsonResponse({})
    }),
  )
  return sent
}

/** Cold-load the repo view at a URL, with the same route map routes.tsx registers. */
function renderAt(entry: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/git" element={<RepoGitRoute section="main" index />} />
          <Route path="/git/commits" element={<RepoGitRoute section="main" />} />
          <Route path="/git/commits/:sha" element={<RepoGitRoute section="main" />} />
          <Route path="/git/not-landed" element={<RepoGitRoute section="not-landed" />} />
          <Route path="/git/cleanup" element={<RepoGitRoute section="cleanup" />} />
          <Route path="/git/branches" element={<RepoGitRoute section="branches" />} />
          <Route path="/git/changes" element={<RepoGitRoute section="changes" />} />
          <Route path="/tasks/:id" element={<p data-testid="task-page">task</p>} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

// ---- changes ----------------------------------------------------------------------------------

describe('the Git view Uncommitted changes section (/git/changes)', () => {
  it('renders a title-and-meta header with no section tabs, and the working-tree diff from /api/v1/repo/changes', async () => {
    stubFetch({ 'GET /api/v1/repo': () => jsonResponse({ ...REPO, status: [{ status: 'M', path: 'notes.md' }, { status: 'M', path: 'src/util/a.ts' }] }) })
    renderAt('/git/changes')

    await waitFor(() => expect(document.querySelector('[data-slot="repo-header"]')).not.toBeNull())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Uncommitted changes')
    expect(document.querySelector('[data-slot="repo-meta"]')?.textContent).toBe('2 uncommitted files in the main checkout')
    // Issue 06 §3: the sections live in the sidebar; the main header has no Changes/Commits/Branches tabs.
    expect(document.querySelector('[data-slot="repo-tabs"]')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Commits' })).toBeNull()

    // The SAME tree + facade the task Changes tab uses: compacted folder, per-file ±.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="tree-dir"]')?.textContent).toContain('src/util')
    // …including its own bounded scroller, so a long list never drags the diff down with it.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree-pane"]')).not.toBeNull())
    const pane = document.querySelector('[data-slot="changes-tree-pane"]') as HTMLElement
    expect(pane.className).toContain('max-h-[calc(100dvh_-_64px_-_var(--diff-sticky-top)_-_1rem)]')
    expect(pane.className).toContain('overflow-y-auto')
    expect(pane.className).toContain('overscroll-contain')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    expect(document.querySelector('[data-slot="changes-stat"]')?.textContent).toContain('+5')
    // The view toggles are the shared control, wired to the facade's mode.
    fireEvent.click(document.querySelector('[data-slot="diff-mode-toggle"] [data-mode="split"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('split'),
    )
  })

  it('a clean tree renders the honest empty state', async () => {
    stubFetch({
      'GET /api/v1/repo/changes': () => jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } }),
    })
    renderAt('/git/changes')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Working tree clean' })).toBeTruthy(),
    )
  })

  it('a 409 from /changes renders the server reason, not an error explosion', async () => {
    stubFetch({
      'GET /api/v1/repo/changes': () => jsonResponse({ error: 'not a git repository' }, 409),
    })
    renderAt('/git/changes')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No changes to show' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="repo-changes"]')?.textContent).toContain('not a git repository')
  })

  it('below md the diff forces unified even when the toggle says split', async () => {
    // A non-desktop matchMedia: the forced-mobile rule must win over the local toggle state.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    stubFetch()
    renderAt('/git/changes')
    await waitFor(() => expect(document.querySelector('[data-slot="diff"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="diff-mode-toggle"] [data-mode="split"]')!)
    // Still unified: phones render one readable column, wrap on.
    expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('unified')
  })

  it('outside a git repository the whole view degrades honestly', async () => {
    stubFetch({
      'GET /api/v1/repo': () =>
        jsonResponse({ info: null, status: [], log: [], branches: [], baseBranch: null, tracking: null }),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Not a git repository' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="repo-tabs"]')).toBeNull()
  })
})

// ---- commits ----------------------------------------------------------------------------------

describe('the Git view Recently on main section', () => {
  it.each(['/git', '/git/commits'])('%s is Recently on the checked-out branch, titled with a meta line and no tabs', async (entry) => {
    stubFetch()
    renderAt(entry)
    await waitFor(() => expect(document.querySelector('[data-slot="repo-commits"]')).not.toBeNull())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Recently on main')
    expect(document.querySelector('[data-slot="repo-meta"]')?.textContent).toBe('latest 2 commits in the main checkout')
    expect(document.querySelector('[data-slot="repo-tabs"]')).toBeNull()
  })

  it('groups the log by the commit’s own day, each 52px row reading subject then sha · author · age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T12:00:00'))
    try {
      stubFetch()
      renderAt('/git')
      await waitFor(() => expect(document.querySelectorAll('[data-slot="repo-commit-day"]')).toHaveLength(2))
      const days = [...document.querySelectorAll('[data-slot="repo-commit-day"]')].map((day) => ({
        label: day.querySelector('h2')?.textContent,
        shas: [...day.querySelectorAll('[data-slot="commit-row"]')].map((row) => row.getAttribute('data-sha')),
      }))
      expect(days).toEqual([
        { label: 'Today', shas: ['abc1234'] },
        { label: 'Sun, Sep 27', shas: ['def5678'] },
      ])
    } finally {
      vi.useRealTimers()
    }
    const row = document.querySelector('[data-slot="commit-row"][data-sha="def5678"]')!
    expect(row.className).toContain('min-h-[52px]')
    expect(row.querySelector('[data-slot="commit-row-subject"]')?.textContent).toBe('fix: stop the bug')
    expect(row.querySelector('[data-slot="commit-row-meta"]')?.textContent).toBe('def5678· Linus · 3d')
    // `commit-meta` is the opened commit's header; a list row must not answer to it, or a wait for
    // the commit view passes on the list it is leaving (repo-git.e2e.ts, 2026-09-30 local run).
    expect(document.querySelector('[data-slot="commit-meta"]')).toBeNull()
  })

  it('names the task and PR a commit came from, linking to the task, and "no task found" otherwise', async () => {
    stubFetch()
    renderAt('/git')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="commit-source"]')).toHaveLength(2))
    const [fromTask, unknown] = [...document.querySelectorAll<HTMLElement>('[data-slot="commit-source"]')]
    expect(fromTask?.getAttribute('href')).toBe('/tasks/run-698')
    expect(fromTask?.textContent).toBe('PR #698Picker pill prefixes')
    // Unmatched is not hand-made: a cherry-picked task commit is unmatched too.
    expect(unknown?.tagName).toBe('SPAN')
    expect(unknown?.dataset.source).toBe('unknown')
    expect(unknown?.textContent).toBe('no task found')
    // The source is a sibling of the commit link, never nested inside it.
    expect(document.querySelector('[data-slot="commit-row"] a')).toBeNull()
  })

  it('offers an Incoming bar with Pull when the base is behind its upstream, and none when it is not', async () => {
    const sent = stubFetch({
      'GET /api/v1/repo': () => jsonResponse({ ...REPO, tracking: { ref: 'origin/main', ahead: 0, behind: 2, fetchedAt: null } }),
      'POST /api/v1/repo/pull': () => jsonResponse({ branch: 'main', pulled: true, summary: 'Fast-forwarded by 2 commits.' }),
    })
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-slot="git-incoming"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="git-incoming"]')?.textContent).toBe('2 commits on origin/main are not in your checkout yetPull')
    expect(document.querySelector('[data-slot="repo-meta"]')?.textContent).toBe('latest 2 commits in the main checkout · never fetched')
    fireEvent.click(document.querySelector('[data-action="repo-pull-incoming"]')!)
    await waitFor(() => expect(document.body.textContent).toContain('Fast-forwarded by 2 commits.'))
    expect(sent.find((request) => request.method === 'POST')).toMatchObject({ path: '/api/v1/repo/pull', body: { branch: 'main' } })

    cleanup()
    stubFetch()
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-commits"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="git-incoming"]')).toBeNull()
  })

  it('offers no Incoming bar when the configured base is not the checked-out branch', async () => {
    // Tracking describes `develop`, but Pull would update `main`, the checkout.
    stubFetch({
      'GET /api/v1/repo': () =>
        jsonResponse({ ...REPO, baseBranch: 'develop', tracking: { ref: 'origin/develop', ahead: 0, behind: 2, fetchedAt: null } }),
    })
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-commits"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="git-incoming"]')).toBeNull()
  })

  it('lists the recent commits from /api/v1/repo, each row deep-linking to its diff', async () => {
    stubFetch()
    renderAt('/git/commits')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-commits"]')).not.toBeNull())

    const rows = [...document.querySelectorAll('[data-slot="commit-row"]')].map((row) => ({
      href: row.getAttribute('href'),
      text: row.textContent,
    }))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.href).toBe('/git/commits/abc1234')
    expect(rows[0]?.text).toContain('abc1234')
    expect(rows[0]?.text).toContain('feat: add the thing')
    expect(rows[0]?.text).toContain('Ada')
    expect(rows[1]?.href).toBe('/git/commits/def5678')
  })

  it('clicking a commit routes to /git/commits/:sha and renders the structured diff', async () => {
    stubFetch()
    renderAt('/git/commits')
    await waitFor(() => expect(document.querySelector('[data-slot="commit-row"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="commit-row"][data-sha="abc1234"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="commit-meta"]')).not.toBeNull())

    // The commit's metadata and its full sha, from ?structured=1.
    const meta = document.querySelector('[data-slot="commit-meta"]')
    expect(meta?.textContent).toContain('feat: add the thing')
    expect(meta?.textContent).toContain('Ada')
    expect(meta?.textContent).toContain(COMMIT.sha)
    // The same <Diff> facade renders the commit's file.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="diff-file"][data-path="notes.md"]')).not.toBeNull(),
    )
    // And the way back is a link, not a dead end.
    // A commit opens inside Recently on main, and its way back is that section.
    expect(document.querySelector('[data-slot="commit-back"]')?.getAttribute('href')).toBe('/git')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Recently on main')
  })

  it('an unknown sha is a neutral "Commit not found" with the server reason', async () => {
    stubFetch({
      'GET /api/v1/repo/commit/nope999?structured=1': () =>
        jsonResponse({ error: 'unknown commit: nope999' }, 409),
    })
    renderAt('/git/commits/nope999')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Commit not found' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="repo-commit"]')?.textContent).toContain('unknown commit: nope999')
  })

  it('a merge commit (zero files) says so instead of faking a diff', async () => {
    stubFetch({
      'GET /api/v1/repo/commit/abc1234?structured=1': () =>
        jsonResponse({ ...COMMIT, files: [], stat: { adds: 0, dels: 0, files: 0 } }),
    })
    renderAt('/git/commits/abc1234')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No file changes' })).toBeTruthy(),
    )
  })
})

// ---- branches ----------------------------------------------------------------------------------

describe('the Git view All branches section', () => {
  it('lists branches with the checkout marked current and the rest switchable', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())

    const current = document.querySelector('[data-slot="branch-row"][data-branch="main"]')
    expect(current?.querySelector('[data-slot="branch-current"]')).not.toBeNull()
    expect(current?.querySelector('[data-action="switch-branch"]')).toBeNull()

    const other = document.querySelector('[data-slot="branch-row"][data-branch="feature"]')
    expect(other?.querySelector('[data-slot="branch-current"]')).toBeNull()
    expect(other?.querySelector('[data-action="switch-branch"]')).not.toBeNull()
  })

  it('lists every local branch, task branches included, labelled with its class and linked to its task', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="branch-class"]')).toHaveLength(8))
    expect(document.querySelector('[data-slot="repo-meta"]')?.textContent).toBe('8 branches · on main')
    const labels = [...document.querySelectorAll<HTMLElement>('[data-slot="branch-row"]')].map((row) => [
      row.dataset.branch,
      row.querySelector('[data-slot="branch-class"]')?.textContent,
    ])
    expect(labels).toEqual([
      ['cez/51ab2d7e', 'not landed'],
      ['cez/7c1e09aa', 'not landed'],
      ['cez/9d04c1f2', 'not landed'],
      ['cez/aaaaaaaa', 'merged'],
      ['cez/bbbbbbbb', 'merged'],
      ['cez/cccccccc', 'empty'],
      ['feature', 'yours'],
      ['main', 'in use'],
    ])
    // A task branch opens through its task, never through Switch.
    expect(document.querySelector('[data-branch="cez/51ab2d7e"] [data-action="switch-branch"]')).toBeNull()
    expect(document.querySelector('[data-branch="feature"] [data-action="switch-branch"]')).not.toBeNull()
    expect(document.querySelector('[data-branch="cez/51ab2d7e"] [data-slot="branch-task-link"]')?.getAttribute('href')).toBe('/tasks/run-51')
    expect(document.querySelector('[data-branch="feature"] [data-slot="branch-task-link"]')).toBeNull()
  })

  it('Switch POSTs /api/v1/repo/branch and toasts the outcome', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'feature', created: false }),
    })
    const client = renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-action="switch-branch"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-action="switch-branch"]')!)
    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/repo/branch')
      expect(post?.body).toEqual({ name: 'feature' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Switched to feature'))
    await waitFor(() => expect(document.querySelector('[data-slot="repo-meta"]')?.textContent).toBe('8 branches · on feature'))
    await waitFor(() => expect(client.getQueryData<HealthResponse>(queryKeys.health)?.repo?.branch).toBe('feature'))
  })

  it('filters branch rows, and leaves the base-branch picker to the checkout block', async () => {
    stubFetch()
    renderAt('/git/branches')
    const filter = await screen.findByLabelText('Filter branches')
    // Listed once, in the checkout block (issue 06 §3).
    expect(document.querySelector('[data-slot="base-branch-picker"]')).toBeNull()

    fireEvent.change(filter, { target: { value: 'FEAT' } })
    expect(document.querySelector('[data-slot="branch-row"][data-branch="feature"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="branch-row"][data-branch="main"]')).toBeNull()

    fireEvent.change(filter, { target: { value: 'missing' } })
    expect(document.querySelector('[data-slot="branch-empty"]')?.textContent).toContain(
      'No branches match “missing”.',
    )
  })

  it('a switch 409 surfaces git’s own reason as a danger toast', async () => {
    stubFetch({
      'POST /api/v1/repo/branch': () =>
        jsonResponse({ error: 'Your local changes to the following files would be overwritten by checkout' }, 409),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-action="switch-branch"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-action="switch-branch"]')!)
    await waitFor(() =>
      expect(document.body.textContent).toContain('Your local changes to the following files'),
    )
  })

  it('the create form POSTs the new name and clears on success', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'fresh-idea', created: true }),
    })
    renderAt('/git/branches')
    const input = (await screen.findByLabelText('New branch name')) as HTMLInputElement

    // Empty name → the button stays disabled; nothing fires.
    expect((document.querySelector('[data-action="create-branch"]') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'fresh-idea' } })
    fireEvent.click(document.querySelector('[data-action="create-branch"]')!)
    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/repo/branch')
      expect(post?.body).toEqual({ name: 'fresh-idea' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Created and switched to fresh-idea'))
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('forge available: the PR rows render with links and checks badges', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-prs"]')).not.toBeNull())

    await waitFor(() => expect(document.querySelector('[data-slot="pr-row"]')).not.toBeNull())
    const link = document.querySelector('[data-slot="pr-row"] a')
    expect(link?.getAttribute('href')).toBe('https://github.com/acme/demo/pull/7')
    expect(link?.textContent).toContain('#7')
    expect(link?.textContent).toContain('Improve everything')
    const badge = document.querySelector('[data-slot="pr-checks"]')
    expect(badge?.getAttribute('data-checks')).toBe('passing')
  })

  it('no forge driver: the PR section does not render and /api/v1/github is never fetched', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => jsonResponse({ ...HEALTH, forge: null }),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    // Give the health query time to settle, then assert the honest absence.
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/health')).toBe(true))
    expect(document.querySelector('[data-slot="repo-prs"]')).toBeNull()
    expect(sent.some((r) => r.path.startsWith('/api/v1/github'))).toBe(false)
  })

  it('forge detected but unreachable: the section renders the reason instead of rows', async () => {
    stubFetch({
      'GET /api/v1/health': () =>
        jsonResponse({ ...HEALTH, forge: { kind: 'github', available: false, reason: 'gh not logged in' } }),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    // available:false gates the section off entirely — PR links would all be dead ends.
    expect(document.querySelector('[data-slot="repo-prs"]')).toBeNull()
  })
})

// ---- cleanup ----------------------------------------------------------------------------------

describe('the Git view Cleanup section', () => {
  const WORKTREES = {
    worktrees: [
      { runId: 'r1', title: 'Upstream ledger scan', status: 'done', branch: 'cez/a41c0d2e', sizeBytes: 640 * 1024 ** 2, finishedAt: null, reclaimable: true, pastKeep: true },
      { runId: 'r2', title: 'Reviewer agent presets', status: 'review', branch: 'cez/0c3de91f', sizeBytes: 590 * 1024 ** 2, finishedAt: null, reclaimable: false, pastKeep: false },
    ],
    totalBytes: 1230 * 1024 ** 2,
    keep: 20,
  }

  it('renders the worktrees card with a directory-only Reclaim per finished row, under the invariant', async () => {
    stubFetch({
      'GET /api/v1/open-targets': () => jsonResponse({ targets: [] }),
      'GET /api/v1/worktrees': () => jsonResponse(WORKTREES),
    })
    renderAt('/git/cleanup')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="worktree-row"]')).toHaveLength(2))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cleanup')
    expect(document.querySelector('[data-slot="repo-meta"]')?.textContent).toBe('nothing here can delete work that is not on main')
    expect(screen.getByRole('heading', { level: 2, name: 'Worktrees on disk · 1.2 GB' })).toBeTruthy()
    expect(document.querySelector('[data-action="worktrees-reclaim-now"]')?.textContent).toBe('Reclaim 640 MB now')
    expect(document.querySelector('[data-slot="worktrees-retention-link"]')?.getAttribute('href')).toBe('/settings/worktrees')
    // Only the finished row can be reclaimed, and nothing on the card deletes a branch.
    expect([...document.querySelectorAll('[data-action="worktree-reclaim"]')].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Reclaim the worktree of Upstream ledger scan (branch kept)',
    ])
    expect(document.querySelector('[data-action="worktree-delete"]')).toBeNull()
    expect(document.querySelector('[data-slot="worktree-row"][data-run="r2"]')?.textContent).toContain('in use')
    expect(document.querySelector('[data-slot="repo-tabs"]')).toBeNull()
  })

  it('lists the branches safe to delete, each group expandable, and deletes them in one confirmed request', async () => {
    const sent = stubFetch({
      'GET /api/v1/open-targets': () => jsonResponse({ targets: [] }),
      'GET /api/v1/worktrees': () => jsonResponse(WORKTREES),
      'POST /api/v1/repo/branches/delete': () =>
        jsonResponse({ deleted: ['cez/aaaaaaaa', 'cez/cccccccc'], refused: [{ name: 'cez/bbbbbbbb', reason: 'is not merged' }] }),
    })
    renderAt('/git/cleanup')
    await waitFor(() => expect(document.querySelector('[data-slot="cleanup-branches"]')).not.toBeNull())
    expect(screen.getByRole('heading', { level: 2, name: 'Branches safe to delete · 3' })).toBeTruthy()
    const groups = [...document.querySelectorAll<HTMLElement>('[data-slot="cleanup-branch-group"]')]
    expect(groups.map((group) => group.querySelector('button')?.textContent)).toEqual([
      'Merged into main · 2including squash-merged PRs, read from the PR state',
      'Empty · 1no commits beyond the fork point',
    ])
    // Collapsed until asked.
    expect(document.querySelectorAll('[data-slot="cleanup-branch-row"]')).toHaveLength(0)
    fireEvent.click(groups[0]!.querySelector('button')!)
    expect([...document.querySelectorAll('[data-slot="cleanup-branch-row"]')].map((row) => row.getAttribute('data-branch'))).toEqual(['cez/aaaaaaaa', 'cez/bbbbbbbb'])

    fireEvent.click(document.querySelector('[data-action="cleanup-branches-delete"]')!)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Delete 3 branches?')
    fireEvent.click(document.querySelector('[data-action="cleanup-branches-confirm"]')!)
    await waitFor(() => expect(sent.filter((request) => request.method === 'POST')).toHaveLength(1))
    // Only merged and empty names are ever sent; the not-landed and orphan rows never are.
    expect(sent.find((request) => request.method === 'POST')).toMatchObject({
      path: '/api/v1/repo/branches/delete',
      body: { names: ['cez/aaaaaaaa', 'cez/bbbbbbbb', 'cez/cccccccc'] },
    })
    await waitFor(() => expect(document.body.textContent).toContain('Deleted 2 branches; kept 1 that is no longer safe to delete'))
  })

  it('says squash merges may be missed when the forge could not answer', async () => {
    stubFetch({
      'GET /api/v1/open-targets': () => jsonResponse({ targets: [] }),
      'GET /api/v1/worktrees': () => jsonResponse(WORKTREES),
      'GET /api/v1/repo/branches': () => jsonResponse({ ...BRANCHES, prStateKnown: false }),
    })
    renderAt('/git/cleanup')
    await waitFor(() => expect(document.querySelector('[data-slot="cleanup-branches"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="cleanup-branch-group"][data-group="merged"]')?.textContent).toContain(
      'squash-merged branches may show as not landed without github',
    )
  })
})

// ---- not landed -------------------------------------------------------------------------------

describe('the Git view Not landed section', () => {
  const groups = () =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="not-landed-group"]')].map((group) => ({
      title: group.querySelector('h2')?.textContent,
      rows: [...group.querySelectorAll('[data-slot="not-landed-row"]')].map((row) => row.getAttribute('data-branch')),
    }))

  it('groups the finished tasks by what the user can do: no PR, a PR open, or the task deleted', async () => {
    stubFetch()
    renderAt('/git/not-landed')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="not-landed-group"]')).toHaveLength(3))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Not landed')
    expect(document.querySelector('[data-slot="repo-meta"]')?.textContent).toBe('finished tasks whose commits are not on main')
    expect(groups()).toEqual([
      { title: 'No pull request1· nobody sees this work until you act', rows: ['cez/51ab2d7e'] },
      { title: 'Pull request open1', rows: ['cez/7c1e09aa'] },
      { title: 'Task deleted1· this branch is the only copy of the work', rows: ['cez/9d04c1f2'] },
    ])
    const noPr = document.querySelector<HTMLElement>('[data-slot="not-landed-row"][data-branch="cez/51ab2d7e"]')!
    expect(noPr.className).toContain('min-h-[56px]')
    expect(noPr.querySelector('[data-slot="not-landed-title"]')?.textContent).toBe('Retention sweep for archived runs')
    expect(noPr.querySelector('[data-slot="not-landed-meta"]')?.textContent).toMatch(/^cez\/51ab2d7e· 4 commits\+212−40· done \d+d ago$/)
    expect(noPr.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(noPr.querySelector('[data-action="not-landed-open"]')?.getAttribute('href')).toBe('/tasks/run-51')
    expect(noPr.querySelector('[data-action="not-landed-create-pr"]')).not.toBeNull()
    const withPr = document.querySelector<HTMLElement>('[data-slot="not-landed-row"][data-branch="cez/7c1e09aa"]')!
    expect(withPr.querySelector('[data-action="not-landed-create-pr"]')).toBeNull()
    expect(withPr.querySelector('[data-slot="not-landed-pr"]')?.textContent).toContain('PR #705')
    const orphan = document.querySelector<HTMLElement>('[data-slot="not-landed-row"][data-branch="cez/9d04c1f2"]')!
    expect(orphan.querySelector('[data-slot="not-landed-title"]')?.textContent).toBe('No task · last commit “feat(git): worktree sizes in the panel”')
    expect(orphan.querySelector('[data-action="not-landed-copy"]')).not.toBeNull()
    expect(orphan.querySelector('[data-action="not-landed-open"]')).toBeNull()
    expect(document.querySelector('[data-slot="git-no-forge"]')).toBeNull()
  })

  // #922: the row's PR chip carries the PR URL, and the only PRs this view shows belong to the
  // project's own repository. The chip must still read the project's ref-status batch once the
  // scope guard demands proof the URL is own — the fallback is the health repo remote here.
  it('shows the open PR chip the forge status of the project\'s own PR', async () => {
    stubFetch({
      'GET /api/v1/github/ref-status?prs=705': () =>
        jsonResponse({ available: true, prs: { 705: 'merged' }, issues: {}, conflicts: [], recheckAfterMs: null }),
    })
    renderAt('/git/not-landed')
    const chip = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-branch="cez/7c1e09aa"] [data-slot="not-landed-pr"] [data-slot="pr-chip"]')
      if (!found || found.getAttribute('data-status') !== 'merged') throw new Error('the chip has not learned the PR status yet')
      return found
    })
    expect(chip.getAttribute('data-status')).toBe('merged')
  })

  it('Create draft PR posts the task\'s own /runs/:id/pr', async () => {
    const sent = stubFetch({ 'POST /api/v1/runs/run-51/pr': () => jsonResponse({ url: 'https://github.com/acme/demo/pull/710' }) })
    renderAt('/git/not-landed')
    await waitFor(() => expect(document.querySelector('[data-action="not-landed-create-pr"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="not-landed-create-pr"]')!)
    await waitFor(() => expect(sent.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual(['/api/v1/runs/run-51/pr']))
    await waitFor(() => expect(document.body.textContent).toContain('Draft PR created — https://github.com/acme/demo/pull/710'))
  })

  it('Delete branch names what it drops and needs the branch name typed before it sends a lone confirmed name', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branches/delete': () =>
        jsonResponse({ deleted: ['cez/9d04c1f2'], refused: [], dropped: [{ sha: 'a', subject: 'x' }, { sha: 'b', subject: 'y' }, { sha: 'c', subject: 'z' }] }),
    })
    renderAt('/git/not-landed')
    await waitFor(() => expect(document.querySelector('[data-branch="cez/9d04c1f2"] [data-action="not-landed-more"]')).not.toBeNull())
    fireEvent.pointerDown(document.querySelector('[data-branch="cez/9d04c1f2"] [data-action="not-landed-more"]')!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete branch…' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('this branch is the only copy of the work')
    expect(document.querySelector('[data-slot="delete-branch-dropped"]')?.textContent).toBe('3 commits will be dropped (+140 −22), the latest “feat(git): worktree sizes in the panel” (9d04c1f).')
    const confirm = document.querySelector<HTMLButtonElement>('[data-action="delete-branch-confirm"]')!
    expect(confirm.disabled).toBe(true)
    const input = document.querySelector<HTMLInputElement>('[data-slot="delete-branch-confirm"]')!
    fireEvent.change(input, { target: { value: 'cez/9d04c1f' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(sent.filter((request) => request.method === 'POST')).toHaveLength(0)
    fireEvent.change(input, { target: { value: 'cez/9d04c1f2' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(sent.filter((request) => request.method === 'POST')).toHaveLength(1))
    expect(sent.find((request) => request.method === 'POST')).toMatchObject({
      path: '/api/v1/repo/branches/delete',
      body: { names: ['cez/9d04c1f2'], confirm: 'cez/9d04c1f2' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('Deleted cez/9d04c1f2 and 3 commits with it'))
  })

  it('without the forge it still lists the branches, with the squash-merge note and no error', async () => {
    stubFetch({ 'GET /api/v1/repo/branches': () => jsonResponse({ ...BRANCHES, prStateKnown: false }) })
    renderAt('/git/not-landed')
    await waitFor(() => expect(document.querySelector('[data-slot="git-no-forge"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="git-no-forge"]')?.textContent).toBe('Squash-merged branches may show as not landed without GitHub.')
    expect(document.querySelectorAll('[data-slot="not-landed-row"]')).toHaveLength(3)
  })

  it('says everything landed when nothing is left', async () => {
    stubFetch({ 'GET /api/v1/repo/branches': () => jsonResponse({ ...BRANCHES, branches: [], counts: { notLanded: 0, cleanup: 0 } }) })
    renderAt('/git/not-landed')
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Everything landed' })).toBeTruthy())
    expect(document.querySelector('[data-slot="not-landed-retained"]')).toBeNull()
  })

  it('never says everything landed while a finished task with unlanded commits keeps its worktree', async () => {
    // Its branch is checked out in the retained worktree, so the classifier calls it active.
    const retained = branch({ name: 'cez/7a7a7a7a', class: 'active', runId: 'run-7a', runStatus: 'done', ahead: 1 })
    const live = branch({ name: 'cez/8b8b8b8b', class: 'active', runId: 'run-8b', runStatus: 'running', ahead: 2 })
    stubFetch({ 'GET /api/v1/repo/branches': () => jsonResponse({ ...BRANCHES, branches: [retained, live], counts: { notLanded: 0, cleanup: 0 } }) })
    renderAt('/git/not-landed')
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Nothing else waiting to land' })).toBeTruthy())
    expect(screen.queryByRole('heading', { level: 2, name: 'Everything landed' })).toBeNull()
    expect(document.querySelector('[data-slot="not-landed-retained"]')?.textContent).toContain('1 finished task still has its worktree')
    expect(document.querySelector('[data-slot="not-landed-retained"] a')?.getAttribute('href')).toBe('/git/cleanup')
  })
})
