import { QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, type ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RepoResponse, WorktreesResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { GitSidebar } from './git-sidebar'
import { RepoGitRoute } from './repo-git'
import { RepoGitLoading } from './repo-git-loading'

/**
 * The Git view's sidebar and phone screen (issue 06 §3, #622): the checkout block (branch menu,
 * Pull, base-branch picker, uncommitted warning) and the sections Recently on main, Cleanup and
 * All branches. No task-worktree list.
 */

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  setDesktop(true)
})
afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

function setDesktop(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: desktop && query === '(min-width: 768px)', addEventListener() {}, removeEventListener() {} }))
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  status: [],
  log: [{ hash: 'abc1234', subject: 'feat: add the thing', author: 'Ada', when: '5 minutes ago' }],
  branches: ['feature', 'main'],
  baseBranch: null,
}

const WORKTREES: WorktreesResponse = {
  worktrees: [{ runId: 'r1', title: 'A task', status: 'done', branch: 'cez/r1', sizeBytes: 4.2 * 1024 ** 3, finishedAt: null, reclaimable: true }],
  totalBytes: 4.2 * 1024 ** 3,
  keep: 20,
}

interface Sent { method: string; path: string; body: unknown }

function stub(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    sent.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    const override = overrides[`${method} ${path}`]
    if (override) return override()
    if (method !== 'GET') return json({})
    if (/\/worktrees$/.test(path)) return json(WORKTREES)
    if (/\/repo$/.test(path)) return json(REPO)
    if (/\/repo\/changes$/.test(path)) return json({ files: [], stat: { adds: 0, dels: 0, files: 0 } })
    if (/\/open-targets$/.test(path)) return json({ targets: [] })
    if (/\/health$/.test(path)) return json({ version: 't', projects: [], bootProject: 'default', repoRoot: '/repo', repo: REPO.info, checks: [], defaultRunner: 'claude', capabilities: {} })
    return json({})
  }))
  return sent
}

function Where() {
  const { pathname, search } = useLocation()
  return <output data-testid="where">{pathname}{search}</output>
}

