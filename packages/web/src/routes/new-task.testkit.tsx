import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Suspense, lazy } from 'react'
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { expect, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import type { AgentProfilesResponse, ConfigResponse, HealthResponse, ProviderStatusResponse, RepoResponse, Skill, WorkspaceConfigResponse, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster } from '@/components/ui/toaster'
import { answerFixture, answerFromRoutes, jsonResponse, type FetchRoute } from '@/test/fetch-routes'
import { readDraft, writeDraft } from './new-task-draft'
import { NewTaskRoute } from './new-task'
import { TaskPreviewLayout } from './task-thread/preview/task-preview-layout'

export const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  defaultRunner: 'claude',
  checks: [
    { name: 'claude', available: true, version: '2.0.44' },
    { name: 'git', available: true, version: '2.43.0' },
  ],
  forge: null,
  capabilities: { localHandoff: true, settingsAdmin: true, remoteSettingsAdmin: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, automations: false, preview: false, voice: false },
}

export const HEALTH_MULTI: HealthResponse = {
  ...HEALTH,
  checks: [
    { name: 'claude', available: true },
    { name: 'codex', available: true },
    { name: 'git', available: true },
  ],
}

export const HEALTH_ALL: HealthResponse = {
  ...HEALTH,
  checks: [
    { name: 'claude', available: true },
    { name: 'codex', available: true },
    { name: 'opencode', available: true },
    { name: 'git', available: true },
  ],
}

export const HEALTH_NO_GIT: HealthResponse = {
  ...HEALTH,
  repo: null,
  checks: [{ name: 'claude', available: true }],
}

export const PROVIDERS_CONNECTED: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
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
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
}

export const SKILLS: Skill[] = [
  { name: 'om-fix', description: 'Fix an issue end to end', body: '', path: '/p/om-fix.md', source: 'ai' },
  { name: 'deploy', description: 'Deploy from anywhere', body: '', path: '/g/deploy.md', source: 'global' },
]

export const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    { name: 'quick-task', description: 'Single step, no gates', source: 'built-in', steps: [] },
    { name: 'fix-and-verify', source: 'built-in', steps: [] },
  ],
  issues: [],
}

export const REPO = {
  info: { root: '/repo', branch: 'main' },
  status: [],
  log: [],
  branches: ['main', 'develop'],
  baseBranch: null,
  tracking: null,
} satisfies RepoResponse

export const REPO_NO_GIT: RepoResponse = { info: null, status: [], log: [], branches: [], baseBranch: null, tracking: null }

export const CONFIG: ConfigResponse = {
  archiveOnMerge: null,
  effectiveArchiveOnMerge: false,
  archiveOnMergeSource: 'default',
  baseBranch: null,
  defaultRunner: 'claude',
  systemPrompt: null,
  defaultModels: {},
  modelsLocked: false,
  maxParallel: 2,
  memoryLimitMb: null,
  worktreeRetention: 10,
  liveTitleUpdates: null,
  reviewGate: null,
  worktreeSetup: null,
  worktreeSetupIssue: null,
}

export const WORKSPACE_CONFIG: WorkspaceConfigResponse = {
  agentDefaults: {},
  browseRoot: '~/',
  projectsDir: '~/cezar/projects',
  archiveOnMerge: null,
  effectiveArchiveOnMerge: false,
  archiveOnMergeSource: 'default',
  composerDefaults: {
    autonomous: null,
    worktree: null,
    inheritedAutonomous: 'source-dependent',
    inheritedWorktree: true,
  },
  resources: {
    maxParallel: 2,
    maxMonitoringSessions: 2,
    monitoringWakeIntervalMinutes: null,
    autoResumeOnUsageLimit: true,
    memoryLimitMb: null,
    worktreeRetentionDefault: 10,
  },
}

export const PLAN = {
  steps: [
    { id: 'implement', name: 'Implement', prompt: '{{task}}' },
    { id: 'verify', name: 'Verify', command: 'npm test' },
    { id: 'review', name: 'Review', skill: 'om-fix', prompt: 'Review the changes for {{task}}' },
  ],
  rationale: 'Implement, verify with tests, then review.',
  fallback: false,
}

export const FALLBACK_PLAN = {
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  rationale: 'planner unavailable — single-step plan',
  fallback: true,
}

export type Recorded = { method: string; url: string; body?: unknown }

export let requests: Recorded[]

export function deferredJson<T>() {
  let resolve!: (response: Response) => void
  return {
    fetch: () => new Promise<Response>((done) => { resolve = done }),
    release: (payload: T) =>
      resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  }
}

