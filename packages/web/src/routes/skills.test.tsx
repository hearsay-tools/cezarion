import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { Skill, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * `/skills` (R6 Step 1.4): the catalog + detail against fixture payloads, the #377
 * ordering/bold rendering, the #384 refresh contract (selection and scroll survive), and the
 * bookmarklet panel's protected link generation. The pure rules themselves are pinned in
 * lib/skills.test.ts and lib/bookmarklet.test.ts — this file asserts the SURFACE honors them.
 */

// ---- fixtures --------------------------------------------------------------------------------

const skill = (over: Partial<Skill> & Pick<Skill, 'name' | 'source'>): Skill => ({
  body: `# ${over.name}\n\nBody of ${over.name}.`,
  path: `.ai/skills/${over.name}.md`,
  ...over,
})

// Deliberately listed global-first: the SECTION must reorder project-first (#377).
const SKILLS: Skill[] = [
  skill({
    name: 'zebra-global',
    source: 'global',
    path: '/home/u/.agents/skills/zebra-global/SKILL.md',
    description: 'A global skill',
  }),
  skill({ name: 'om-fix', source: 'ai', description: 'Fix an issue end to end' }),
  skill({ name: 'om-review', source: 'cezar', path: '.ai/cezar/skills/om-review.md' }),
]

const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    {
      name: 'fix-and-verify',
      source: 'file',
      steps: [{ id: 'fix', name: 'Fix', skill: 'om-fix' }],
    },
  ],
  issues: [],
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve({
  skills = SKILLS,
  refreshed = SKILLS,
  importable = [],
  refreshedImportable,
  importableError = false,
  holdSkills = false,
  uiState = {},
  workspaceUiState = {},
  failUiStateWrites = false,
}: {
  skills?: Skill[]
  refreshed?: Skill[]
  importable?: Skill[]
  /** What /skills/importable answers once a refresh POST landed. */
  refreshedImportable?: Skill[]
  importableError?: boolean
  holdSkills?: boolean
  uiState?: Record<string, unknown>
  workspaceUiState?: Record<string, unknown>
  /** The project ui-state PUT answers 500 without saving. */
  failUiStateWrites?: boolean
} = {}) {
  requests = []
  // The team-skill off-list lives in the PROJECT ui-state (`/api/v1/ui-state`, #1494), whose
  // PUT answers the MERGED state; the switches reconcile their optimistic write with that echo,
  // so the stub must merge and return rather than answer `{}`.
  let project: Record<string, unknown> = { ...uiState }
  let offered = importable
  const global: Record<string, unknown> = { ...workspaceUiState }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/skills' && method === 'GET') {
        return holdSkills ? new Promise<never>(() => {}) : json(skills)
      }
      if (url === '/api/v1/skills/refresh' && method === 'POST') {
        if (refreshedImportable) offered = refreshedImportable
        return json(refreshed)
      }
      // Both the fast read and the ?wait=1 convergence read hit this endpoint.
      if (url.startsWith('/api/v1/skills/importable')) {
        return importableError
          ? // 409 is what a project whose run store cannot open answers; a 4xx is not retried.
            new Response(JSON.stringify({ error: 'store busy' }), { status: 409, headers: { 'content-type': 'application/json' } })
          : json(offered)
      }
      if (url === '/api/v1/workflows') return json(WORKFLOWS)
      if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
      if (url === '/api/v1/ui-state' && method === 'GET') return json(project)
      if (url === '/api/v1/ui-state' && method === 'PUT') {
        if (failUiStateWrites) {
          return new Response(JSON.stringify({ error: 'disk full' }), { status: 500, headers: { 'content-type': 'application/json' } })
        }
        project = { ...project, ...(body as Record<string, unknown>) }
        return json(project)
      }
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(global)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT') return json({ ...global, ...(body as Record<string, unknown>) })
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string) {
  const client = gateSeededClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const rowNames = () =>
  [...document.querySelectorAll('[data-slot="skill-row"]')].map((el) => el.getAttribute('data-skill'))

const detail = () => document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the catalog list', () => {
  it('renders project-first with bold project rows and source tags (#377)', async () => {
    serve()
    renderAt('/skills')

    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'zebra-global']))
    const rows = [...document.querySelectorAll('[data-slot="skill-row"]')]
    expect(rows[0]?.getAttribute('data-project')).toBe('true')
    expect(rows[1]?.getAttribute('data-project')).toBe('true')
    expect(rows[2]?.hasAttribute('data-project')).toBe(false)
    // The tag says where each skill comes from.
    expect(rows[0]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('ai')
    expect(rows[2]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('global')
  })

  it('the first skill is the default selection: detail shows markdown body, path, used-by', async () => {
    serve()
    renderAt('/skills')

    await waitFor(() => expect(detail()).not.toBeNull())
    const pane = detail()!
    expect(pane.querySelector('h2')?.textContent).toBe('om-fix')
    expect(pane.querySelector('[data-slot="skill-path"]')?.textContent).toContain('.ai/skills/om-fix.md')
    // `# om-fix` became a real heading — the body renders as markdown, not a <pre> dump.
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="skill-body"] h1')?.textContent).toBe('om-fix'),
    )
    expect(pane.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain('fix-and-verify › Fix')
  })

  it('clicking a row selects it via the URL and swaps the detail', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.click(document.querySelector('[data-slot="skill-row"][data-skill="om-review"]')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))
    expect(
      document
        .querySelector('[data-slot="skill-row"][data-skill="om-review"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
    // An unreferenced skill says so instead of showing an empty section.
    expect(detail()?.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain(
      'Not referenced by a workflow yet',
    )
  })

  it('the filter narrows the rows but never hides the pinned bookmarklet entry', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, {
      target: { value: 'review' },
    })
    expect(rowNames()).toEqual(['om-review'])
    expect(document.querySelector('[data-slot="bookmarklets-row"]')).not.toBeNull()
  })

  it('an empty catalog explains where skills come from, and the panel is the fallback surface', async () => {
    serve({ skills: [] })
    renderAt('/skills')

    // #374: the hint must mention every project discovery dir, not just `.ai/skills/`.
    await waitFor(() => {
      const text = document.querySelector('[data-slot="skill-rows"]')?.textContent ?? ''
      expect(text).toContain('.ai/skills/')
      expect(text).toContain('.ai/cezar/skills/')
      expect(text).toContain('.agents/skills/')
    })
    // No skills → the bookmarklet panel is the default detail (legacy fallback rule).
    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).not.toBeNull())
  })
})