function renderSidebar(entry = '/git', scope = 'default') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <GitSidebar scope={scope} />
        <Where />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderRoute(entry: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/git" element={<RepoGitRoute section="main" index />} />
          <Route path="/git/commits" element={<RepoGitRoute section="main" />} />
          <Route path="/git/commits/:sha" element={<RepoGitRoute section="main" />} />
          <Route path="/git/cleanup" element={<RepoGitRoute section="cleanup" />} />
          <Route path="/git/branches" element={<RepoGitRoute section="branches" />} />
          <Route path="/git/changes" element={<RepoGitRoute section="changes" />} />
        </Routes>
        <Where />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const sectionRows = (root = '[data-slot="git-sections"]') => qa(`${root} a[data-git-section]`).map((row) => ({
  section: row.dataset.gitSection,
  text: row.querySelector('span.truncate')?.textContent,
  count: row.querySelector('[data-slot="git-section-count"]')?.textContent ?? null,
  href: row.getAttribute('href'),
  current: row.getAttribute('aria-current'),
}))

/** Radix opens its menus on pointerdown, not click. */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

describe('GitSidebar', () => {
  it('shows the checkout block, then Recently on main, Cleanup and All branches with their counts', async () => {
    stub()
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="git-checkout"]')).not.toBeNull())
    expect(q('[data-slot="git-checkout-branch"]')?.textContent).toBe('main')
    expect(q('[data-action="repo-pull"]')?.textContent).toBe('Pull')
    expect(q('[data-slot="base-branch-picker"]')?.textContent).toBe('New tasks start frommain')
    await waitFor(() => expect(sectionRows()[1]?.count).toBe('4.2 GB'))
    expect(sectionRows()).toEqual([
      { section: 'main', text: 'Recently on main', count: null, href: '/git', current: 'page' },
      { section: 'cleanup', text: 'Cleanup', count: '4.2 GB', href: '/git/cleanup', current: null },
      { section: 'branches', text: 'All branches', count: '2', href: '/git/branches', current: null },
    ])
    // The block sits above the sections, and each section row is the shared 32px row.
    const body = q('[data-slot="git-sidebar"]')!
    expect([...body.children].map((child) => child.getAttribute('data-slot'))).toEqual(['git-checkout', 'git-sections'])
    expect(q('a[data-git-section="cleanup"]')?.className).toContain('h-[32px]')
  })

  it('lists no task worktrees and never links a row to a task', async () => {
    stub()
    renderSidebar()
    await waitFor(() => expect(sectionRows()[1]?.count).toBe('4.2 GB'))
    expect(q('[data-slot="git-worktree-list"]')).toBeNull()
    expect(qa('[data-slot="git-sidebar"] a').some((link) => link.getAttribute('href')?.startsWith('/tasks/'))).toBe(false)
  })

  it.each([
    ['/git', 'main'],
    ['/git/commits', 'main'],
    ['/git/commits/abc1234', 'main'],
    ['/git/cleanup', 'cleanup'],
    ['/git/branches', 'branches'],
    ['/p/beta/git/branches', 'branches'],
  ])('lights the open section on %s', async (entry, section) => {
    stub()
    renderSidebar(entry)
    await waitFor(() => expect(q('[data-slot="git-sections"]')).not.toBeNull())
    expect(qa('[data-slot="git-sections"] a[aria-current="page"]').map((row) => row.dataset.gitSection)).toEqual([section])
  })

  it('the uncommitted files each link into /git/changes, and light no section there', async () => {
    stub({ 'GET /api/v1/repo': () => json({ ...REPO, status: [{ status: 'M', path: 'a' }, { status: '??', path: 'b' }, { status: 'M', path: 'c' }] }) })
    renderSidebar('/git/changes')
    await waitFor(() => expect(q('[data-slot="git-uncommitted"]')).not.toBeNull())
    const link = q('[data-slot="git-uncommitted"]')!
    expect(link.textContent).toBe('3 uncommitted files')
    expect(link.getAttribute('href')).toBe('/git/changes')
    expect(link.className).toContain('border-t')
    expect(link.querySelector('svg')?.getAttribute('class')).toContain('text-inbox-count-foreground')
    expect(qa('[data-slot="git-sections"] a[aria-current="page"]')).toHaveLength(0)
  })

  it('a clean checkout shows no uncommitted line', async () => {
    stub()
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="git-checkout"]')).not.toBeNull())
    expect(q('[data-slot="git-uncommitted"]')).toBeNull()
  })

  it('outside a git repository the sections still render, so the sidebar is never empty', async () => {
    stub({ 'GET /api/v1/repo': () => json({ info: null, status: [], log: [], branches: [], baseBranch: null }) })
    renderSidebar()
    await waitFor(() => expect(sectionRows()[1]?.count).toBe('4.2 GB'))
    expect(q('[data-slot="git-checkout"]')).toBeNull()
    expect(sectionRows().map((row) => row.text)).toEqual(['Recent commits', 'Cleanup', 'All branches'])
    expect(sectionRows()[2]?.count).toBeNull()
  })

  it('holds the checkout block\'s place and draws no section until /repo first answers', async () => {
    let answer: (response: Response) => void = () => {}
    stub({ 'GET /api/v1/repo': () => new Promise<Response>((resolve) => { answer = resolve }) })
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="git-checkout-placeholder"]')).not.toBeNull())
    // Drawing the sections now would slide them down when the block mounts above them.
    expect(q('[data-slot="git-sections"]')).toBeNull()
    await act(async () => answer(json(REPO)))
    await waitFor(() => expect(q('[data-slot="git-checkout"]')).not.toBeNull())
    expect(q('[data-slot="git-checkout-placeholder"]')).toBeNull()
    expect(q('[data-slot="git-sections"]')).not.toBeNull()
  })

  it('a pending Pull confirmation does not follow the sidebar into another project', async () => {
    stub({
      'POST /api/v1/repo/pull': () => json({ error: 'Confirmation required', branch: 'main', risks: ['dirty_tree'] }, 409),
    })
    const client = createQueryClient()
    const tree = (scope: string) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/git']}>
          <GitSidebar scope={scope} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(tree('default'))
    await waitFor(() => expect(q('[data-action="repo-pull"]')).not.toBeNull())
    // Warm the second project's cache so its checkout renders at once on the switch.
    await client.prefetchQuery({ queryKey: ['beta', 'repo'], queryFn: () => REPO })
    fireEvent.click(q('[data-action="repo-pull"]')!)
    await screen.findByRole('alertdialog')
    rerender(tree('beta'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('reads and writes through the explicit scope, never the routed one', async () => {
    const sent = stub({
      'POST /api/v1/p/beta/repo/pull': () => json({ branch: 'main', pulled: true, summary: 'Already up to date.' }),
    })
    renderSidebar('/p/beta/git', 'beta')
    await waitFor(() => expect(q('[data-slot="git-checkout"]')).not.toBeNull())
    expect(sent.some((request) => request.path === '/api/v1/p/beta/repo')).toBe(true)
    expect(sent.some((request) => request.path === '/api/v1/p/beta/worktrees')).toBe(true)
    fireEvent.click(q('[data-action="repo-pull"]')!)
    await waitFor(() => expect(document.body.textContent).toContain('Already up to date.'))
    expect(sent.filter((request) => request.method === 'POST').map((request) => [request.path, request.body])).toEqual([
      ['/api/v1/p/beta/repo/pull', { branch: 'main' }],
    ])
  })
})

describe('the checkout block', () => {
  it.each([
    ['active_runs', 'active session'],
    ['dirty_tree', 'dirty files'],
  ] as const)('Pull asks for confirmation when the server reports %s, then pulls with confirm', async (risk, copy) => {
    let attempts = 0
    const sent = stub({
      'POST /api/v1/repo/pull': () => {
        attempts += 1
        return attempts === 1
          ? json({ error: 'Confirmation required', branch: 'main', risks: [risk] }, 409)
          : json({ branch: 'main', pulled: true, summary: 'Already up to date.' })
      },
    })
    renderSidebar()
    await waitFor(() => expect(q('[data-action="repo-pull"]')).not.toBeNull())
    fireEvent.click(q('[data-action="repo-pull"]')!)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain(copy)
    fireEvent.click(screen.getByRole('button', { name: 'Pull anyway' }))
    await waitFor(() => expect(attempts).toBe(2))
    expect(sent.filter((request) => request.path === '/api/v1/repo/pull').map((request) => request.body)).toEqual([
      { branch: 'main' },
      { branch: 'main', confirm: true },
    ])
  })

  it('Cancel on the confirmation leaves the repository untouched and returns focus to Pull', async () => {
    let attempts = 0
    stub({
      'POST /api/v1/repo/pull': () => {
        attempts += 1
        return json({ error: 'Confirmation required', branch: 'main', risks: ['active_runs', 'dirty_tree'] }, 409)
      },
    })
    renderSidebar()
    await waitFor(() => expect(q('[data-action="repo-pull"]')).not.toBeNull())
    const pull = q('[data-action="repo-pull"]') as HTMLButtonElement
    pull.focus()
    fireEvent.click(pull)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('active session')
    expect(dialog.textContent).toContain('dirty files')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(attempts).toBe(1)
    await waitFor(() => expect(document.activeElement).toBe(pull))
  })

  it('a clean pull toasts the summary and refreshes the repository', async () => {
    const sent = stub({ 'POST /api/v1/repo/pull': () => json({ branch: 'main', pulled: true, summary: 'Fast-forwarded by 2 commits.' }) })
    renderSidebar()
    await waitFor(() => expect(q('[data-action="repo-pull"]')).not.toBeNull())
    const reads = sent.filter((request) => request.path === '/api/v1/repo').length
    fireEvent.click(q('[data-action="repo-pull"]')!)
    await waitFor(() => expect(document.body.textContent).toContain('Fast-forwarded by 2 commits.'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(sent.filter((request) => request.path === '/api/v1/repo').length).toBeGreaterThan(reads))
  })

  it('an ordinary pull error is a danger toast', async () => {
    stub({ 'POST /api/v1/repo/pull': () => json({ error: 'No upstream configured for main' }, 409) })
    renderSidebar()
    await waitFor(() => expect(q('[data-action="repo-pull"]')).not.toBeNull())
    fireEvent.click(q('[data-action="repo-pull"]')!)
    await waitFor(() => expect(document.body.textContent).toContain('No upstream configured for main'))
  })

  it('Pull is disabled with an actionable reason when no remote is configured', async () => {
    const sent = stub({ 'GET /api/v1/repo': () => json({ ...REPO, info: { ...REPO.info!, remote: null } }) })
    renderSidebar()
    await waitFor(() => expect(q('[data-action="repo-pull"]')).not.toBeNull())
    const pull = q('[data-action="repo-pull"]') as HTMLButtonElement
    expect(pull.disabled).toBe(true)
    expect(pull.title).toContain('No remote configured')
    expect(sent.some((request) => request.path.endsWith('/repo/pull'))).toBe(false)
  })

  it('the branch menu switches through POST /repo/branch and shows the new checkout', async () => {
    const sent = stub({ 'POST /api/v1/repo/branch': () => json({ branch: 'feature', created: false }) })
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="git-branch-menu"]')).not.toBeNull())
    openMenu(q('[data-slot="git-branch-menu"]')!)
    const item = await screen.findByRole('menuitemradio', { name: 'feature' })
    expect(screen.getByRole('menuitemradio', { name: 'main' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(item)
    await waitFor(() => expect(sent.find((request) => request.method === 'POST')?.body).toEqual({ name: 'feature' }))
    expect(sent.find((request) => request.method === 'POST')?.path).toBe('/api/v1/repo/branch')
    await waitFor(() => expect(document.body.textContent).toContain('Switched to feature'))
    await waitFor(() => expect(q('[data-slot="git-checkout-branch"]')?.textContent).toBe('feature'))
  })

  it('the branch menu links to All branches to create one', async () => {
    stub()
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="git-branch-menu"]')).not.toBeNull())
    openMenu(q('[data-slot="git-branch-menu"]')!)
    const all = await screen.findByRole('menuitem', { name: 'Create or find a branch…' })
    expect(all.getAttribute('href')).toBe('/git/branches')
  })

  it('the base-branch picker PUTs /config with the chosen branch, and null for the checked-out default', async () => {
    const sent = stub({
      'PUT /api/v1/config': () => json({ baseBranch: 'feature', defaultRunner: 'claude' }),
    })
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="base-branch-picker"]')).not.toBeNull())
    openMenu(q('[data-slot="base-branch-picker"]')!)
    expect((await screen.findByRole('menuitemradio', { name: 'The checked-out branch (default)' })).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'feature' }))
    await waitFor(() => expect(sent.find((request) => request.method === 'PUT')?.body).toEqual({ baseBranch: 'feature' }))
    await waitFor(() => expect(document.body.textContent).toContain('New tasks now start from feature'))
  })

  it('names the configured base branch', async () => {
    stub({ 'GET /api/v1/repo': () => json({ ...REPO, baseBranch: 'feature' }) })
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="base-branch"]')?.textContent).toBe('feature'))
  })
})

