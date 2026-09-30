import { QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, type ComponentType } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RepoResponse, RunRecord, WorktreeInfo } from '@open-mercato/cezar-api-client'

import { GitSidebar } from './git-sidebar'
import { RepoGitRoute } from './repo-git'
import { RepoGitLoading } from './repo-git-loading'

/**
 * The Git view's Task worktrees list (#622): the desktop sidebar group and the phone's own
 * screen, both fed by `/worktrees` (existence) joined with `/runs` (diff and attention).
 */

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  setDesktop(true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function setDesktop(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: desktop && query === '(min-width: 768px)', addEventListener() {}, removeEventListener() {} }))
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main', remote: null },
  status: [], log: [], branches: ['main'], baseBranch: null,
} as unknown as RepoResponse

const wt = (runId: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  runId, title: `Worktree ${runId}`, status: 'review', branch: `cez/${runId}`, sizeBytes: null, finishedAt: null, reclaimable: false, ...over,
})
const run = (over: Record<string, unknown> & { id: string }) =>
  ({ title: 'run', workflow: 'quick-task', task: 't', status: 'review', createdAt: '2026-07-20T00:00:00Z', tokensUsed: 0, archived: false, steps: [], ...over }) as unknown as RunRecord

interface Stub {
  worktrees?: WorktreeInfo[] | 'error' | Promise<Response>
  runs?: RunRecord[] | 'error'
  repo?: RepoResponse
}

function stub(opts: Stub = {}) {
  const sent: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    sent.push(path)
    if ((init.method ?? 'GET') !== 'GET') return json({})
    if (/\/worktrees$/.test(path)) {
      if (opts.worktrees instanceof Promise) return opts.worktrees
      return opts.worktrees === 'error'
        ? json({ error: 'disk on fire' }, 500)
        : json({ worktrees: opts.worktrees ?? [], totalBytes: null, keep: 0 })
    }
    if (/\/runs$/.test(path)) return opts.runs === 'error' ? json({ error: 'boom' }, 500) : json(opts.runs ?? [])
    if (/\/repo$/.test(path)) return json(opts.repo ?? REPO)
    if (/\/repo\/changes$/.test(path)) return json({ files: [], stat: { adds: 0, dels: 0, files: 0 } })
    if (/\/health$/.test(path)) return json({ version: 't', projects: [], bootProject: 'default', repoRoot: '/repo', repo: REPO.info, checks: [], defaultRunner: 'claude', capabilities: {} })
    return json({})
  }))
  return sent
}

function Where() {
  const { pathname, search } = useLocation()
  return <output data-testid="where">{pathname}{search}</output>
}

