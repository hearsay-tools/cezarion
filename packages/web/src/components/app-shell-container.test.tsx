import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { workspaceQueryKeys } from '@/api/queries'
import type {
  HealthResponse,
  ProviderStatusResponse,
  RunRecord,
  SkillsUpdateState,
} from '@open-mercato/cezar-api-client'
import { AppShellContainer, repoChipOf, skillsUpdateMarkerOf } from '@/components/app-shell-container'
import { ThemeProvider } from '@/components/theme-provider'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  document.title = 'cezar'
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships no matchMedia; the shell's breakpoint effect and the theme toggle need one.
  // md-and-up is the desktop shell (the project rail reads it); every other query stays false.
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: query === '(min-width: 768px)', addEventListener: () => {}, removeEventListener: () => {} }),
  )
})

afterEach(() => {
  cleanup()
  setApiScope(null)
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'feat/cockpit', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false },
}

/** One registered project — the degenerate workspace every existing install upgrades into. */
const PROJECT = {
  id: 'cezar',
  name: 'cezar',
  root: '/home/me/Projects/cezar',
  addedAt: '2026-07-01T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T12:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
  branch: 'main',
}

const TODOS = [
  { id: 't1', summary: 'Review the PR' },
  { id: 't2', summary: 'Rebase the branch' },
]

const PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

/** Answer each endpoint the shell reads; anything else 404s loudly rather than silently
 *  resolving to `{}` and making a broken wiring look fine. */
function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    const response =
      path === '/api/v1/providers/status'
        ? (routes[path] ?? PROVIDERS)
        : path === '/api/v1/workspace/ui-state'
          ? (routes[path] ?? {})
          : routes[path]
    if (response === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    if (response instanceof Response) return response
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderShell(entry = '/', client: QueryClient = createQueryClient()) {
  return {
    client,
    ...render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShellContainer>
            <p>route content</p>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
    ),
  }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    title: 'Raw task prompt',
    titleSummary: 'Implement page titles',
    workflow: 'quick-task',
    task: 'Implement page titles',
    status: 'running',
    createdAt: '2026-07-21T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  }
}

const repoChip = () => document.querySelector('[data-slot="project-header-name"]')
const versionChip = () => document.querySelector('[data-slot="version-chip"]')
// The desktop column only: below `md` the mobile tab bar renders the same view names (jsdom has no
// media queries, so both trees are in the DOM), and these cases are about the sidebar's gating.
const inSidebar = () => within(document.querySelector('[data-slot="sidebar"]') as HTMLElement)
const navBadge = () => document.querySelector('[data-slot="overflow-inbox-dot"]')

describe('repoChipOf', () => {
  it.each([
    { name: 'a plain root', root: '/home/me/Projects/cezar', expected: 'cezar' },
    { name: 'a trailing slash', root: '/home/me/cezar/', expected: 'cezar' },
    { name: 'a windows path', root: 'C:\\Users\\me\\cezar', expected: 'cezar' },
    { name: 'the filesystem root as a repo', root: '/', expected: null },
  ])('takes the basename of $name', ({ root, expected }) => {
    const chip = repoChipOf({ ...HEALTH, repo: { root, branch: 'main' } })
    expect(chip?.name ?? null).toBe(expected)
  })

  it('is null while health is unknown, and outside a git repo', () => {
    expect(repoChipOf(undefined)).toBeNull()
    expect(repoChipOf({ ...HEALTH, repo: null })).toBeNull()
  })
})

const UPDATE: SkillsUpdateState = {
  status: 'available', available: true, autoUpdateEnabled: true, inherited: true,
  checkedAt: '2026-07-22T00:00:00.000Z', updatedAt: null, scopes: [], needsUpgradeNotes: false,
}

describe('skillsUpdateMarkerOf', () => {
  it.each([
    ['loading', undefined, false],
    ['available', UPDATE, true],
    ['proven available with an error', { ...UPDATE, status: 'error' as const }, true],
    ['current', { ...UPDATE, status: 'current' as const, available: false }, false],
    ['unavailable', { ...UPDATE, status: 'unavailable' as const, available: false }, false],
    ['updating', { ...UPDATE, status: 'updating' as const }, false],
  ])('%s → %s', (_name, state, expected) => {
    expect(skillsUpdateMarkerOf(state)).toBe(expected)
  })
})