describe('refresh (#384: selection and scroll survive)', () => {
  it('POSTs /api/v1/skills/refresh, keeps the selected skill, the row container and its scroll', async () => {
    serve({ refreshed: [...SKILLS, skill({ name: 'team-new', source: 'team' })] })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    const rowsBefore = document.querySelector('[data-slot="skill-rows"]')!
    rowsBefore.scrollTop = 120

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/skills/refresh')).toBe(true),
    )
    // The refreshed catalog rendered (the new team skill is in the list)…
    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'team-new', 'zebra-global']))

    // …but the pane was updated IN PLACE: same scroll container, same scroll offset, same
    // selection — the legacy innerHTML rebuild lost all three.
    const rowsAfter = document.querySelector('[data-slot="skill-rows"]')!
    expect(rowsAfter).toBe(rowsBefore)
    expect(rowsAfter.scrollTop).toBe(120)
    expect(
      document
        .querySelector('[data-slot="skill-row"][data-skill="om-review"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
    expect(detail()?.querySelector('h2')?.textContent).toBe('om-review')
  })

  it('a refresh that drops the selected skill falls back to the first skill, never crashes', async () => {
    serve({ refreshed: SKILLS.filter((s) => s.name !== 'om-review') })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix'))
  })
})

const team = (name: string, repo = 'acme/skills', description?: string): Skill => ({
  name,
  source: 'team',
  body: `# ${name}\n\nBody of ${name}.`,
  path: `${repo}@main:${name}/SKILL.md`,
  team: { repo, ref: 'main', path: `${name}/SKILL.md`, dir: true },
  ...(description ? { description } : {}),
})

/**
 * hearsay-tools/cezarion#1494: every team skill from a configured source has a per-project
 * switch, keyed by source repo AND name. One catalog lists every skill in two groups, previews a
 * switched-off team skill, and keeps local, global and built-in skills locked on. The off-list
 * lives in the project ui-state.
 */
