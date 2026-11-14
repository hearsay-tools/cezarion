import { githubItemSchema } from '@open-mercato/cezar-api-client/contract/github'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { expect, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import type { GithubComment, GithubCommentsData, GithubData, GithubItem, HealthResponse, ProviderStatusResponse, Runner, Skill, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster } from '@/components/ui/toaster'
import { githubTaskRef } from '@/lib/github-task'
import { GithubRoute } from './github'

export const ISSUE_142: GithubItem = {
  kind: 'issue',
  number: 142,
  title: 'Login form drops session on refresh',
  author: 'ada',
  createdAt: '2026-07-09T08:00:00.000Z',
  labels: ['bug', 'auth'],
  body: 'Repro: log in, hit reload — you land back on /login.',
  url: 'https://github.com/acme/demo/issues/142',
  comments: 3,
}

export const ISSUE_139: GithubItem = {
  kind: 'issue',
  number: 139,
  title: 'Add --json flag to the CLI',
  author: 'lin',
  createdAt: '2026-07-10T08:00:00.000Z',
  labels: [],
  body: '',
  url: 'https://github.com/acme/demo/issues/139',
  comments: 0,
}

export const PR_137: GithubItem = {
  kind: githubItemSchema.shape.kind.enum.pr,
  number: 137,
  title: 'Stream tokens over SSE',
  author: 'grace',
  createdAt: '2026-07-11T08:00:00.000Z',
  labels: ['perf'],
  body: 'Replaces polling with a single SSE stream.',
  url: 'https://github.com/acme/demo/pull/137',
  comments: 1,
  additions: 120,
  deletions: 30,
  checks: 'failing',
}

export const GITHUB: GithubData = {
  available: true,
  repo: 'acme/demo',
  syncedAt: '2026-07-15T08:00:00.000Z',
  issues: [ISSUE_142, ISSUE_139],
  prs: [PR_137],
}

export const COMMENT_TEXT: GithubComment = {
  id: 1,
  author: 'maya',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  createdAt: '2026-07-12T08:00:00.000Z',
  body: 'Confirmed on my end too — nice catch.',
  kind: 'comment',
  url: 'https://github.com/acme/demo/issues/142#issuecomment-1',
}

export const COMMENT_IMAGE: GithubComment = {
  id: 2,
  author: 'noAvatar',
  createdAt: '2026-07-12T09:00:00.000Z',
  body: 'Screenshot:\n\n![shot](https://example.com/shot.png)',
  kind: 'comment',
  url: 'https://github.com/acme/demo/issues/142#issuecomment-2',
}

export const REVIEW_CHANGES: GithubComment = {
  id: 3,
  author: 'rev',
  avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
  createdAt: '2026-07-12T10:00:00.000Z',
  body: 'Please add a test.',
  kind: 'review',
  reviewState: 'changes_requested',
  url: 'https://github.com/acme/demo/pull/137#pullrequestreview-3',
}

export const THREAD: GithubCommentsData = { available: true, comments: [COMMENT_TEXT, COMMENT_IMAGE] }

export const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    { name: 'quick-task', description: 'one step', steps: [], source: 'built-in' },
    { name: 'ship-it', description: 'plan, build, review', steps: [], source: 'file' },
  ],
  issues: [],
}

export const SKILLS: Skill[] = [
  { name: 'g-review', description: 'global review', body: '', path: '/g/g-review.md', source: 'global' },
  { name: 'om-fix', description: 'project fixer', body: '', path: '/p/om-fix.md', source: 'ai' },
  { name: 'team-x', description: 'team skill', body: '', path: '/t/team-x.md', source: 'team' },
]

export const PROVIDERS_CONNECTED: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

export const PROVIDERS_MULTI: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
}