describe('the phone Git screen', () => {
  beforeEach(() => setDesktop(false))

  it('bare /git is the checkout block and the sections as 48px rows with chevrons', async () => {
    stub()
    renderRoute('/git')
    await waitFor(() => expect(q('[data-slot="git-screen"] [data-slot="git-checkout"]')).not.toBeNull())
    expect(q('[data-slot="git-screen"] h1')?.textContent).toBe('Git')
    expect(q('[data-slot="git-checkout"]')?.getAttribute('data-variant')).toBe('screen')
    await waitFor(() => expect(sectionRows()[1]?.count).toBe('4.2 GB'))
    expect(sectionRows()).toEqual([
      { section: 'main', text: 'Recently on main', count: '1 today', href: '/git?view=repo', current: null },
      { section: 'cleanup', text: 'Cleanup', count: '4.2 GB', href: '/git/cleanup', current: null },
      { section: 'branches', text: 'All branches', count: '2', href: '/git/branches', current: null },
    ])
    const row = q('a[data-git-section="cleanup"]')!
    expect(row.className).toContain('h-[48px]')
    expect(row.querySelectorAll('svg')).toHaveLength(2)
    expect(q('[data-slot="git-worktree-list"]')).toBeNull()
  })

  it('a section pushes its screen, which leads back to Git', async () => {
    stub()
    renderRoute('/git')
    await waitFor(() => expect(q('a[data-git-section="main"]')).not.toBeNull())
    fireEvent.click(q('a[data-git-section="main"]')!)
    await waitFor(() => expect(q('[data-slot="repo-commits"]')).not.toBeNull())
    expect(screen.getByTestId('where').textContent).toBe('/git?view=repo')
    expect(q('[data-slot="git-back"]')?.getAttribute('href')).toBe('/git')
    expect(q('[data-slot="git-back"]')?.textContent).toBe('Back to Git')
  })

  it.each(['/git/commits', '/git/commits/abc1234', '/git/cleanup', '/git/branches', '/git/changes'])('%s stays its section, never the screen', async (entry) => {
    stub()
    renderRoute(entry)
    await waitFor(() => expect(q('[data-slot="repo-header"]')).not.toBeNull())
    expect(q('[data-slot="git-screen"]')).toBeNull()
    expect(q('[data-slot="git-back"]')).not.toBeNull()
  })

  it('desktop /git is Recently on main, ?view=repo or not, without the phone chrome', async () => {
    setDesktop(true)
    stub()
    renderRoute('/git?view=repo')
    await waitFor(() => expect(q('[data-slot="repo-commits"]')).not.toBeNull())
    expect(q('[data-slot="git-screen"]')).toBeNull()
  })

  it('the screen degrades honestly outside a git repository and still offers the sections', async () => {
    stub({ 'GET /api/v1/repo': () => json({ info: null, status: [], log: [], branches: [], baseBranch: null }) })
    renderRoute('/git')
    await waitFor(() => expect(q('[data-slot="git-screen-not-git"]')).not.toBeNull())
    expect(sectionRows()).toHaveLength(3)
  })
})

describe('the suspended lazy Git routes (routes.tsx fallbacks)', () => {
  const Never = lazy(() => new Promise<{ default: ComponentType }>(() => {}))
  function renderFallback(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Suspense fallback={<RepoGitLoading />}><Never /></Suspense>
      </MemoryRouter>,
    )
  }

  it.each(['/git/commits', '/git/commits/abc1234', '/git/cleanup', '/git/branches', '/git/changes', '/git?view=repo'])('%s offers Back to Git while its chunk loads', (entry) => {
    renderFallback(entry)
    expect(q('[data-slot="git-back"]')?.getAttribute('href')).toBe('/git')
  })

  it('the bare /git index never links to itself', () => {
    renderFallback('/git')
    expect(q('[data-slot="git-back"]')).toBeNull()
  })
})