describe('team skill switches (#1494)', () => {
  const IMPORTABLE = [team('pr-create', 'acme/skills', 'Open a PR from the current branch'), team('code-review', 'acme/skills', 'Review the diff for bugs')]
  // pr-create is on, so the server's catalog carries it; code-review is switched off.
  const CATALOG = [...SKILLS, IMPORTABLE[0]!]
  const offList = { disabledTeamSkills: [{ repo: 'acme/skills', name: 'code-review' }] }

  const group = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)
  const groupRows = (slot: string) =>
    [...(group(slot)?.querySelectorAll('[data-slot="skill-row"]') ?? [])].map((el) => el.getAttribute('data-skill'))
  const switchFor = (name: string, repo?: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-slot="skills-list"] [data-slot="skill-switch"][data-skill="${name}"]${repo ? `[data-repo="${repo}"]` : ''}`,
    )
  const offListPuts = () =>
    requests.filter(
      (r) => r.method === 'PUT' && r.url === '/api/v1/ui-state' && (r.body as { disabledTeamSkills?: unknown })?.disabledTeamSkills !== undefined,
    )

  it('a team skill from an explicit source has a live switch labelled Enable <name>', async () => {
    serve({ skills: [...SKILLS, team('x')], importable: [team('x')] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x')?.disabled).toBe(false))
    expect(switchFor('x')?.getAttribute('aria-label')).toBe('Enable x')
    expect(switchFor('x')?.getAttribute('aria-checked')).toBe('true')
    expect(switchFor('x')?.getAttribute('data-locked')).toBeNull()
  })

  it('switching a team skill off moves it to Available and saves the off-list', async () => {
    serve({ skills: [...SKILLS, team('x')], importable: [team('x')] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x')?.disabled).toBe(false))
    fireEvent.click(switchFor('x')!)
    await waitFor(() => expect(groupRows('skills-group-available')).toEqual(['x']))
    expect(groupRows('skills-group-enabled')).not.toContain('x')
    await waitFor(() => expect(offListPuts().at(-1)?.body).toEqual({ disabledTeamSkills: [{ repo: 'acme/skills', name: 'x' }] }))
    expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')).toBe(false)
  })

  it('lists Enabled and Available groups, each with its count', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(groupRows('skills-group-available')).toEqual(['code-review']))
    expect(groupRows('skills-group-enabled')).toEqual(['om-fix', 'om-review', 'pr-create', 'zebra-global'])
    expect(group('skills-group-enabled')?.querySelector('h2')?.textContent).toBe('Enabled · 4')
    expect(group('skills-group-available')?.querySelector('h2')?.textContent).toBe('Available · 1')
  })

  it('previews a switched-off team skill with a notice and its switch', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills?skill=code-review')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('code-review'))
    expect(document.querySelector('[data-slot="skill-inactive-notice"]')?.textContent).toBe(
      'Not enabled for this project — agents can’t pick it.',
    )
    await waitFor(() => expect(detail()?.querySelector('[data-slot="skill-body"] h1')?.textContent).toBe('code-review'))
    const detailSwitch = document.querySelector('[data-slot="skills-detail"] [role="switch"]')
    expect(detailSwitch?.getAttribute('aria-checked')).toBe('false')
    expect(detailSwitch?.getAttribute('aria-label')).toBe('Enable code-review')
  })

  it('shows no notice for an enabled skill', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills?skill=pr-create')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('pr-create'))
    expect(document.querySelector('[data-slot="skill-inactive-notice"]')).toBeNull()
  })

  it('local and global skills show a locked switch', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('om-fix')).not.toBeNull())
    for (const name of ['om-fix', 'om-review', 'zebra-global']) {
      const toggle = switchFor(name)!
      expect(toggle.getAttribute('role')).toBe('switch')
      expect(toggle.getAttribute('aria-label')).toBe(`${name} is always enabled`)
      expect(toggle.getAttribute('aria-checked')).toBe('true')
      expect(toggle.getAttribute('data-locked')).toBe('true')
      expect(toggle.disabled).toBe(true)
    }
    await waitFor(() => expect(switchFor('pr-create')?.disabled).toBe(false))
  })

  it('switching an Available skill on removes it from the off-list and moves it to Enabled', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('code-review')?.disabled).toBe(false))
    fireEvent.click(switchFor('code-review')!)
    await waitFor(() => expect(groupRows('skills-group-enabled')).toContain('code-review'))
    expect(group('skills-group-available')).toBeNull()
    await waitFor(() => expect(offListPuts().at(-1)?.body).toEqual({ disabledTeamSkills: [] }))
  })

  it('the same name from two sources shows two rows, and the losing copy says what hides it', async () => {
    const a = team('x', 'acme/skills')
    const b = team('x', 'beta/skills')
    serve({ skills: [...SKILLS, a], importable: [a, b] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x', 'beta/skills')).not.toBeNull())
    const rows = [...document.querySelectorAll('[data-slot="skills-group-enabled"] [data-slot="skill-row"][data-skill="x"]')]
    expect(rows.map((row) => row.getAttribute('data-repo'))).toEqual(['acme/skills', 'beta/skills'])
    expect(rows[0]!.querySelector('[data-slot="skill-hidden-by"]')).toBeNull()
    expect(rows[1]!.querySelector('[data-slot="skill-hidden-by"]')?.textContent).toBe('hidden by acme/skills')
    // Each copy has its own switch, named by its source.
    expect(switchFor('x', 'acme/skills')?.getAttribute('aria-label')).toBe('Enable x from acme/skills')
    expect(switchFor('x', 'beta/skills')?.getAttribute('aria-label')).toBe('Enable x from beta/skills')
    // Each row selects its own copy.
    fireEvent.click(rows[1]!)
    await waitFor(() => expect(detail()?.querySelector('[data-slot="skill-path"]')?.textContent).toContain('from beta/skills'))
    await waitFor(() => expect(switchFor('x', 'acme/skills')?.disabled).toBe(false))
    fireEvent.click(switchFor('x', 'acme/skills')!)
    await waitFor(() => expect(offListPuts().at(-1)?.body).toEqual({ disabledTeamSkills: [{ repo: 'acme/skills', name: 'x' }] }))
    expect(switchFor('x', 'beta/skills')?.getAttribute('aria-checked')).toBe('true')
  })

  it('a local skill hides every team copy of its name', async () => {
    serve({ skills: CATALOG, importable: [...IMPORTABLE, team('om-fix')] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('pr-create')?.disabled).toBe(false))
    expect([...document.querySelectorAll('[data-slot="skill-row"][data-skill="om-fix"]')].map((row) => row.getAttribute('data-repo'))).toEqual([null])
  })

  it('a rejected save toasts and the switch reverts', async () => {
    serve({ skills: [...SKILLS, team('x')], importable: [team('x')], failUiStateWrites: true })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x')?.disabled).toBe(false))
    fireEvent.click(switchFor('x')!)
    await waitFor(() => expect(document.body.textContent).toContain('disk full'))
    await waitFor(() => expect(switchFor('x')?.getAttribute('aria-checked')).toBe('true'))
    expect(group('skills-group-available')).toBeNull()
  })

  it('the filter searches both groups', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(groupRows('skills-group-available')).toEqual(['code-review']))
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'review' } })
    expect(groupRows('skills-group-enabled')).toEqual(['om-review'])
    expect(groupRows('skills-group-available')).toEqual(['code-review'])
  })

  it('?skill=__import selects the first Available skill', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('code-review'))
  })

  it('?skill=__import selects the first skill when nothing is Available', async () => {
    serve({ skills: CATALOG, importable: [IMPORTABLE[0]!] })
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix'))
  })

  it('Refresh re-reads the team list, so a newly offered team skill gets a live switch', async () => {
    serve({
      skills: CATALOG,
      refreshed: [...CATALOG, IMPORTABLE[1]!],
      importable: [IMPORTABLE[0]!],
      refreshedImportable: IMPORTABLE,
    })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('pr-create')?.disabled).toBe(false))
    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() => expect(switchFor('code-review')?.getAttribute('aria-label')).toBe('Enable code-review'))
    expect(switchFor('code-review')?.getAttribute('data-locked')).toBeNull()
  })

  it('has no separate "Manage skills" entry', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(groupRows('skills-group-available')).toEqual(['code-review']))
    expect(document.querySelector('[data-slot="import-skills-row"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Manage skills')
  })

  it('without team skills there is no Available group, and the page says how to add a source', async () => {
    serve({ importable: [] })
    renderAt('/skills')
    await waitFor(() => expect(groupRows('skills-group-enabled')).toHaveLength(3))
    expect(group('skills-group-available')).toBeNull()
    const hint = await waitFor(() => {
      const found = document.querySelector('[data-slot="skills-team-empty"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(hint.textContent).toContain('skillsRepos')
    expect(hint.textContent).toContain('.ai/cezar/config.json')
    expect(document.querySelector('[data-slot="skills-list"]')?.textContent?.toLowerCase()).not.toContain('mercato')
  })

  it('renders no skills-update slot and no update card', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('pr-create')?.disabled).toBe(false))
    expect(document.querySelector('[data-slot="skills-update"]')).toBeNull()
    expect(document.querySelector('[data-slot="skills-update-card"]')).toBeNull()
    expect(requests.some((r) => r.url.includes('skills-update'))).toBe(false)
  })

  it('loading keeps both cards with a status row', async () => {
    serve({ holdSkills: true, importable: IMPORTABLE })
    renderAt('/skills')
    await waitFor(() => expect(document.querySelector('[data-slot="skills-list"] [role="status"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="skills-detail"] [role="status"]')).not.toBeNull()
  })

  it('an importable error shows Retry, hides Available, and locks the team switches', async () => {
    serve({ skills: CATALOG, importableError: true, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(document.querySelector('[data-slot="skills-importable-error"]')).not.toBeNull())
    const alert = document.querySelector('[data-slot="skills-importable-error"]')!
    expect(alert.getAttribute('role')).toBe('alert')
    const before = requests.filter((r) => r.url.startsWith('/api/v1/skills/importable')).length
    fireEvent.click([...alert.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!)
    await waitFor(() =>
      expect(requests.filter((r) => r.url.startsWith('/api/v1/skills/importable')).length).toBeGreaterThan(before),
    )
    expect(group('skills-group-available')).toBeNull()
    expect(switchFor('pr-create')?.disabled).toBe(true)
    expect(offListPuts()).toEqual([])
  })

  it('each switch is its own tab stop beside its row link', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('code-review')).not.toBeNull())
    const row = document.querySelector('[data-slot="skill-row"][data-skill="code-review"]')!
    const toggle = switchFor('code-review')!
    expect(row.tagName).toBe('A')
    expect(row.contains(toggle)).toBe(false)
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.tabIndex).toBe(0)
  })
})

describe('the bookmarklet panel (spec 011)', () => {
  it('says it is loading rather than claiming there are no skills while the catalog is in flight', async () => {
    // The panel's empty state reads "(no skills yet …)". Rendering it against an unresolved
    // catalog would state that as fact on every cold load of the subpage — so the section
    // must gate on the pending query the way its sibling sections do.
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
        if (url === '/api/v1/ui-state') return json({})
        return new Promise<never>(() => {}) // /api/v1/skills never settles
      }),
    )
    renderAt('/settings/bookmarklets')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="bookmarklets-loading"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="bookmarklet-panel"]')).toBeNull()
    expect(document.body.textContent).not.toContain('no skills yet')
  })

  it('is a first-class Settings page that generates protected links and auto-arms per-skill links only', async () => {
    serve()
    renderAt('/settings/bookmarklets')

    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).not.toBeNull())
    // The key landed in the links (the panel is its one legitimate DOM use).
    await waitFor(() => {
      const generic = document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')
      expect(decodeURIComponent(generic?.getAttribute('href') ?? '')).toContain('auto=0&key=sekret&ref=')
    })
    const links = [...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')]
    expect(links).toHaveLength(3) // one per skill, project-first like the catalog
    expect(links[0]?.textContent).toContain('/om-fix')
    for (const link of links) {
      expect(link.getAttribute('href')?.startsWith('javascript:')).toBe(true)
      expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain('auto=0&key=sekret')
    }

    // Auto-submit arms the per-skill links; the generic launcher stays prefill-only.
    fireEvent.click(document.querySelector('[data-slot="bm-auto"]')!)
    await waitFor(() => {
      const first = document.querySelector('[data-slot="bm-list"] [data-slot="bm-link"]')
      expect(decodeURIComponent(first?.getAttribute('href') ?? '')).toContain('auto=1&key=sekret')
    })
    const generic = document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')
    expect(decodeURIComponent(generic?.getAttribute('href') ?? '')).toContain('auto=0&key=sekret')
  })

  it('filters the per-skill rows and copies a link to the clipboard', async () => {
    serve()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderAt('/skills?skill=__bm')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]')).toHaveLength(3),
    )
    // Copy is disabled until the launch key has loaded (hearsay-tools/cezarion#896).
    await waitFor(() => expect(document.querySelector('[data-slot="bm-list"] [data-slot="bm-link"]')?.getAttribute('href')).toMatch(/^javascript:/))

    fireEvent.change(document.querySelector('[data-slot="bm-filter"]')!, { target: { value: 'zebra' } })
    const rows = [...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('/zebra-global')

    fireEvent.click(rows[0]!.querySelector('[data-slot="bm-copy"]')!)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(String(writeText.mock.calls[0]?.[0])).toMatch(/^javascript:/)
  })

  it('a clicked drag-source link never navigates — it only explains the gesture', async () => {
    serve()
    renderAt('/skills?skill=__bm')
    // The launcher is a drag source only once the launch key has loaded (hearsay-tools/cezarion#896).
    await waitFor(() =>
      expect(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')?.getAttribute('data-ready')).toBe('true'),
    )

    fireEvent.click(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toaster"]')?.textContent).toContain(
        'Drag me to your bookmarks bar',
      ),
    )
  })
})