describe('sidebar wiring', () => {
  it('renders the repo and version chips from /api/v1/health', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(repoChip()?.textContent).toBe('cezar'))
    // Basename of the root, then the branch — not the whole path.
    expect(repoChip()?.textContent).toBe('cezar')
    expect(versionChip()?.textContent).toBe('v0.1.3')
  })

  it('renders the inbox badge from /api/v1/todos', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': TODOS })
    renderShell()

    await waitFor(() => expect(navBadge()).not.toBeNull())
    fireEvent.keyDown(screen.getByRole('button', { name: 'More views' }), { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: /Inbox/ })).textContent).toBe('Inbox2')
  })

  // #471 — the global inbox is opt-in; the shell must not offer what the server cannot fill.
  it('drops the Inbox nav item and its badge when the server has follow-ups off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Inbox/ })).toBeNull()
    expect(navBadge()).toBeNull()
    // Every other view is untouched — the gate owns exactly one item.
    expect(inSidebar().getByRole('link', { name: /Tasks/ })).toBeTruthy()
    expect(inSidebar().getByRole('link', { name: /Settings/ })).toBeTruthy()
  })

  it('never asks for todos on a server with the inbox off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // The badge query is keyed on the capability, so it never runs — unlike the /inbox route,
    // nothing here needs the list before health has spoken.
    const asked = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(asked).not.toContain('/api/v1/todos')
  })

  // #801 — the same honesty rule for the opt-in automations capability. Both cases carry a
  // reachable forge, so the ONLY thing deciding the Automations item here is the capability:
  // before the flag, every project with a GitHub remote saw that tab.
  const WITH_FORGE = { ...HEALTH, forge: { kind: 'github' as const, available: true } }

  it('drops the Automations nav item when the server has automations off', async () => {
    serve({ '/api/v1/health': WITH_FORGE, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Automations/ })).toBeNull()
    // The gate owns exactly one item — GitHub is forge-gated, not automations-gated.
    expect(inSidebar().getByRole('link', { name: /GitHub/ })).toBeTruthy()
  })

  it('shows the Automations nav item once health reports the capability', async () => {
    serve({
      '/api/v1/health': { ...WITH_FORGE, capabilities: { ...HEALTH.capabilities, automations: true } },
      '/api/v1/todos': [],
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    fireEvent.keyDown(screen.getByRole('button', { name: 'More views' }), { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Automations' })).toBeTruthy()
  })

  it('renders no badge for an empty inbox', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // Zero follow-ups is not "0 follow-ups" — a badge reading 0 is noise the spec's chrome
    // rules do not want.
    expect(navBadge()).toBeNull()
  })

  it('shows no chips at all while health has not answered', () => {
    // A never-resolving fetch: the pending state, held.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderShell()

    expect(repoChip()?.textContent).toMatch(/Loading project|Project unavailable/)
    expect(versionChip()).toBeNull()
    expect(navBadge()).toBeNull()
    // …and the app itself is up. The chips being empty is not a loading screen.
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  })

  it('shows no chips when the server is unreachable, and still renders the app', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    renderShell()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The honest empty state: cezar cannot answer what repo it is on, so it says nothing.
    // It does not invent one, and it does not take the whole cockpit down with it.
    expect(repoChip()?.textContent).toMatch(/Loading project|Project unavailable/)
    expect(versionChip()).toBeNull()
    expect(screen.getByText('route content')).toBeTruthy()
  })

  // CEZ_SINGLE_PROJECT pins this response to the boot row even when the saved registry has more.
  // The shell must collapse from that ordinary one-row response, not grow a second capability
  // branch for navigation: flat nav, one quick-list, repo chip, no group headers.
  it('uses a project card when single-project mode pins the registry to the boot project', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(repoChip()?.textContent).toBe('cezar'))
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="project-header"]')).toHaveLength(1)
  })

  it('hides add-project chrome when health reports single-project mode', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(inSidebar().getByRole('link', { name: /New task/ })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
  })

  it('renders one current-project sidebar with both projects on the rail', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
        bootProject: 'cezar',
        projectsDir: '/home/me/cezar/projects',
      },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/p/cezar/runs': [],
    })
    renderShell()

    await waitFor(() => expect(document.querySelectorAll('[data-slot="rail-project"]')).toHaveLength(2))
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(document.querySelector('[data-slot="task-quick-list"]')).not.toBeNull()
    expect(repoChip()?.textContent).toBe('cezar')
  })

  it('scopes overflow views to the only project', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, followups: true, automations: true },
      },
      '/api/v1/todos': TODOS,
      '/api/v1/projects': { projects: [{ ...PROJECT, forge: 'github' }], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell('/p/cezar/')
    await waitFor(() => expect(repoChip()?.textContent).toBe('cezar'))
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'More views' }), { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: /Inbox/ })).getAttribute('href')).toBe('/p/cezar/inbox')
    expect(screen.getByRole('menuitem', { name: 'Automations' }).getAttribute('href')).toBe('/p/cezar/automations')
  })

  it('scopes overflow views to the current project in a workspace', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, followups: true, automations: true },
      },
      '/api/v1/todos': TODOS,
      '/api/v1/projects': {
        projects: [
          { ...PROJECT, forge: 'github' },
          { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z', forge: 'github' },
        ],
        bootProject: 'cezar',
        projectsDir: '/home/me/cezar/projects',
      },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/p/cezar/runs': [],
    })
    renderShell('/p/cezar/')
    await waitFor(() => expect(repoChip()?.textContent).toBe('cezar'))
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'More views' }), { key: 'Enter' })
    expect((await screen.findByRole('menuitem', { name: /Inbox/ })).getAttribute('href')).toBe('/p/cezar/inbox')
    expect(screen.getByRole('menuitem', { name: 'Automations' }).getAttribute('href')).toBe('/p/cezar/automations')
  })

  it('keeps the archive filter beside the current project tasks', async () => {
    const active = run({ id: 'active-session', titleSummary: 'Current session' })
    const archived = run({ id: 'archived-session', titleSummary: 'Archived session', status: 'done', archived: true })
    serve({
      '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop' }],
        bootProject: 'cezar', projectsDir: '/projects',
      },
      '/api/v1/runs': [active, archived],
      '/api/v1/p/cezar/runs': [active, archived],
      '/api/v1/workspace/ui-state': {},
    })
    renderShell('/p/cezar/new')
    await screen.findByRole('link', { name: /Current session/ })
    const archivedTab = await screen.findByRole('button', { name: /^Archived/ })
    const tree = document.querySelector('[data-slot="project-task-navigation"]')!
    expect(tree.contains(archivedTab)).toBe(true)
    fireEvent.click(archivedTab)
    await waitFor(() => expect(document.querySelector('[data-run-id="archived-session"]')).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Current session/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Active/ }))
    await waitFor(() => expect(document.querySelector('[data-run-id="active-session"]')).not.toBeNull())
  })

  it('counts only current-project sessions in Active/Archived', async () => {
    localStorage.setItem('cez-sidebar-collapsed', JSON.stringify({ shop: false }))
    const bootActive = run({ id: 'boot-active', titleSummary: 'Boot active' })
    const shopWaiting = run({ id: 'shop-wait', titleSummary: 'Shop waiting', status: 'waiting' })
    serve({
      '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
        bootProject: 'cezar',
        projectsDir: '/projects',
      },
      '/api/v1/runs': [bootActive],
      '/api/v1/p/cezar/runs': [bootActive],
      '/api/v1/p/shop/runs': [shopWaiting],
      '/api/v1/workspace/ui-state': {},
    })
    renderShell('/p/cezar/new')
    await screen.findByRole('link', { name: /Boot active/ })
    expect(screen.queryByRole('link', { name: /Shop waiting/ })).toBeNull()
    const list = within(document.querySelector('[data-slot="quick-list"]') as HTMLElement)
    expect(list.getByRole('button', { name: /^Active/ }).textContent).toContain('1')
    expect(list.getByRole('button', { name: /^Archived/ }).textContent).toBe('Archived')
    localStorage.removeItem('cez-sidebar-collapsed')
  })

  it('shows the version chip even outside a git repo', async () => {
    serve({ '/api/v1/health': { ...HEALTH, repo: null }, '/api/v1/todos': [] })
    renderShell()

    // Running cezar outside a repo is supported: no repo chip, but the rest of the chrome is
    // real and must not vanish with it.
    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(versionChip()?.textContent).toBe('v0.1.3')
    expect(repoChip()?.textContent).toMatch(/Loading project|Project unavailable/)
  })

  it('wires the provider query into the AppShell banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'not-installed', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true },
        ],
      },
    })
    renderShell('/p/cezar/')

    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('No agent provider credentials were found.')
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(banner)).toBe(true)
  })

  it('shows a runtime authentication incident in the global banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
        ],
      },
    })
    renderShell('/p/cezar/')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'Provider authentication failed during a task: OpenCode.',
    )
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(alert)).toBe(true)
  })

  it('keeps the shell and route content when provider status fails', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 }),
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the shell and route content when a successful provider response is malformed', async () => {
    const secret = 'unexpected-provider-payload'
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': { providers: [null, { provider: 'future', status: secret }] },
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(secret)).toBeNull()
  })
})

