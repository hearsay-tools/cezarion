import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GithubItem, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ListViewProvider } from '@/components/list-view'
import { ThemeProvider } from '@/components/theme-provider'
import { githubRunBody } from '@/lib/github-task'
import { AppRoutes } from '@/routes'

/**
 * `/p/:projectId/tasks/:id/{issue,pr}/:n` (#692), one case per row of the spec's States table,
 * rendered through the real route map so the lazy route, the project scope and the header are the
 * ones the cockpit ships.
 */

const BOOT = 'boot'
const REPO = 'https://github.com/hearsay-tools/cezarion'

const HEALTH = {
  version: '0.0.0-test',
  repoRoot: '/home/u/cezar',
  repo: null,
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, followups: true, singleProject: false, automations: false },
  projects: [{ id: BOOT, name: 'cezar' }],
  bootProject: BOOT,
}

const project = (id: string) => ({
  id,
  name: id,
  root: `/home/u/${id}`,
  addedAt: '',
  lastOpenedAt: '',
  source: 'local' as const,
  status: 'ok' as const,
  repoUrl: REPO,
})

const REGISTRY: ProjectsResponse = {
  projects: [project(BOOT), project('other'), project('third')],
  bootProject: BOOT,
  projectsDir: '~/cezar/projects',
}

const RUN = {
  id: 'r1',
  title: 'Do the thing',
  task: 'Do the thing',
  status: 'done',
  createdAt: '2026-07-14T10:00:00Z',
  archived: false,
  workflow: 'quick-task',
  tokensUsed: 0,
  steps: [],
  prNumber: 5,
  issueNumber: 7,
}

const PR_5: GithubItem = {
  kind: 'pr',
  number: 5,
  title: 'Ship the item tabs',
  author: 'grace',
  createdAt: '2026-09-30T08:00:00.000Z',
  labels: [],
  body: 'Adds a tab per linked item.',
  url: `${REPO}/pull/5`,
  comments: 0,
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let paths: string[] = []
/** What the item route answers; `undefined` leaves it pending forever. */
let item: ((path: string) => Response) | undefined
/** What the lazy checks route answers; `undefined` leaves it pending forever. */
let checks: ((path: string) => Response) | undefined

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  paths = []
  item = undefined
  checks = undefined
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      paths.push(path)
      if (path === '/api/v1/health') return json(HEALTH)
      if (path === '/api/v1/projects') return json(REGISTRY)
      if (/^\/api\/v1\/(?:p\/[^/]+\/)?runs\/r1$/.test(path)) return json(RUN)
      if (path.includes('/github/items/') && item) return item(path)
      if (path.includes('/github/checks') && checks) return checks(path)
      // Everything else stays pending: this file is about the item route, not the shell's data.
      return new Promise<never>(() => {})
    }),
  )
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function NavigationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <div data-testid="location" data-pathname={location.pathname} />
      <button onClick={() => navigate('/p/other/github/issues/7')}>Open GitHub issue</button>
      <button onClick={() => navigate('/p/other/tasks/r1/issue/7')}>Open task issue</button>
      <button onClick={() => navigate('/p/third/tasks/r1/pr/5')}>Open the third project’s PR tab</button>
      <button onClick={() => navigate('/p/other/tasks/r1/pr/5')}>Open the other project’s PR tab</button>
    </>
  )
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <ListViewProvider>
              <AppRoutes />
              <NavigationProbe />
            </ListViewProvider>
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

/** An element inside the item route, or null — never `undefined`, so `not.toBeNull()` means it. */
const inRoute = (selector: string) => document.querySelector(`[data-route="task-github-item"] ${selector}`)
const itemRequests = () => paths.filter((path) => path.includes('/github/items/'))
const tabRow = async () =>
  within(await waitFor(() => {
    const row = document.querySelector('[data-slot="run-tabs"]')
    if (!row) throw new Error('the header has not rendered yet')
    return row as HTMLElement
  }))