function renderSidebar(scope = 'default', client = createQueryClient(), entry = '/git') {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}><GitSidebar scope={scope} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderRoute(entry: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/git" element={<RepoGitRoute tab="changes" />} />
          <Route path="/git/commits" element={<RepoGitRoute tab="commits" />} />
          <Route path="/git/branches" element={<RepoGitRoute tab="branches" />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const rows = () => qa('[data-slot="git-worktree-row"]')

describe('GitSidebar', () => {
  it('lists the repository facets above the worktrees, with counts and the open facet lit', async () => {
    stub({ repo: { ...REPO, status: [{ status: 'M', path: 'a.ts' }, { status: '??', path: 'b.ts' }], branches: ['main', 'dev', 'x'] } as RepoResponse })
    renderSidebar('default', createQueryClient(), '/git/commits/abc123')
    await waitFor(() => expect(q('[data-slot="git-facet-count"]')).not.toBeNull())
    const facets = qa('[data-git-facet]')
    expect(facets.map((a) => a.textContent)).toEqual(['Changes2', 'Commits', 'Branches3'])
    expect(facets.map((a) => a.getAttribute('href'))).toEqual(['/git?view=repo', '/git/commits', '/git/branches'])
    expect(facets.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null])
    expect(q('[data-slot="git-sidebar-branch"]')?.textContent).toBe('main')
    // Repository first, Task worktrees below it.
    const nav = q('[data-slot="git-repo-nav"]')!
    expect(nav.compareDocumentPosition(q('[data-slot="git-worktree-list"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('reads the repository through the explicit scope and lights Changes on bare /git', async () => {
    const sent = stub()
    renderSidebar('cezar', createQueryClient(), '/p/cezar/git')
    await waitFor(() => expect(sent.some((path) => /\/p\/cezar\/repo$/.test(path))).toBe(true))
    expect(q('[data-git-facet="changes"]')?.getAttribute('aria-current')).toBe('page')
    // A clean tree shows no count, not a 0.
    await waitFor(() => expect(q('[data-git-facet="branches"] [data-slot="git-facet-count"]')?.textContent).toBe('1'))
    expect(q('[data-git-facet="changes"] [data-slot="git-facet-count"]')).toBeNull()
  })

  it('lists on-disk worktrees only, each as a scoped link with branch, title, dot and diff', async () => {
    stub({
      worktrees: [wt('a', { title: 'ignored' }), wt('b', { branch: null, status: 'failed' })],
      runs: [
        run({ id: 'a', title: 'Fix login', status: 'waiting', diffStat: { files: 2, adds: 7, dels: 3 } }),
        // Stale run metadata: a worktreePath, but no worktree on disk. Must not appear.
        run({ id: 'ghost', worktreePath: '/wt/ghost', diffStat: { files: 1, adds: 1, dels: 1 } }),
      ],
    })
    renderSidebar()
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(q('[data-slot="git-sidebar"]')).not.toBeNull()
    expect(q('[data-slot="git-worktree-list"]')).not.toBeNull()
    const [a, b] = rows()
    expect(rows().map((row) => row.dataset.runId)).toEqual(['a', 'b'])
    expect(a!.getAttribute('href')).toBe('/tasks/a/changes')
    expect(a!.querySelector('[data-slot="git-worktree-branch"]')?.textContent).toBe('cez/a')
    expect(a!.querySelector('[data-slot="git-worktree-meta"]')?.textContent).toContain('Fix login')
    expect(a!.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+7 −3')
    // Meta reads `title · +7 −3` in one soft colour; the branch line is the bright one.
    expect(a!.querySelector('[data-slot="git-worktree-meta"]')?.textContent).toBe('Fix login · +7 −3')
    expect(a!.querySelector('[data-slot="diff-stat"]')?.className).toContain('[&>span]:text-inherit')
    expect(a!.querySelector('[data-slot="git-worktree-branch"]')?.className).toMatch(/\btext-foreground\b/)
    expect(q('[data-slot="git-worktree-list"] h3')?.textContent).toBe('Task worktrees2')
    expect(a!.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('needs you')
    // No branch on record: say so, and no measured diff: unknown, never +0 −0.
    expect(b!.querySelector('[data-slot="git-worktree-branch"]')?.textContent).toBe('no branch recorded')
    expect(b!.querySelector('[data-slot="git-worktree-branch"]')?.className).toContain('text-soft-foreground')
    expect(b!.querySelector('[data-slot="diff-stat"]')).toBeNull()
    expect(b!.textContent).not.toContain('+0')
  })

  it('shows the explicit empty state', async () => {
    stub({ worktrees: [] })
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="git-worktree-empty"]')?.textContent).toBe('No task worktrees on disk'))
    expect(rows()).toHaveLength(0)
  })

  it('shows loading, then an error that names the failure', async () => {
    let release!: (r: Response) => void
    stub({ worktrees: new Promise<Response>((resolve) => { release = resolve }) })
    renderSidebar()
    await waitFor(() => expect(q('[data-slot="git-worktree-loading"]')).not.toBeNull())
    release(json({ error: 'disk on fire' }, 400))
    await waitFor(() => expect(q('[data-slot="git-worktree-error"]')?.textContent).toContain('disk on fire'))
    expect(q('[data-slot="git-worktree-empty"]')).toBeNull()
  })

  it('a failed /runs read keeps the rows and leaves diffs unknown', async () => {
    stub({ worktrees: [wt('a')], runs: 'error' })
    renderSidebar()
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(q('[data-slot="diff-stat"]')).toBeNull()
  })

  it('reads the explicit scope, and does not reuse another project’s cache entry', async () => {
    const client = createQueryClient()
    const sent = stub({ worktrees: [wt('a')] })
    const first = renderSidebar('default', client)
    await waitFor(() => expect(rows()).toHaveLength(1))
    first.unmount()
    const sentTwo = stub({ worktrees: [wt('z')] })
    renderSidebar('proj-2', client)
    await waitFor(() => expect(rows().map((row) => row.dataset.runId)).toEqual(['z']))
    expect(sent.some((p) => p.includes('/p/'))).toBe(false)
    expect(sentTwo).toContain('/api/v1/p/proj-2/worktrees')
    expect(sentTwo).toContain('/api/v1/p/proj-2/runs')
  })

  it('revisiting a project refetches its worktrees instead of trusting the cached membership (A → B → A)', async () => {
    const client = createQueryClient()
    stub({ worktrees: [wt('x')] })
    const tree = (scope: string) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/git']}><GitSidebar scope={scope} /></MemoryRouter>
      </QueryClientProvider>
    )
    const view = render(tree('a'))
    await waitFor(() => expect(rows().map((row) => row.dataset.runId)).toEqual(['x']))
    stub({ worktrees: [wt('other')] })
    view.rerender(tree('b'))
    await waitFor(() => expect(rows().map((row) => row.dataset.runId)).toEqual(['other']))
    // While B was on screen, A's worktree was deleted and another one created (A's SSE was ignored).
    stub({ worktrees: [wt('y')] })
    view.rerender(tree('a'))
    await waitFor(() => expect(rows().map((row) => row.dataset.runId)).toEqual(['y']))
  })

  it('makes one worktrees, one runs and one repo request, not one per row', async () => {
    const sent = stub({ worktrees: [wt('a'), wt('b'), wt('c')] })
    renderSidebar()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(sent.filter((p) => /\/worktrees$/.test(p))).toHaveLength(1)
    expect(sent.filter((p) => /\/runs$/.test(p))).toHaveLength(1)
    expect(sent.filter((p) => /\/repo$/.test(p))).toHaveLength(1)
    expect(sent.length).toBe(3)
  })
})

describe('the phone Git index', () => {
  it('bare /git is the worktree screen, with Open repository and no repository facets', async () => {
    setDesktop(false)
    stub({ worktrees: [wt('a')] })
    renderRoute('/git')
    await waitFor(() => expect(q('[data-slot="git-worktree-screen"]')).not.toBeNull())
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(q('[data-slot="git-open-repository"]')?.getAttribute('href')).toBe('/git?view=repo')
    expect(q('[data-slot="repo-tabs"]')).toBeNull()
    expect(q('[data-slot="git-sidebar"]')).toBeNull()
  })

  it('/git?view=repo is the repository Changes view with a Back to worktrees link', async () => {
    setDesktop(false)
    stub()
    renderRoute('/git?view=repo')
    await waitFor(() => expect(q('[data-slot="repo-tabs"]')).not.toBeNull())
    expect(q('[data-slot="git-worktree-screen"]')).toBeNull()
    expect(q('[data-slot="git-back-worktrees"]')?.getAttribute('href')).toBe('/git')
    const changes = qa('[data-slot="repo-tabs"] a')[0]!
    expect(changes.getAttribute('href')).toBe('/git?view=repo')
  })

  it('Commits and Branches deep links stay the repository, never the screen', async () => {
    setDesktop(false)
    stub()
    renderRoute('/git/commits')
    await waitFor(() => expect(q('[data-slot="repo-tabs"]')).not.toBeNull())
    expect(q('[data-slot="git-worktree-screen"]')).toBeNull()
    expect(q('[data-slot="git-back-worktrees"]')).not.toBeNull()
  })

  it('desktop /git stays repository Changes, ?view=repo or not, without the phone chrome', async () => {
    stub()
    for (const entry of ['/git', '/git?view=repo']) {
      const view = renderRoute(entry)
      await waitFor(() => expect(q('[data-slot="repo-tabs"]')).not.toBeNull())
      expect(q('[data-slot="git-worktree-screen"]')).toBeNull()
      view.unmount()
    }
  })

  it('keeps Back to worktrees through the repository loading gate', async () => {
    setDesktop(false)
    stub({ worktrees: [] })
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    renderRoute('/git?view=repo')
    await waitFor(() => expect(document.body.textContent).toContain('Loading repository'))
    expect(q('[data-slot="git-back-worktrees"]')?.getAttribute('href')).toBe('/git')
  })

  it('keeps Back to worktrees through the repository error gate', async () => {
    setDesktop(false)
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'nope' }, 400)))
    renderRoute('/git?view=repo')
    await waitFor(() => expect(document.body.textContent).toContain('Could not load the repository'))
    expect(q('[data-slot="git-back-worktrees"]')?.getAttribute('href')).toBe('/git')
  })

  it('keeps Back to worktrees when the project is not a git repository', async () => {
    setDesktop(false)
    stub()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      /\/repo$/.test(String(input)) ? json({ ...REPO, info: null }) : json({})))
    renderRoute('/git?view=repo')
    await waitFor(() => expect(document.body.textContent).toContain('Not a git repository'))
    expect(q('[data-slot="git-back-worktrees"]')?.getAttribute('href')).toBe('/git')
  })

  it('an empty screen still offers the repository', async () => {
    setDesktop(false)
    stub({ worktrees: [] })
    renderRoute('/git')
    await waitFor(() => expect(q('[data-slot="git-worktree-empty"]')).not.toBeNull())
    expect(q('[data-slot="git-open-repository"]')).not.toBeNull()
  })
})

describe('the suspended lazy repository routes (routes.tsx fallbacks)', () => {
  const Never = lazy((): Promise<{ default: ComponentType }> => new Promise(() => {}))
  function renderFallback(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/git" element={<Suspense fallback={<RepoGitLoading />}><Never /></Suspense>} />
          <Route path="/git/commits" element={<Suspense fallback={<RepoGitLoading />}><Never /></Suspense>} />
          <Route path="/git/commits/:sha" element={<Suspense fallback={<RepoGitLoading />}><Never /></Suspense>} />
          <Route path="/git/branches" element={<Suspense fallback={<RepoGitLoading />}><Never /></Suspense>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it.each(['/git/commits', '/git/commits/abc1234', '/git/branches', '/git?view=repo'])('%s offers Back to worktrees while its chunk loads', (entry) => {
    renderFallback(entry)
    expect(document.body.textContent).toContain('Loading repository')
    expect(q('[data-slot="git-back-worktrees"]')?.getAttribute('href')).toBe('/git')
  })

  it('the bare /git index never links to itself', () => {
    renderFallback('/git')
    expect(document.body.textContent).toContain('Loading repository')
    expect(q('[data-slot="git-back-worktrees"]')).toBeNull()
  })
})