describe('document title wiring', () => {
  const REGISTRY = {
    projects: [PROJECT],
    bootProject: 'cezar',
    projectsDir: '/home/me/cezar/projects',
  }
  const HEALTH_WITH_BOOT = { ...HEALTH, bootProject: 'cezar' }

  it('combines the selected project with scoped page context', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
    })
    renderShell('/p/shop/git')

    await waitFor(() => expect(document.title).toBe('Storefront — Git · cezar'))
  })

  it('falls back to the boot repository name when the registry is unavailable', async () => {
    serve({ '/api/v1/health': HEALTH_WITH_BOOT, '/api/v1/todos': [], '/api/v1/runs': [] })
    renderShell('/p/cezar/')

    await waitFor(() => expect(document.title).toBe('cezar — Tasks · cezar'))
  })

  it('keeps global settings and a no-repo task route free of invented project context', async () => {
    serve({
      '/api/v1/health': { ...HEALTH_WITH_BOOT, repo: null },
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    const global = renderShell('/settings/global/projects')

    await waitFor(() => expect(document.title).toBe('Settings · cezar'))
    global.unmount()

    renderShell('/tasks/missing')
    await waitFor(() => expect(document.title).toBe('cezar'))
  })

  it('updates after in-app navigation without remounting the shell', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    renderShell('/p/cezar/')

    await waitFor(() => expect(document.title).toBe('cezar — Tasks · cezar'))
    fireEvent.click(inSidebar().getByRole('link', { name: 'Git' }))
    await waitFor(() => expect(document.title).toBe('cezar — Git · cezar'))
  })

  it('reacts to live project and task title cache updates', async () => {
    const initialRun = run()
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
      '/api/v1/p/shop/runs': [initialRun],
    })
    const { client } = renderShell('/p/shop/tasks/run-1')

    await waitFor(() =>
      expect(document.title).toBe('Storefront — Implement page titles · cezar'),
    )

    act(() => {
      client.setQueryData(workspaceQueryKeys.projects, {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Renamed storefront' }],
      })
      client.setQueryData(['shop', 'runs', 'list'], [
        { ...initialRun, titleSummary: 'Rename browser titles' },
      ])
    })

    await waitFor(() =>
      expect(document.title).toBe('Renamed storefront — Rename browser titles · cezar'),
    )
  })
})