describe('TaskGithubItemRoute', () => {
  it.each(['issue', 'pr'] as const)('renders GitHub label colours on the task %s tab', async (kind) => {
    const number = kind === 'issue' ? 7 : 5
    item = () => json({
      available: true,
      item: { ...PR_5, kind, number, labels: ['bug', 'unknown'] },
      labelColors: { bug: 'd73a4a' },
    })
    renderAt(`/p/other/tasks/r1/${kind}/${number}`)
    await waitFor(() => expect(inRoute('[data-slot="gh-label"][data-label="bug"]')).not.toBeNull())
    const bug = inRoute('[data-slot="gh-label"][data-label="bug"]') as HTMLElement
    expect(bug.style.backgroundColor).toBe('rgba(215, 58, 74, 0.133)')
    expect(bug.style.borderColor).toBe('rgba(215, 58, 74, 0.4)')
    expect((inRoute('[data-slot="gh-label"][data-label="unknown"]') as HTMLElement).style.backgroundColor).toBe('')
  })

  it.each([undefined, {}])('keeps labels neutral when the colour map is %j', async (labelColors) => {
    item = () => json({ available: true, item: { ...PR_5, labels: ['bug'] }, labelColors })
    renderAt('/p/other/tasks/r1/pr/5')
    await waitFor(() => expect(inRoute('[data-slot="gh-label"]')).not.toBeNull())
    const chip = inRoute('[data-slot="gh-label"]') as HTMLElement
    expect(chip.textContent).toBe('bug')
    expect(chip.style.backgroundColor).toBe('')
    expect(chip.style.color).toBe('var(--muted-foreground)')
  })

  it('shares the real hand-to-agent panel and prompt draft across the GitHub and task issue routes', async () => {
    const issue = { ...PR_5, kind: 'issue', number: 7, url: `${REPO}/issues/7` }
    item = () => json({ available: true, item: issue })
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/github?')) return json({ available: true, repo: 'hearsay-tools/cezarion', syncedAt: '', issues: [issue], prs: [] })
      if (path.endsWith('/workflows')) return json({ workflows: [{ name: 'quick-task', steps: [], source: 'built-in' }], issues: [] })
      if (path.endsWith('/skills')) return json([])
      if (path.endsWith('/ui-state')) return json({})
      return originalFetch(input, init)
    }))
    renderAt('/p/other/tasks/r1/issue/7')
    const prompt = await screen.findByRole('textbox', { name: 'Custom prompt' }, { timeout: 10_000 })
    expect(screen.queryByRole('link', { name: /View task/ })).toBeNull()
    fireEvent.change(prompt, { target: { value: 'Keep this draft across surfaces' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }))
    fireEvent.click(await screen.findByRole('option', { name: 'quick-task' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub issue' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Custom prompt' }) as HTMLTextAreaElement).value).toBe('Keep this draft across surfaces'))
    expect(screen.getByRole('button', { name: 'Choose a workflow' }).textContent).toContain('quick-task')
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom prompt' }), { target: { value: 'Edited in GitHub' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open task issue' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Custom prompt' }) as HTMLTextAreaElement).value).toBe('Edited in GitHub'))
    expect(screen.getByRole('button', { name: 'Choose a workflow' }).textContent).toContain('quick-task')
  }, 20_000)

  it.each(['task', 'github'])('submits from the %s surface to the active project and keeps failed drafts for retry', async (surface) => {
    const issue: GithubItem = { ...PR_5, kind: 'issue', number: 7, url: `${REPO}/issues/7` }
    item = () => json({ available: true, item: issue })
    const sent: { path: string; body: unknown }[] = []
    let fail = true
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (init?.method === 'POST' && path.endsWith('/runs')) {
        sent.push({ path, body: JSON.parse(String(init.body)) })
        return fail ? json({ error: 'Try again' }, 500) : json({ ...RUN, id: 'new-run', status: 'queued' })
      }
      if (path.includes('/github?')) return json({ available: true, repo: 'hearsay-tools/cezarion', syncedAt: '', issues: [issue], prs: [] })
      if (path.endsWith('/workflows')) return json({ workflows: [], issues: [] })
      if (path.endsWith('/skills')) return json([])
      if (path.endsWith('/ui-state')) return json({})
      if (path.endsWith('/providers/status')) return json({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
      if (path.includes('/models?')) return json({ runner: 'claude', models: [], source: 'unavailable', stale: false })
      if (path.endsWith('/config')) return json({})
      if (path.includes('/agent-accounts')) return json({ accounts: [] })
      return originalFetch(input, init)
    }))
    renderAt(surface === 'task' ? '/p/other/tasks/r1/issue/7' : '/p/other/github/issues/7')
    const prompt = await screen.findByRole('textbox', { name: 'Custom prompt' }, { timeout: 10_000 })
    fireEvent.change(prompt, { target: { value: 'Ship this fix' } })
    const start = await screen.findByRole('button', { name: /Run agent/ })
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(start)
    await waitFor(() => expect(sent).toHaveLength(1))
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    expect((prompt as HTMLTextAreaElement).value).toBe('Ship this fix')
    expect(screen.queryByRole('link', { name: /View task/ })).toBeNull()
    fail = false
    fireEvent.click(start)
    const link = await screen.findByRole('link', { name: /View task/ })
    expect(link.getAttribute('href')).toBe('/p/other/tasks/new-run')
    expect(sent).toEqual([
      { path: '/api/v1/p/other/runs', body: githubRunBody(issue, null, [], 'Ship this fix', { runner: 'claude' }) },
      { path: '/api/v1/p/other/runs', body: githubRunBody(issue, null, [], 'Ship this fix', { runner: 'claude' }) },
    ])
    fireEvent.click(screen.getByRole('button', { name: surface === 'task' ? 'Open GitHub issue' : 'Open task issue' }))
    await waitFor(() => expect(screen.getByRole('link', { name: /View task/ }).getAttribute('href')).toBe('/p/other/tasks/new-run'))
  })

  it('shows the detail skeleton under the header while the item loads', async () => {
    renderAt('/p/other/tasks/r1/pr/5')
    const tabs = await tabRow()
    expect(tabs.getByRole('link', { name: 'Pull request #5' }).getAttribute('aria-current')).toBe('page')
    await waitFor(() => expect(inRoute('[data-slot="task-github-loading"]')).not.toBeNull())
  })

  it('says why GitHub is unavailable and links the item out', async () => {
    item = () => json({ available: false, reason: 'gh is not installed' })
    renderAt('/p/other/tasks/r1/pr/5')
    expect(await screen.findByText('gh is not installed')).toBeTruthy()
    const link = screen.getByRole('link', { name: /open on GitHub/ })
    expect(link.getAttribute('href')).toBe(`${REPO}/pull/5`)
  })

  it('says the item was not found in the project repository', async () => {
    item = () => json({ available: true, item: null })
    renderAt('/p/other/tasks/r1/issue/7')
    expect(await screen.findByText('Issue #7 was not found in hearsay-tools/cezarion')).toBeTruthy()
  })

  it('refuses a number the task is not linked to, without asking GitHub', async () => {
    item = () => json({ available: true, item: PR_5 })
    renderAt('/p/other/tasks/r1/pr/99')
    expect(await screen.findByText('#99 is not linked to this task')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to the session' }).getAttribute('href')).toBe('/p/other/tasks/r1')
    expect(itemRequests()).toEqual([])
  })

  it('shows a failed request inline and retries with refresh=1', async () => {
    item = (path) => (path.endsWith('refresh=1') ? json({ available: true, item: PR_5 }) : json({ error: 'boom' }, 500))
    renderAt('/p/other/tasks/r1/pr/5')
    // The client retries a 5xx once on its own (query-client.ts), so the error lands after a backoff.
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 }))
    await waitFor(() => expect(itemRequests()).toContain('/api/v1/p/other/github/items/pr/5?refresh=1'))
    await waitFor(() => expect(inRoute('[data-slot="gh-detail-inner"]')).not.toBeNull())
  })

  it('renders the shared detail with no back link and no PR sub-nav', async () => {
    item = () => json({ available: true, item: PR_5 })
    renderAt('/p/other/tasks/r1/pr/5')
    await waitFor(() => expect(inRoute('[data-slot="gh-detail-inner"]')).not.toBeNull())
    expect(screen.getByRole('heading', { name: /Ship the item tabs/ })).toBeTruthy()
    expect(document.querySelector('[data-slot="gh-back"]')).toBeNull()
    expect(document.querySelector('nav[aria-label="Pull request detail"]')).toBeNull()
    expect(document.querySelector('[data-slot="gh-files-changed"]')).not.toBeNull()
    expect((await tabRow()).getByRole('link', { name: 'Pull request #5' }).getAttribute('aria-current')).toBe('page')
    expect(itemRequests()).toEqual(['/api/v1/p/other/github/items/pr/5'])
  })

  it('asks the new project again when the same number opens in another project', async () => {
    item = () => json({ available: true, item: PR_5 })
    renderAt('/p/other/tasks/r1/pr/5')
    await waitFor(() => expect(itemRequests()).toContain('/api/v1/p/other/github/items/pr/5'))
    fireEvent.click(screen.getByRole('button', { name: 'Open the third project’s PR tab' }))
    await waitFor(() => expect(itemRequests()).toContain('/api/v1/p/third/github/items/pr/5'))
  })

  it('files a Retry answer under the project it was asked in, after a project switch', async () => {
    let releaseRetry: (() => void) | undefined
    item = (path) => {
      if (path.startsWith('/api/v1/p/third/')) return json({ available: true, item: { ...PR_5, title: 'The third project’s PR' } })
      if (!path.endsWith('refresh=1')) return json({ error: 'boom' }, 500)
      // Held open: the user switches projects before this answer lands.
      return new Promise<Response>((resolve) => {
        releaseRetry = () => resolve(json({ available: true, item: { ...PR_5, title: 'The other project’s PR' } }))
      }) as unknown as Response
    }
    renderAt('/p/other/tasks/r1/pr/5')
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 }))
    await waitFor(() => expect(releaseRetry).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Open the third project’s PR tab' }))
    expect(await screen.findByRole('heading', { name: /The third project’s PR/ })).toBeTruthy()

    releaseRetry!()
    // Give the late answer every chance to land in the wrong cache entry.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByRole('heading', { name: /The third project’s PR/ })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /The other project’s PR/ })).toBeNull()

    // And the project it was asked in has it: back there, the answer shows without a new request.
    const before = itemRequests().length
    fireEvent.click(screen.getByRole('button', { name: 'Open the other project’s PR tab' }))
    expect(await screen.findByRole('heading', { name: /The other project’s PR/ })).toBeTruthy()
    expect(itemRequests().length).toBe(before)
  })

  it('hydrates the PR’s checks badge, linking to its checks on GitHub', async () => {
    // The item route answers `checks: null` (forge/github.ts); the badge comes from the lazy
    // checks route, exactly as in the GitHub view.
    item = () => json({ available: true, item: { ...PR_5, checks: null } })
    checks = () => json({ available: true, checks: { 5: 'passing' } })
    renderAt('/p/other/tasks/r1/pr/5')
    const badge = await waitFor(() => {
      const found = inRoute('[data-slot="gh-checks"]')
      if (!found) throw new Error('no checks badge yet')
      return found
    })
    expect(badge.getAttribute('data-checks')).toBe('passing')
    expect(badge.getAttribute('href')).toBe(`${REPO}/pull/5/checks`)
    expect(paths).toContain('/api/v1/p/other/github/checks?prs=5')
  })

  it('falls back to the item’s own rollup when checks are unavailable, like the GitHub view', async () => {
    item = () => json({ available: true, item: { ...PR_5, checks: 'failing' } })
    checks = () => json({ available: false, reason: 'gh is not installed' })
    renderAt('/p/other/tasks/r1/pr/5')
    await waitFor(() => expect(paths).toContain('/api/v1/p/other/github/checks?prs=5'))
    await waitFor(() => expect(inRoute('[data-slot="gh-checks"]')?.getAttribute('data-checks')).toBe('failing'))
  })

  it('asks for no checks on an issue tab', async () => {
    item = () => json({ available: true, item: { ...PR_5, kind: 'issue', number: 7, url: `${REPO}/issues/7` } })
    checks = () => json({ available: true, checks: {} })
    renderAt('/p/other/tasks/r1/issue/7')
    await waitFor(() => expect(inRoute('[data-slot="gh-detail-inner"]')).not.toBeNull())
    expect(paths.filter((path) => path.includes('/github/checks'))).toEqual([])
  })

  it('retries an unavailable answer past the item cache and renders the item', async () => {
    // A gh/auth/transport failure is a 200 `{ available: false }`, cached for a minute client-side;
    // Retry must ask gh again (refresh=1) rather than wait that out.
    item = (path) =>
      path.endsWith('refresh=1')
        ? json({ available: true, item: PR_5 })
        : json({ available: false, reason: 'gh auth token expired' })
    renderAt('/p/other/tasks/r1/pr/5')
    expect(await screen.findByText('gh auth token expired')).toBeTruthy()
    // The way out to github.com stays beside the retry.
    expect(screen.getByRole('link', { name: /open on GitHub/ }).getAttribute('href')).toBe(`${REPO}/pull/5`)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(itemRequests()).toContain('/api/v1/p/other/github/items/pr/5?refresh=1'))
    await waitFor(() => expect(inRoute('[data-slot="gh-detail-inner"]')).not.toBeNull())
    expect(screen.queryByText('gh auth token expired')).toBeNull()
  })
})