export const PROVIDERS_NONE: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true },
    { provider: 'codex', status: 'unknown', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

export interface SentRequest {
  path: string
  method: string
  body: unknown
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function githubGetResponse(method: string, path: string): Response | undefined {
  // Any comment-thread request defaults to the two-comment THREAD fixture; a test overrides a
  // specific `GET /api/v1/github/comments/<kind>/<n>` key to serve a different thread.
  if (method === 'GET' && path.startsWith('/api/v1/github/comments/')) return jsonResponse(THREAD)
  if (method === 'GET' && path.startsWith('/api/v1/github/prs/') && path.includes('/changes')) return jsonResponse({
    available: true, number: 137, headSha: '0123456789abcdef0123456789abcdef01234567',
    additions: 3, deletions: 1, truncated: true, reason: 'One patch was omitted.',
    files: [
      { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'logo.png', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'binary' },
    ],
  })
  // Deferred comment counts (hearsay-tools/cezarion#1183) default to "nothing known".
  if (method === 'GET' && path.startsWith('/api/v1/github/comment-counts')) {
    return jsonResponse({ available: true, counts: {} })
  }
  // Lazy PR checks (#664) default to an empty map — a test overrides to hydrate specific glyphs.
  if (method === 'GET' && path.startsWith('/api/v1/github/checks')) {
    return jsonResponse({ available: true, checks: {} })
  }
  // Cross-state search (#730) defaults to "searched, found nothing" — a test overrides the
  // exact `GET /api/v1/github/search?…` key to serve hits. Without this default an unstubbed
  // search would fall through to `{}` and read as an unavailable payload.
  if (method === 'GET' && path.includes('/github/search')) {
    return jsonResponse({ available: true, items: [] })
  }
  // The GitHub list is one fast fetch now (#664): `/api/v1/github` with an optional `?limit=…`
  // and/or `?refresh=1`. Sub-resources (`/api/v1/github/comments`, `/prs`, `/checks`) never match
  // `=== '/api/v1/github'` or `startsWith('/api/v1/github?')`, so this stays scoped to the list.
  if (method === 'GET' && (path === '/api/v1/github' || path.startsWith('/api/v1/github?'))) {
    return jsonResponse(GITHUB)
  }
  return undefined
}

export function runSummariesResponse(method: string, path: string): Response | undefined {
  if (method === 'GET' && path === '/api/v1/run-summaries') return jsonResponse([])
  // An issue's linked tasks also search the archived runs past the list's window (#864).
  if (method === 'GET' && path.startsWith('/api/v1/run-summaries/archived')) return jsonResponse({ runs: [], nextCursor: null, total: 0 })
  return undefined
}

export function stubFetch(
  overrides: Record<string, () => Response | Promise<Response>> = {},
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).replace('?archived=recent', '')
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      const githubResponse = githubGetResponse(method, path)
      if (githubResponse) return githubResponse
      const summariesResponse = runSummariesResponse(method, path)
      if (summariesResponse) return summariesResponse
      if (method === 'GET' && path === '/api/v1/workflows') return jsonResponse(WORKFLOWS)
      if (method === 'GET' && path === '/api/v1/skills') return jsonResponse(SKILLS)
      if (method === 'GET' && path === '/api/v1/providers/status') {
        return jsonResponse(PROVIDERS_CONNECTED)
      }
      if (path === '/api/v1/models?runner=claude') return jsonResponse({ runner: 'claude', models: [], source: 'unavailable', stale: false })
      if (method === 'GET' && path === '/api/v1/models?runner=codex') return jsonResponse({ runner: 'codex', models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }], source: 'live', stale: false })
      if (method === 'POST' && path === '/api/v1/runs') {
        return jsonResponse({
          id: 'run-1',
          title: 'queued',
          workflow: 'quick-task',
          task: 't',
          status: RUN_STATUS.queued,
          createdAt: '2026-07-15T08:00:00.000Z',
          tokensUsed: 0,
          archived: false,
          steps: [],
        })
      }
      // The tab reads `capabilities.automations` (#801). The catch-all below answers `{}`, which
      // is not a health payload at all — a reader would crash on it rather than degrade — so the
      // default here is a real one, with automations off exactly as a default server reports.
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health(['claude']))
      return jsonResponse({})
    }),
  )
  return sent
}