// #618 — the project rail, wired to the registry, health and the SSE-patched runs index.
describe('project rail wiring', () => {
  const indexRow = (overrides: Record<string, unknown>) => ({
    projectId: 'cezar',
    id: 'r1',
    title: 'A task',
    status: 'running',
    hasPendingHumanAsk: false,
    createdAt: '2026-07-21T12:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  })
  const railIndex = (runs: unknown[], truncated: string[] = []) => ({
    runs,
    referenceStatuses: {},
    perProjectLimit: 200,
    truncated,
  })
  const TWO_PROJECTS = {
    projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
    bootProject: 'cezar',
    projectsDir: '/home/me/cezar/projects',
  }
  const rail = () => screen.findByRole('navigation', { name: 'Projects' })
  const railMark = (id: string) => document.querySelector(`[data-slot="rail-project"][data-project-id="${id}"]`) as HTMLElement

  it('rail activation opens only that project, including repeated current-project clicks', async () => {
    localStorage.setItem('cez-sidebar-collapsed', JSON.stringify({ cezar: false, shop: true, third: false }))
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': { ...TWO_PROJECTS, projects: [...TWO_PROJECTS.projects, { ...PROJECT, id: 'third', name: 'third' }] },
      '/api/v1/workspace/runs-index': railIndex([]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
      '/api/v1/p/third/runs': [],
    })
    renderShell('/p/cezar/')
    await rail()
    const selectShop = () => fireEvent.click(within(railMark('shop')).getByRole('link'))
    selectShop()
    await waitFor(() => expect(repoChip()?.textContent).toBe('shop'))
    expect(within(railMark('shop')).getByRole('link').getAttribute('aria-current')).toBe('page')
    expect(document.querySelectorAll('[data-slot="project-header"]')).toHaveLength(1)
    selectShop()
    expect(repoChip()?.textContent).toBe('shop')
    localStorage.removeItem('cez-sidebar-collapsed')
  })

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }])(
    'modified rail clicks leave this window’s groups alone (%j)', async (modifier) => {
      localStorage.setItem('cez-sidebar-collapsed', JSON.stringify({ cezar: false, shop: true }))
      serve({
        '/api/v1/health': HEALTH,
        '/api/v1/todos': [],
        '/api/v1/projects': TWO_PROJECTS,
        '/api/v1/workspace/runs-index': railIndex([]),
        '/api/v1/runs': [],
        '/api/v1/p/cezar/runs': [],
      })
      renderShell('/p/cezar/')
      await rail()
      try {
        fireEvent.click(within(railMark('shop')).getByRole('link'), modifier)
        expect(JSON.parse(localStorage.getItem('cez-sidebar-collapsed')!)).toEqual({ cezar: false, shop: true })
        expect(repoChip()?.textContent).toBe('cezar')
      } finally {
        localStorage.removeItem('cez-sidebar-collapsed')
      }
    },
  )

  it('lights the top pill of a non-current project that has a run waiting on you', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': TWO_PROJECTS,
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([indexRow({ projectId: 'shop', id: 's1', status: 'waiting' })]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    renderShell('/p/cezar/')

    await rail()
    await waitFor(() => expect(railMark('shop').querySelector('[data-slot="rail-pill-top"]')).not.toBeNull())
    const segment = railMark('shop').querySelector('[data-segment="amber"]')
    expect(segment?.textContent).toBe('1')
    // The current project reads the same index and has nothing to say.
    expect(railMark('cezar').querySelector('[data-slot="rail-pill-top"]')).toBeNull()
    expect(within(railMark('shop')).getByRole('link').getAttribute('aria-label')).toBe('shop · 1 needs you')
  })

  it('shrinks a pill when the index says the run was opened, with no reload', async () => {
    const done = indexRow({ id: 'd1', status: 'done', finishedAt: '2026-07-21T13:00:00.000Z' })
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': TWO_PROJECTS,
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([done]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    const { client } = renderShell('/p/shop/')

    await waitFor(() => expect(railMark('cezar')?.querySelector('[data-segment="green"]')).not.toBeNull())

    act(() => {
      client.setQueryData(workspaceQueryKeys.runsIndex, railIndex([{ ...done, seenAt: '2026-07-21T14:00:00.000Z' }]))
    })

    await waitFor(() => expect(railMark('cezar').querySelector('[data-slot="rail-pill-bottom"]')).toBeNull())
  })

  it('says recent runs only for a project the index truncated', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': TWO_PROJECTS,
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([], ['shop']),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    renderShell('/p/cezar/')

    await rail()
    await waitFor(() =>
      expect(within(railMark('shop')).getByRole('link').getAttribute('aria-label')).toBe('shop · idle · recent runs only'),
    )
    expect(within(railMark('cezar')).getByRole('link').getAttribute('aria-label')).toBe('cezar · idle')
  })

  it('says the activity is unknown, not idle, when the runs index request fails', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': TWO_PROJECTS,
      '/api/v1/workspace/ui-state': {},
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    renderShell('/p/cezar/')

    await rail()
    await waitFor(() =>
      expect(within(railMark('shop')).getByRole('link').getAttribute('aria-label')).toBe('shop · activity unknown'),
    )
  })

  it('refreshes the runs index when a project is registered, so its mark does not stay blank', async () => {
    const indexCalls = () => fetchMock.mock.calls.filter(([input]) => String(input) === '/api/v1/workspace/runs-index').length
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    const { client } = renderShell('/p/cezar/')

    await waitFor(() => expect(railMark('cezar')).not.toBeNull())
    await waitFor(() => expect(indexCalls()).toBe(1))

    // A rename or reorder is not a new project: no refetch.
    act(() => {
      client.setQueryData(workspaceQueryKeys.projects, { ...TWO_PROJECTS, projects: [{ ...PROJECT, name: 'renamed' }] })
    })
    await waitFor(() => expect(railMark('cezar')).not.toBeNull())
    expect(indexCalls()).toBe(1)

    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': TWO_PROJECTS,
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([indexRow({ projectId: 'shop', id: 's1', status: 'waiting' })]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    act(() => {
      client.setQueryData(workspaceQueryKeys.projects, TWO_PROJECTS)
    })

    await waitFor(() => expect(railMark('shop')?.querySelector('[data-segment="amber"]')?.textContent).toBe('1'))
    expect(indexCalls()).toBe(2)
  })

  // #620: the phone paints the same signal (menu button pills, drawer rows), so the index is read
  // at every width, once.
  it('reads the runs index once below md and paints it on the menu button and the drawer rows', async () => {
    vi.stubGlobal(
      'matchMedia',
      () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    )
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': TWO_PROJECTS,
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([
        indexRow({ projectId: 'shop', id: 's1', status: 'waiting' }),
        indexRow({ projectId: 'shop', id: 's2', status: 'running' }),
        // The current project's own signal is not "elsewhere".
        indexRow({ projectId: 'cezar', id: 'c1', status: 'running' }),
      ]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    renderShell('/p/cezar/')

    const menu = await screen.findByRole('button', { name: 'Open projects. Elsewhere: 1 needs you, 1 working' })
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/v1/workspace/runs-index')).toHaveLength(1)
    // The project button never carries a count: it would read as the current project's.
    const picker = document.querySelector('[data-slot="mobile-project-picker"]') as HTMLElement
    expect(picker.querySelector('[data-segment]')).toBeNull()
    fireEvent.click(menu)
    const drawer = document.querySelector('[data-slot="mobile-nav-drawer"]') as HTMLElement
    const rows = within(drawer).getAllByRole('link').filter((link) => link.getAttribute('data-slot') === 'drawer-project')
    expect(rows.map((row) => row.getAttribute('data-project-id'))).toEqual(['cezar', 'shop'])
    expect(rows[0]!.getAttribute('aria-current')).toBe('page')
    expect(rows[1]!.querySelector('[data-slot="drawer-project-state"]')?.textContent).toBe('1 needs you·1 working')
  })

  // #621: the drawer no longer renders the sidebar footer, so the Tools row's amber dot and the
  // forge note are derived from the same health the desktop ToolsMenu reads.
  it('feeds the drawer Tools row from health: forge note and the amber blocker dot', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    const health = { ...HEALTH, checks: [{ name: 'claude', available: false, hint: 'install' }] } as unknown as HealthResponse
    serve({
      '/api/v1/health': health,
      '/api/v1/todos': [],
      '/api/v1/projects': TWO_PROJECTS,
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/shop/runs': [],
    })
    renderShell('/p/cezar/')
    fireEvent.click(await screen.findByRole('button', { name: /^Open projects/ }))
    const row = await waitFor(() => {
      const found = document.querySelector('[data-slot="mobile-nav-drawer"] [data-slot="drawer-tools"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(row.getAttribute('href')).toBe('/tools')
    expect(row.querySelector('[data-slot="drawer-tools-dot"]')).not.toBeNull()
    expect(row.querySelector('[data-slot="drawer-tools-note"]')?.textContent).toContain('No GitHub remote detected')
  })

  // The capability, not the project count: one registered project in the default multi-project
  // mode is the zero-config first run, and it must teach where projects live.
  it('keeps Add project and All projects on the rail with one project and the capability off', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
    })
    renderShell('/p/cezar/')

    const nav = await rail()
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'All projects' })).toBeTruthy())
    expect(within(nav).getByRole('button', { name: 'Add project' })).toBeTruthy()
    expect(nav.querySelectorAll('[data-slot="rail-project"]')).toHaveLength(1)
  })

  it('renders the rail without Add project and All projects when the capability is on', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { ...HEALTH.capabilities, singleProject: true } },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/workspace/runs-index': railIndex([]),
      '/api/v1/runs': [],
      '/api/v1/p/cezar/runs': [],
    })
    renderShell('/p/cezar/')

    const nav = await rail()
    await waitFor(() => expect(nav.querySelector('[data-slot="rail-app-mark"]')).not.toBeNull())
    await waitFor(() => expect(within(nav).getByAltText('Cezarion v0.1.3')).toBeTruthy())
    expect(within(nav).queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(within(nav).queryByRole('link', { name: 'All projects' })).toBeNull()
    expect(within(nav).getByRole('link', { name: 'Global settings' })).toBeTruthy()
  })
})