export function serve(overrides: {
  health?: HealthResponse | (() => Promise<Response>)
  /** Active project's scoped config; health may describe a different boot project. */
  config?: Partial<ConfigResponse> | (() => Promise<Response>)
  workspaceConfig?: WorkspaceConfigResponse
  /** Host authentication state, or a delayed answer for pending/refresh tests. */
  providerStatus?: ProviderStatusResponse | (() => Promise<Response>)
  providerStatusStatus?: number
  models?: unknown
  skills?: Skill[]
  workflows?: WorkflowsResponse
  /** `GET /api/v1/repo` — a payload, or a handler for a delayed answer. */
  repo?: RepoResponse | (() => Promise<Response>) | undefined
  uiState?: Record<string, unknown>
  /** Non-2xx `GET /api/v1/ui-state` answers (the query-errored path: `data` stays undefined). */
  uiStateStatus?: number
  createRun?: unknown
  /** Non-2xx `POST /api/v1/runs` answers (the auto-start failure path). */
  createRunStatus?: number
  /** What `GET /api/v1/launch-key` answers — the bookmarklet auto-start secret. */
  launchKey?: string
  /** `POST /api/v1/plan` — a payload, or a handler for delayed/failing answers. */
  plan?: unknown | (() => Promise<Response>)
  /** `POST /api/v1/workflows` — answers in call order (409-then-201 for the overwrite flow). */
  saveWorkflow?: Array<{ status: number; body: unknown }>
  /** Agent accounts (spec 2026-07-29-agent-profiles). Omitted answers a 404, which is how every
   *  pre-existing test here keeps a composer with no account pill at all. */
  agentProfiles?: AgentProfilesResponse
  /** `GET /api/v1/projects`. Omitted answers a 404 — no registry, so no task webhook (#589). */
  projects?: unknown
} = {}) {
  const data = {
    health: HEALTH,
    config: CONFIG,
    workspaceConfig: WORKSPACE_CONFIG,
    providerStatus: PROVIDERS_CONNECTED,
    providerStatusStatus: 200,
    models: {
      runner: 'codex',
      models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }],
      source: 'live',
      stale: false,
    },
    skills: SKILLS,
    workflows: WORKFLOWS,
    repo: REPO,
    uiState: {},
    uiStateStatus: 200,
    createRun: { id: 'r1' },
    createRunStatus: 201,
    launchKey: 'k-real',
    plan: PLAN,
    saveWorkflow: [{ status: 201, body: { path: '.ai/cezar/workflows/my-chain.yaml', name: 'my chain' } }],
    ...overrides,
  }
  requests = []
  let saves = 0
  // Tried in order. A route without a method answers every method. `projects` and
  // `agentProfiles` answer `undefined` until a test sets them, which falls through to the 404.
  const routes: FetchRoute<Recorded>[] = [
    { path: '/api/v1/health', respond: () => answerFixture(data.health) },
    { path: '/api/v1/providers/status', respond: () => answerFixture(data.providerStatus, data.providerStatusStatus) },
    { path: '/api/v1/models?runner=claude', respond: () => jsonResponse({ runner: 'claude', models: [], source: 'unavailable', stale: false }) },
    { path: '/api/v1/models?runner=codex', respond: () => jsonResponse(data.models) },
    { path: '/api/v1/skills', respond: () => jsonResponse(data.skills) },
    { method: 'GET', path: '/api/v1/workflows', respond: () => jsonResponse(data.workflows) },
    {
      method: 'POST',
      path: '/api/v1/workflows',
      respond: () => {
        const answer = data.saveWorkflow[Math.min(saves, data.saveWorkflow.length - 1)]!
        saves += 1
        return jsonResponse(answer.body, answer.status)
      },
    },
    { method: 'POST', path: '/api/v1/plan', respond: () => answerFixture(data.plan) },
    { path: '/api/v1/repo', respond: () => answerFixture(data.repo) },
    { path: '/api/v1/launch-key', respond: () => jsonResponse({ key: data.launchKey }) },
    { method: 'GET', path: '/api/v1/ui-state', respond: () => jsonResponse(data.uiState, data.uiStateStatus) },
    { method: 'PUT', path: '/api/v1/ui-state', respond: ({ body }) => jsonResponse(body ?? {}) },
    { method: 'POST', path: '/api/v1/runs', respond: () => answerFixture(data.createRun, data.createRunStatus) },
    {
      method: 'GET',
      path: '/api/v1/config',
      respond: () => (typeof data.config === 'function' ? data.config() : jsonResponse({ ...CONFIG, ...data.config })),
    },
    {
      method: 'PUT',
      path: '/api/v1/config',
      respond: ({ body }) => jsonResponse({ baseBranch: (body as { baseBranch: string | null }).baseBranch, defaultRunner: 'claude' }),
    },
    { method: 'GET', path: '/api/v1/workspace/config', respond: () => jsonResponse(data.workspaceConfig) },
    { method: 'GET', path: '/api/v1/projects', respond: () => (data.projects ? jsonResponse(data.projects) : undefined) },
    {
      method: 'GET',
      path: '/api/v1/workspace/agent-profiles',
      respond: () => (data.agentProfiles ? jsonResponse(data.agentProfiles) : undefined),
    },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      const request: Recorded = { method, url, body }
      requests.push(request)
      return answerFromRoutes(routes, request, () => jsonResponse({ error: `unmocked ${method} ${url}` }, 404))
    }),
  )
}