export function renderAt(entry: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/p/:projectId/tasks/:id" element={<p>Task destination</p>} />
          <Route path="/github" element={<GithubRoute view="issues" index />} />
          <Route path="/github/prs" element={<GithubRoute view="prs" />} />
          <Route path="/github/issues/:n" element={<GithubRoute view="issues" />} />
          <Route path="/github/prs/:n" element={<GithubRoute view="prs" />} />
          <Route path="/github/prs/:n/changes" element={<GithubRoute view="prs" changes />} />
          <Route path="/p/:projectId/github" element={<GithubRoute view="issues" index />} />
          <Route path="/p/:projectId/github/prs" element={<GithubRoute view="prs" />} />
          <Route path="/p/:projectId/github/issues/:n" element={<GithubRoute view="issues" />} />
          <Route path="/p/:projectId/github/prs/:n" element={<GithubRoute view="prs" />} />
          <Route path="/p/:projectId/github/prs/:n/changes" element={<GithubRoute view="prs" changes />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

export function renderGithubInMain(): HTMLElement {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/github']}>
        <main data-slot="main">
          <Routes>
            <Route path="/github" element={<GithubRoute view="issues" index />} />
          </Routes>
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return document.querySelector<HTMLElement>('[data-slot="main"]')!
}

export const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-row"]')]

export const detail = () => document.querySelector('[data-slot="gh-detail-inner"]')

export const ghList = () => document.querySelector<HTMLElement>('[data-slot="gh-list"]')!

export const ghListHandle = () => document.querySelector<HTMLElement>('[data-slot="gh-list-resize-handle"]')!

export const promptField = () =>
  document.querySelector<HTMLTextAreaElement>('[data-slot="gh-custom-prompt"]')!

export const promptValue = () => promptField().value

export function dragGithubList(from: number, to: number) {
  const handle = ghListHandle()
  handle.setPointerCapture = vi.fn()
  handle.releasePointerCapture = vi.fn()
  handle.hasPointerCapture = vi.fn(() => true)
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: from })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: to })
}

export async function changesRequested(sent: SentRequest[], n: number) {
  await waitFor(() => expect(sent.map((request) => request.path)).toContain(`/api/v1/github/prs/${n}/changes`), { timeout: 10_000 })
}

export const BASE = githubTaskRef(ISSUE_142)

export const baseWith = (extra: string) => `${BASE}\n\n${extra}`

export async function openDetail(entry = '/github/issues/142') {
  renderAt(entry)
  await waitFor(() => expect(document.querySelector('[data-slot="gh-hand"]')).not.toBeNull())
}

export const health = (backends: readonly Runner[]): HealthResponse => ({
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  checks: backends.map((name) => ({ name, available: true })),
  defaultRunner: backends[0] ?? 'claude',
  forge: null,
  capabilities: { localHandoff: true, settingsAdmin: true, remoteSettingsAdmin: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, automations: false, preview: false, voice: false },
})

export const MULTI_BACKEND = () => jsonResponse(health(['claude', 'codex']))

export const SINGLE_BACKEND = () => jsonResponse(health(['claude']))

export async function pickPill(slot: string, label: string) {
  fireEvent.pointerDown(document.querySelector(`[data-slot="${slot}"]`)!)
  // A discovery runner's options arrive with its catalog (#794), so wait for the labelled
  // option rather than merely for the menu to open.
  let option: HTMLElement | undefined
  await waitFor(() => {
    option = screen.getAllByRole('menuitemradio').find((o) => o.textContent?.includes(label))
    expect(option).toBeDefined()
  })
  fireEvent.click(option as HTMLElement)
}

export const postedRun = (sent: readonly SentRequest[]) =>
  sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body

export const waitForAgentRunEnabled = () =>
  waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /Run agent on this/ }).disabled,
    ).toBe(false),
  )

export async function selectSkill(name: string): Promise<void> {
  const chip = `[data-slot="gh-skill-chip"][data-skill="${name}"]`
  const opt = `[data-slot="gh-skill-option"][data-skill="${name}"]`
  if (!document.querySelector(chip) && !document.querySelector(opt)) {
    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
  }
  await waitFor(() => {
    if (document.querySelector(chip)) return
    const node = document.querySelector<HTMLElement>(opt)
    if (node) fireEvent.click(node)
    throw new Error(`skill "${name}" not selected yet`)
  })
}

export const compactHiddenFlags = () =>
  rows().map((row) => row.closest('[data-slot="gh-row-item"]')?.hasAttribute('data-compact-hidden') ?? false)