it('keeps sidebar data on the URL project when rendered above the route scope provider', async () => {
  setApiScope('previous')
  const client = createQueryClient()
  client.setQueryData(['previous', 'runs', 'list'], [run({ id: 'wrong', title: 'Previous project task', titleSummary: undefined })])
  client.setQueryData(['shop', 'runs', 'list'], [run({ id: 'right', title: 'Selected project task', titleSummary: undefined, status: 'waiting' })])
  serve({
    '/api/v1/health': HEALTH,
    '/api/v1/todos': [],
    '/api/v1/projects': { bootProject: 'cezar', projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'Shop' }] },
    '/api/v1/p/shop/runs': [run({ id: 'right', title: 'Selected project task', titleSummary: undefined, status: 'waiting' })],
  })
  renderShell('/p/shop/new', client)
  expect(await screen.findByText('Selected project task')).toBeTruthy()
  expect(screen.queryByText('Previous project task')).toBeNull()
  expect(document.querySelector('[data-slot="nav-needs-you-dot"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="task-row"] a')?.getAttribute('href')).toBe('/p/shop/tasks/right')
})

it('shows the Git view\'s task worktrees, read for the URL project, instead of the task list', async () => {
  setApiScope('previous')
  serve({
    '/api/v1/health': HEALTH,
    '/api/v1/todos': [],
    '/api/v1/projects': { bootProject: 'cezar', projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'Shop' }] },
    '/api/v1/p/shop/worktrees': { worktrees: [{ runId: 'wt-1', title: 'Shop worktree', status: 'review', branch: 'cez/wt-1', sizeBytes: null, finishedAt: null, reclaimable: false }], totalBytes: null, keep: 0 },
    '/api/v1/p/shop/runs': [run({ id: 'wt-1', title: 'Shop task', titleSummary: undefined, diffStat: { files: 1, adds: 4, dels: 2 } })],
  })
  renderShell('/p/shop/git')
  const row = await waitFor(() => {
    const el = document.querySelector('[data-slot="git-worktree-row"]')
    if (!el) throw new Error('no worktree row yet')
    return el
  })
  expect(row.getAttribute('href')).toBe('/p/shop/tasks/wt-1/changes')
  expect(row.textContent).toContain('cez/wt-1')
  expect(row.textContent).toContain('Shop task')
  expect(document.querySelector('[data-slot="quick-list"]')).toBeNull()
})

