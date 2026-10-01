import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GithubItem, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ListViewProvider } from '@/components/list-view'
import { ThemeProvider } from '@/components/theme-provider'
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

beforeEach(() => {
  paths = []
  item = undefined
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
})