export function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

export function renderNewTask(entry = '/new', suspendThread: false | 'outer' | 'inner' = false) {
  // Keep /new mounted while its outgoing transition suspends, as a cold thread chunk does.
  const PendingThread = lazy(() => new Promise<{ default: () => null }>(() => {}))
  const client = createQueryClient()
  const Router = suspendThread ? BrowserRouter : MemoryRouter
  if (suspendThread) window.history.replaceState(null, '', entry)
  const rendered = render(
    <QueryClientProvider client={client}>
      <Router initialEntries={[entry]}>
        <Link to="/new">New task</Link>
        <Suspense fallback={null}>
          <Routes>
            {suspendThread === 'outer' ? <Route path="/tasks/:id" element={<PendingThread />} /> : null}
            {suspendThread === 'inner' ? <Route path="/tasks/:id" element={<TaskPreviewLayout />}>
              <Route index element={<Suspense fallback={<div data-route="task-thread" />}><PendingThread /></Suspense>} />
            </Route> : null}
            <Route path="/new" element={<NewTaskRoute />} />
            <Route path="/p/:projectId/new" element={<NewTaskRoute />} />
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
        </Suspense>
        <LocationProbe />
        <Toaster />
      </Router>
    </QueryClientProvider>,
  )
  return { ...rendered, client }
}

export const textarea = () => screen.getByLabelText('Describe a task for the agent') as HTMLTextAreaElement

export const sourcePill = () => screen.getByRole('button', { name: 'Choose a skill or workflow' })

export const location = () => screen.getByTestId('location').textContent

export const draftSource = (source: { source: 'skill' | 'workflow'; ref: string }) =>
  writeDraft({ ...readDraft(), source })

export async function pillReady(label = 'Skill') {
  await waitFor(() => {
    expect(sourcePill().textContent).toContain(label)
    expect(textarea().disabled).toBe(false)
  })
}

export const startTask = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/runs')).toBe(true))
}

export const postedBody = () => requests.find((r) => r.method === 'POST' && r.url === '/api/v1/runs')?.body

export const planToggle = () => screen.getByRole('radio', { name: /Plan first|Planning…/ })

export const startToggle = () => screen.getByRole('radio', { name: 'Start' })

export const stepIds = () =>
  [...document.querySelectorAll('[data-slot="plan-step"]')].map((el) =>
    el.getAttribute('data-step-id'),
  )

export async function planTask(text = 'Tighten the flaky suite') {
  await pillReady()
  fireEvent.click(planToggle())
  fireEvent.change(textarea(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Plan task' }))
  await screen.findByText('Proposed chain')
}

export const ACCOUNTS: AgentProfilesResponse = {
  defaults: {},
  editable: true,
  profileCapableProviders: ['claude', 'codex'],
  selections: {},
  profiles: [
    {
      id: 'default',
      provider: 'claude',
      label: 'Default',
      configDir: '/home/u/.claude',
      path: '/home/u/.claude',
      exists: true,
      looksValid: true,
      isDefault: true,
      status: { provider: 'claude', status: 'connected' },
      files: [],
    },
    {
      id: 'klaudiusz',
      provider: 'claude',
      label: 'Klaudiusz',
      configDir: '~/.claude-klaudiusz',
      path: '/home/u/.claude-klaudiusz',
      exists: true,
      looksValid: true,
      isDefault: false,
      status: { provider: 'claude', status: 'connected', profileId: 'work' },
      files: [],
    },
  ],
}

export const runnerPill = () => document.querySelector('[data-slot="runner-pill"]') as HTMLElement | null

export const pickFrom = async (pill: HTMLElement, match: string) => {
  fireEvent.pointerDown(pill)
  const options = await screen.findAllByRole('menuitemradio')
  fireEvent.click(options.find((o) => o.textContent?.includes(match)) as HTMLElement)
}