it.each(['/tasks', '/tools'])('keeps sidebar navigation on its displayed boot project from %s', async (entry) => {
  setApiScope('shop')
  serve({
    '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
    '/api/v1/todos': [],
    '/api/v1/projects': { bootProject: 'cezar', projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'Shop' }] },
    '/api/v1/p/cezar/runs': [run({ id: 'boot-task', title: 'Boot task', titleSummary: undefined })],
    '/api/v1/p/default/runs': [run({ id: 'boot-task', title: 'Boot task', titleSummary: undefined })],
  })
  renderShell(entry)
  expect(await screen.findByText('Boot task')).toBeTruthy()
  const sidebar = within(document.querySelector('[data-slot="sidebar"]') as HTMLElement)
  expect(sidebar.getByRole('link', { name: 'All' }).getAttribute('href')).toBe('/p/cezar/')
  expect(sidebar.getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/p/cezar/')
  expect(sidebar.getByRole('link', { name: 'Git' }).getAttribute('href')).toBe('/p/cezar/git')
  expect(sidebar.getByRole('link', { name: /New task/ }).getAttribute('href')).toBe('/p/cezar/new')
  expect(document.querySelector('[data-slot="task-row"] a')?.getAttribute('href')).toBe('/p/cezar/tasks/boot-task')
  // Publishing navigation context must not change the routed view's API scope.
  const { queryScope } = await import('@open-mercato/cezar-api-client')
  expect(queryScope()).toBe('shop')
})

it.each(['/p/shop/settings/agents', '/settings/global/appearance'])('shows scoped Settings groups instead of tasks at %s', async (entry) => {
  serve({
    '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
    '/api/v1/todos': [],
    '/api/v1/projects': { bootProject: 'cezar', projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'Shop' }] },
  })
  renderShell(entry)
  const project = entry.startsWith('/p/shop') ? 'shop' : 'cezar'
  const group = await screen.findByRole('navigation', { name: `This project · ${project === 'shop' ? 'Shop' : 'cezar'}` })
  expect(within(group).getByRole('link', { name: 'Agents' }).getAttribute('href')).toBe(`/p/${project}/settings/agents`)
  // Board: the body is the section lists only — no "General" row, no "Settings" heading.
  expect(within(group).queryByRole('link', { name: 'General' })).toBeNull()
  expect(document.querySelector('[data-slot="settings-sidebar"] h2')).toBeNull()
  expect([...group.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Agents', 'Agent config', 'Worktrees', 'Bookmarklets', 'Prompt templates'])
  const global = screen.getByRole('navigation', { name: 'Global · every project' })
  expect(within(global).getByRole('link', { name: 'Appearance' }).getAttribute('href')).toBe('/settings/global/appearance')
  expect([...global.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Appearance', 'Notifications', 'Resources', 'Skills', 'Agent accounts', 'Projects'])
  expect(within(global).queryByRole('link', { name: 'Keyboard' })).toBeNull()
  const selected = document.querySelector('[data-slot="settings-sidebar"] [aria-current="page"]')
  expect(selected?.getAttribute('href')).toBe(entry)
  expect(document.querySelector('[data-slot="task-quick-list"]')).toBeNull()
})

it('applies single-project visibility to the Settings sidebar', async () => {
  serve({
    '/api/v1/health': { ...HEALTH, capabilities: { ...HEALTH.capabilities, singleProject: true } },
    '/api/v1/todos': [],
    '/api/v1/projects': { bootProject: 'cezar', projects: [PROJECT] },
  })
  renderShell('/settings/global/resources')
  const group = await screen.findByRole('navigation', { name: 'Global · every project' })
  await waitFor(() => expect(within(group).queryByRole('link', { name: 'Projects' })).toBeNull())
  expect(within(group).getByRole('link', { name: 'Resources' }).getAttribute('aria-current')).toBe('page')
})

describe('GitHub view sidebar list (#622)', () => {
  const shop = { ...PROJECT, id: 'shop', name: 'Shop', forge: 'github' as const }
  const GH = { available: true, repo: 'acme/shop', viewerLogin: 'me', issues: [], prs: [] }

  it('replaces the task list with the GitHub filters, bound to the URL project rather than the stale scope', async () => {
    setApiScope(null)
    serve({
      '/api/v1/health': { ...HEALTH, forge: { available: true } },
      '/api/v1/todos': [],
      '/api/v1/projects': { bootProject: 'cezar', projects: [{ ...PROJECT, forge: 'github' }, shop] },
      '/api/v1/p/shop/github?limit=1000': GH,
      '/api/v1/p/shop/runs': [],
    })
    renderShell('/p/shop/github/prs?filter=review')
    const sidebar = await screen.findByRole('navigation', { name: 'Pull requests' })
    expect(document.querySelector('[data-slot="github-sidebar"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="task-quick-list"]')).toBeNull()
    expect(sidebar.querySelector('[data-gh-filter="review"]')?.getAttribute('aria-current')).toBe('page')
    expect(sidebar.querySelector('[data-gh-filter="mine"]')?.getAttribute('href')).toBe('/p/shop/github/prs?filter=mine')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/p/shop/github?limit=1000')).toBe(true))
    // The shell never asked another project's GitHub while the URL names Shop.
    expect(fetchMock.mock.calls.some(([url]) => /^\/api\/v1\/github\?/.test(String(url)))).toBe(false)
  })

  it('keeps the task list where GitHub has no sidebar list: other views and forge-less projects', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': { bootProject: 'cezar', projects: [PROJECT, { ...shop, forge: 'none' as const }] },
      '/api/v1/p/shop/runs': [],
    })
    renderShell('/p/shop/github')
    await waitFor(() => expect(document.querySelector('[data-slot="task-quick-list"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="github-sidebar"]')).toBeNull()
  })
})
