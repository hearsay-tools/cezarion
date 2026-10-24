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
 * `/skills` (R6 Step 1.4, grouped table since hearsay-tools/cezarion#1607): the table and its
 * inline details against fixture payloads, the #377 ordering/bold rendering, the #384 refresh
 * contract (the open skill and the scroll survive), the group controls, and the bookmarklet
 * panel's protected link generation. The pure rules themselves are pinned in
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
  holdImportable = false,
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
  /** /skills/importable never answers: the team list stays unknown. */
  holdImportable?: boolean
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
  const importableAnswer = () => {
    if (holdImportable) return new Promise<never>(() => {})
    return importableError
      ? // 409 is what a project whose run store cannot open answers; a 4xx is not retried.
        new Response(JSON.stringify({ error: 'store busy' }), { status: 409, headers: { 'content-type': 'application/json' } })
      : json(offered)
  }
  const projectUiState = (method: string, body: unknown) => {
    if (method !== 'PUT') return json(project)
    if (failUiStateWrites) {
      return new Response(JSON.stringify({ error: 'disk full' }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    project = { ...project, ...(body as Record<string, unknown>) }
    return json(project)
  }
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
      if (url.startsWith('/api/v1/skills/importable')) return importableAnswer()
      if (url === '/api/v1/workflows') return json(WORKFLOWS)
      if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
      if (url === '/api/v1/ui-state') return projectUiState(method, body)
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
const row = (name: string, repo?: string) =>
  document.querySelector<HTMLAnchorElement>(`[data-slot="skill-row"][data-skill="${name}"]${repo ? `[data-repo="${repo}"]` : ''}`)
const groupRow = (label: string) =>
  document.querySelector<HTMLTableRowElement>(`[data-slot="skill-group-row"][data-group="${label}"]`)
const groupToggle = (label: string) =>
  groupRow(label)?.querySelector<HTMLButtonElement>('[data-slot="skill-group-toggle"]') ?? null
const groupSwitch = (label: string) =>
  groupRow(label)?.querySelector<HTMLButtonElement>('[data-slot="skill-group-switch"]') ?? null
const groupCount = (label: string) => groupRow(label)?.querySelector('[data-slot="skill-group-count"]')?.textContent
const groupLabels = () =>
  [...document.querySelectorAll('[data-slot="skill-group-row"]')].map((el) => el.getAttribute('data-group'))

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the grouped table', () => {
  it('groups project skills before global ones, with bold project rows (#377)', async () => {
    serve()
    renderAt('/skills')

    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'zebra-global']))
    expect(groupLabels()).toEqual(['This project', 'Global'])
    expect(row('om-fix')?.getAttribute('data-project')).toBe('true')
    expect(row('om-review')?.getAttribute('data-project')).toBe('true')
    expect(row('zebra-global')?.hasAttribute('data-project')).toBe(false)
    // Local and global groups are always enabled: a locked, checked group control.
    expect(groupSwitch('This project')?.getAttribute('aria-checked')).toBe('true')
    expect(groupSwitch('This project')?.disabled).toBe(true)
    expect(groupSwitch('This project')?.getAttribute('aria-label')).toBe('This project skills are always enabled')
    expect(groupCount('This project')).toBe('2 / 2')
  })

  it('opens no skill by default, and the Used by column names the workflow', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    expect(detail()).toBeNull()
    const cell = row('om-fix')!.closest('tr')!.querySelector('[data-slot="skill-used-by-cell"]')
    await waitFor(() => expect(cell?.textContent).toBe('fix-and-verify'))
  })

  it('a click opens the full details directly below the row, and a second click folds them', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.click(row('om-fix')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix'))
    const next = row('om-fix')!.closest('tr')!.nextElementSibling
    expect(next?.getAttribute('data-slot')).toBe('skill-detail-row')
    const pane = detail()!
    expect(pane.querySelector('[data-slot="skill-path"]')?.textContent).toContain('.ai/skills/om-fix.md')
    expect(pane.querySelector('[data-slot="skill-description"]')?.textContent).toBe('Fix an issue end to end')
    await waitFor(() => expect(pane.querySelector('[data-slot="skill-body"] h1')?.textContent).toBe('om-fix'))
    expect(pane.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain('fix-and-verify › Fix')
    expect(row('om-fix')?.getAttribute('aria-expanded')).toBe('true')
    expect(row('om-fix')?.getAttribute('aria-current')).toBe('page')

    fireEvent.click(row('om-fix')!)
    await waitFor(() => expect(detail()).toBeNull())
    expect(row('om-fix')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('opening another skill swaps the details', async () => {
    serve()
    renderAt('/skills?skill=om-fix')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix'))
    fireEvent.click(row('om-review')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))
    expect(document.querySelectorAll('[data-slot="skill-detail-row"]')).toHaveLength(1)
    expect(detail()?.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain('Not referenced by a workflow yet')
  })

  it('folding a group hides its skills without changing them', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    expect(groupToggle('Global')?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(groupToggle('Global')!)
    expect(rowNames()).toEqual(['om-fix', 'om-review'])
    expect(groupToggle('Global')?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(document.querySelector('[data-slot="skills-collapse-all"]')!)
    expect(rowNames()).toEqual([])
    fireEvent.click(document.querySelector('[data-slot="skills-expand-all"]')!)
    expect(rowNames()).toEqual(['om-fix', 'om-review', 'zebra-global'])
    expect(requests.some((r) => r.method === 'PUT')).toBe(false)
  })

  it('the filter narrows the rows but never hides the pinned bookmarklet entry', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, {
      target: { value: 'review' },
    })
    expect(rowNames()).toEqual(['om-review'])
    expect(groupLabels()).toEqual(['This project'])
    expect(document.querySelector('[data-slot="bookmarklets-row"]')).not.toBeNull()
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'zzz-none' } })
    expect(document.querySelector('[data-slot="skill-rows"]')?.textContent).toContain('(no skills match)')
  })

  it('an empty catalog explains where skills come from', async () => {
    serve({ skills: [] })
    renderAt('/skills')

    // #374: the hint must mention every project discovery dir, not just `.ai/skills/`.
    await waitFor(() => {
      const text = document.querySelector('[data-slot="skill-rows"]')?.textContent ?? ''
      expect(text).toContain('.ai/skills/')
      expect(text).toContain('.ai/cezar/skills/')
      expect(text).toContain('.agents/skills/')
    })
  })

  it('Run from GitHub opens the bookmarklet panel above the table, and a second click closes it', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    fireEvent.click(document.querySelector('[data-slot="bookmarklets-row"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).not.toBeNull())
    expect(rowNames()).toHaveLength(3)
    fireEvent.click(document.querySelector('[data-slot="bookmarklets-row"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).toBeNull())
  })
})

describe('refresh (#384: the open skill and the scroll survive)', () => {
  it('POSTs /api/v1/skills/refresh, keeps the open skill, the row container and its scroll', async () => {
    serve({ refreshed: [...SKILLS, skill({ name: 'local-new', source: 'ai' })] })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    const rowsBefore = document.querySelector('[data-slot="skill-rows"]')!
    rowsBefore.scrollTop = 120

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/skills/refresh')).toBe(true),
    )
    await waitFor(() => expect(rowNames()).toEqual(['local-new', 'om-fix', 'om-review', 'zebra-global']))
    await waitFor(() => expect(document.body.textContent).toContain('Team skills refreshed.'))

    // The table was updated IN PLACE: same scroll container, same scroll offset, same open
    // skill — the legacy innerHTML rebuild lost all three.
    const rowsAfter = document.querySelector('[data-slot="skill-rows"]')!
    expect(rowsAfter).toBe(rowsBefore)
    expect(rowsAfter.scrollTop).toBe(120)
    expect(row('om-review')?.getAttribute('aria-current')).toBe('page')
    expect(detail()?.querySelector('h2')?.textContent).toBe('om-review')
  })

  it('stays visible and works after filtering, folding groups and opening a skill', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'om' } })
    fireEvent.click(groupToggle('This project')!)
    fireEvent.click(groupToggle('This project')!)
    fireEvent.click(row('om-fix')!)
    await waitFor(() => expect(detail()).not.toBeNull())
    const button = document.querySelector<HTMLButtonElement>('[data-slot="skills-refresh"]')!
    expect(button.textContent).toBe('Refresh')
    fireEvent.click(button)
    await waitFor(() => expect(document.body.textContent).toContain('Team skills refreshed.'))
    expect(button.disabled).toBe(false)
    expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix')
  })

  it('a refresh that drops the open skill folds its details, never crashes', async () => {
    serve({ refreshed: SKILLS.filter((s) => s.name !== 'om-review') })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'zebra-global']))
    expect(detail()).toBeNull()
  })
})

const team = (name: string, repo = 'acme/skills', description?: string, path = `${name}/SKILL.md`): Skill => ({
  name,
  source: 'team',
  body: `# ${name}\n\nBody of ${name}.`,
  path: `${repo}@main:${path}`,
  team: { repo, ref: 'main', path, dir: true },
  ...(description ? { description } : {}),
})

const switchFor = (name: string, repo?: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-slot="skills-list"] [data-slot="skill-table-row"] [data-slot="skill-switch"][data-skill="${name}"]${repo ? `[data-repo="${repo}"]` : ''}`,
  )
const offListPuts = () =>
  requests.filter(
    (r) => r.method === 'PUT' && r.url === '/api/v1/ui-state' && (r.body as { disabledTeamSkills?: unknown })?.disabledTeamSkills !== undefined,
  )

/**
 * hearsay-tools/cezarion#1494: every team skill from a configured source has a per-project
 * switch, keyed by source repo AND name. The table lists switched-off skills next to enabled
 * ones, previews them, and keeps local, global and built-in skills locked on. The off-list lives
 * in the project ui-state.
 */
describe('team skill switches (#1494)', () => {
  const IMPORTABLE = [team('pr-create', 'acme/skills', 'Open a PR from the current branch'), team('code-review', 'acme/skills', 'Review the diff for bugs')]
  // pr-create is on, so the server's catalog carries it; code-review is switched off.
  const CATALOG = [...SKILLS, IMPORTABLE[0]!]
  const offList = { disabledTeamSkills: [{ repo: 'acme/skills', name: 'code-review' }] }

  it('a team skill from an explicit source has a live switch labelled Enable <name>', async () => {
    serve({ skills: [...SKILLS, team('x')], importable: [team('x')] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x')?.disabled).toBe(false))
    expect(switchFor('x')?.getAttribute('aria-label')).toBe('Enable x')
    expect(switchFor('x')?.getAttribute('aria-checked')).toBe('true')
    expect(switchFor('x')?.getAttribute('data-locked')).toBeNull()
  })

  it('switching a team skill off keeps its row in place and saves the off-list', async () => {
    serve({ skills: [...SKILLS, team('x')], importable: [team('x')] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x')?.disabled).toBe(false))
    fireEvent.click(switchFor('x')!)
    await waitFor(() => expect(switchFor('x')?.getAttribute('aria-checked')).toBe('false'))
    expect(row('x')?.hasAttribute('data-enabled')).toBe(false)
    expect(groupCount('acme/skills')).toBe('0 / 1')
    await waitFor(() => expect(offListPuts().at(-1)?.body).toEqual({ disabledTeamSkills: [{ repo: 'acme/skills', name: 'x' }] }))
    expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')).toBe(false)
  })

  it('lists enabled and disabled team skills together under their repository', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(row('code-review')).not.toBeNull())
    expect(groupLabels()).toEqual(['This project', 'acme/skills', 'Global'])
    expect(rowNames()).toEqual(['om-fix', 'om-review', 'code-review', 'pr-create', 'zebra-global'])
    expect(groupCount('acme/skills')).toBe('1 / 2')
    expect(groupSwitch('acme/skills')?.getAttribute('aria-checked')).toBe('mixed')
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

  it('switching a disabled skill on removes it from the off-list', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('code-review')?.disabled).toBe(false))
    fireEvent.click(switchFor('code-review')!)
    await waitFor(() => expect(switchFor('code-review')?.getAttribute('aria-checked')).toBe('true'))
    expect(groupCount('acme/skills')).toBe('2 / 2')
    expect(groupSwitch('acme/skills')?.getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(offListPuts().at(-1)?.body).toEqual({ disabledTeamSkills: [] }))
  })

  it('the same name from two sources shows two rows, and the losing copy says what hides it', async () => {
    const a = team('x', 'acme/skills')
    const b = team('x', 'beta/skills')
    serve({ skills: [...SKILLS, a], importable: [a, b] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x', 'beta/skills')).not.toBeNull())
    const rows = [...document.querySelectorAll('[data-slot="skill-row"][data-skill="x"]')]
    expect(rows.map((el) => el.getAttribute('data-repo'))).toEqual(['acme/skills', 'beta/skills'])
    expect(rows[0]!.querySelector('[data-slot="skill-hidden-by"]')).toBeNull()
    expect(rows[1]!.querySelector('[data-slot="skill-hidden-by"]')?.textContent).toBe('hidden by acme/skills')
    // Each copy has its own switch, named by its source.
    expect(switchFor('x', 'acme/skills')?.getAttribute('aria-label')).toBe('Enable x from acme/skills')
    expect(switchFor('x', 'beta/skills')?.getAttribute('aria-label')).toBe('Enable x from beta/skills')
    // Each row opens its own copy.
    fireEvent.click(rows[1]!)
    await waitFor(() => expect(detail()?.querySelector('[data-slot="skill-path"]')?.textContent).toContain('from beta/skills'))
    await waitFor(() => expect(switchFor('x', 'acme/skills')?.disabled).toBe(false))
    fireEvent.click(switchFor('x', 'acme/skills')!)
    await waitFor(() => expect(offListPuts().at(-1)?.body).toEqual({ disabledTeamSkills: [{ repo: 'acme/skills', name: 'x' }] }))
    expect(switchFor('x', 'beta/skills')?.getAttribute('aria-checked')).toBe('true')
  })

  it('one repo at two refs shows one row with one shared switch', async () => {
    const main = team('x', 'acme/skills')
    const v2: Skill = { ...main, path: 'acme/skills@v2:x/SKILL.md', team: { ...main.team!, ref: 'v2' } }
    serve({ skills: [...SKILLS, main], importable: [main, v2] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x')?.disabled).toBe(false))
    expect(document.querySelectorAll('[data-slot="skill-row"][data-skill="x"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="skill-table-row"] [data-slot="skill-switch"][data-skill="x"]')).toHaveLength(1)
    expect(switchFor('x')?.getAttribute('aria-label')).toBe('Enable x')
    expect(row('x')?.getAttribute('href')).toBe('/p/boot/skills?skill=x')
  })

  it('a long hiding source wraps instead of overflowing the row', async () => {
    const long = `https://git.example.com/${'very-long-group/'.repeat(8)}skills.git`
    const a = team('x', long)
    const b = team('x', 'beta/skills')
    serve({ skills: [...SKILLS, a], importable: [a, b] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x', 'beta/skills')).not.toBeNull())
    const note = row('x', 'beta/skills')!.querySelector('[data-slot="skill-hidden-by"]')!
    expect(note.textContent).toBe(`hidden by ${long}`)
    expect(note.className).toContain('[overflow-wrap:anywhere]')
    expect(note.className).toContain('min-w-0')
  })

  it('a local skill hides every team copy of its name', async () => {
    serve({ skills: CATALOG, importable: [...IMPORTABLE, team('om-fix')] })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('pr-create')?.disabled).toBe(false))
    expect([...document.querySelectorAll('[data-slot="skill-row"][data-skill="om-fix"]')].map((el) => el.getAttribute('data-repo'))).toEqual([null])
  })

  it('a rejected save toasts and the switch reverts', async () => {
    serve({ skills: [...SKILLS, team('x')], importable: [team('x')], failUiStateWrites: true })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('x')?.disabled).toBe(false))
    fireEvent.click(switchFor('x')!)
    await waitFor(() => expect(document.body.textContent).toContain('disk full'))
    await waitFor(() => expect(switchFor('x')?.getAttribute('aria-checked')).toBe('true'))
  })

  it('the filter searches enabled and disabled skills alike', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(row('code-review')).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'review' } })
    expect(rowNames()).toEqual(['om-review', 'code-review'])
  })

  it('?skill=__import opens the first switched-off skill', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('code-review'))
  })

  it('?skill=__import opens nothing when every skill is enabled', async () => {
    serve({ skills: CATALOG, importable: [IMPORTABLE[0]!] })
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(switchFor('pr-create')?.disabled).toBe(false))
    expect(detail()).toBeNull()
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
    await waitFor(() => expect(row('code-review')).not.toBeNull())
    expect(document.querySelector('[data-slot="import-skills-row"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Manage skills')
  })

  it('without team skills the page says how to add a source', async () => {
    serve({ importable: [] })
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
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

  it('loading shows a status row', async () => {
    serve({ holdSkills: true, importable: IMPORTABLE })
    renderAt('/skills')
    await waitFor(() => expect(document.querySelector('[data-slot="skills-list"] [role="status"]')).not.toBeNull())
    expect(rowNames()).toEqual([])
  })

  it('while the team list loads, a repository control shows no count and no off state', async () => {
    serve({ skills: CATALOG, holdImportable: true })
    renderAt('/skills')
    await waitFor(() => expect(groupRow('acme/skills')).not.toBeNull())
    expect(groupCount('acme/skills')).toBe('—')
    expect(groupSwitch('acme/skills')?.hasAttribute('aria-checked')).toBe(false)
    expect(groupSwitch('acme/skills')?.getAttribute('aria-busy')).toBe('true')
    expect(groupSwitch('acme/skills')?.disabled).toBe(true)
    // The skill switch reads on, the catalog's own answer.
    expect(switchFor('pr-create')?.getAttribute('aria-checked')).toBe('true')
  })

  it('an importable error shows Retry and locks the team switches', async () => {
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
    expect(row('code-review')).toBeNull()
    expect(switchFor('pr-create')?.disabled).toBe(true)
    expect(groupSwitch('acme/skills')?.disabled).toBe(true)
    expect(offListPuts()).toEqual([])
  })

  it('each switch is its own tab stop beside its row link', async () => {
    serve({ skills: CATALOG, importable: IMPORTABLE, uiState: offList })
    renderAt('/skills')
    await waitFor(() => expect(switchFor('code-review')).not.toBeNull())
    const link = row('code-review')!
    const toggle = switchFor('code-review')!
    expect(link.tagName).toBe('A')
    expect(link.contains(toggle)).toBe(false)
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.tabIndex).toBe(0)
  })
})

/** hearsay-tools/cezarion#1607: repository and plugin or directory group controls. */
describe('group controls (#1607)', () => {
  const PLUGIN = [
    team('dev-flow', 'acme/skills', 'Work a ticket', 'plugins/sdlc/skills/dev-flow/SKILL.md'),
    team('plan-issue', 'acme/skills', 'Plan a ticket', 'plugins/sdlc/skills/plan-issue/SKILL.md'),
    team('lint', 'acme/skills', 'Lint the code', 'frontend/skills/lint/SKILL.md'),
    team('root-skill', 'acme/skills'),
    team('other', 'beta/skills'),
  ]
  const off = (...names: string[]) => ({ disabledTeamSkills: names.map((name) => ({ repo: 'acme/skills', name })) })
  const catalogWithout = (...names: string[]) => [...SKILLS, ...PLUGIN.filter((s) => !names.includes(s.name))]
  const lastOffList = () =>
    (offListPuts().at(-1)?.body as { disabledTeamSkills: Array<{ repo: string; name: string }> }).disabledTeamSkills
      .map((ref) => `${ref.repo}:${ref.name}`)
      .sort()

  it('nests plugin and directory groups under their repository, folded by default', async () => {
    serve({ skills: catalogWithout(), importable: PLUGIN })
    renderAt('/skills')
    await waitFor(() => expect(groupRow('sdlc')).not.toBeNull())
    expect(groupLabels()).toEqual(['This project', 'acme/skills', 'frontend', 'sdlc', 'beta/skills', 'Global'])
    expect(groupRow('sdlc')?.getAttribute('data-kind')).toBe('plugin')
    expect(groupRow('frontend')?.getAttribute('data-kind')).toBe('directory')
    expect(groupToggle('acme/skills')?.getAttribute('aria-expanded')).toBe('true')
    expect(groupToggle('sdlc')?.getAttribute('aria-expanded')).toBe('false')
    expect(row('dev-flow')).toBeNull()
    expect(row('root-skill')).not.toBeNull()
    fireEvent.click(groupToggle('sdlc')!)
    expect(row('dev-flow')).not.toBeNull()
    expect(row('lint')).toBeNull()
  })

  it('a mixed group enables every child, and an enabled one disables them, without touching other groups', async () => {
    serve({ skills: catalogWithout('plan-issue'), importable: PLUGIN, uiState: off('plan-issue') })
    renderAt('/skills')
    await waitFor(() => expect(groupSwitch('sdlc')?.disabled).toBe(false))
    expect(groupCount('sdlc')).toBe('1 / 2')
    expect(groupSwitch('sdlc')?.getAttribute('aria-checked')).toBe('mixed')
    expect(groupSwitch('sdlc')?.getAttribute('aria-label')).toBe('Enable all skills in sdlc')
    expect(groupCount('acme/skills')).toBe('3 / 4')

    fireEvent.click(groupSwitch('sdlc')!)
    await waitFor(() => expect(groupSwitch('sdlc')?.getAttribute('aria-checked')).toBe('true'))
    expect(groupCount('acme/skills')).toBe('4 / 4')
    await waitFor(() => expect(lastOffList()).toEqual([]))

    fireEvent.click(groupSwitch('sdlc')!)
    await waitFor(() => expect(groupSwitch('sdlc')?.getAttribute('aria-checked')).toBe('false'))
    expect(groupCount('sdlc')).toBe('0 / 2')
    expect(groupSwitch('frontend')?.getAttribute('aria-checked')).toBe('true')
    expect(groupSwitch('beta/skills')?.getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(lastOffList()).toEqual(['acme/skills:dev-flow', 'acme/skills:plan-issue']))
    expect(offListPuts()).toHaveLength(2)
  })

  it('a repository control switches every child, filtered ones included', async () => {
    serve({ skills: catalogWithout(), importable: PLUGIN })
    renderAt('/skills')
    await waitFor(() => expect(groupSwitch('acme/skills')?.disabled).toBe(false))
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'lint' } })
    expect(rowNames()).toEqual(['lint'])
    fireEvent.click(groupSwitch('acme/skills')!)
    await waitFor(() =>
      expect(lastOffList()).toEqual([
        'acme/skills:dev-flow',
        'acme/skills:lint',
        'acme/skills:plan-issue',
        'acme/skills:root-skill',
      ]),
    )
    expect(groupSwitch('beta/skills')).toBeNull() // filtered out, and untouched
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: '' } })
    expect(switchFor('other', 'beta/skills')?.getAttribute('aria-checked')).toBe('true')
  })

  it('a per-skill switch updates its parents counts and mixed states', async () => {
    serve({ skills: catalogWithout(), importable: PLUGIN })
    renderAt('/skills?skill=dev-flow')
    await waitFor(() => expect(switchFor('dev-flow')?.disabled).toBe(false))
    fireEvent.click(switchFor('dev-flow')!)
    await waitFor(() => expect(groupSwitch('sdlc')?.getAttribute('aria-checked')).toBe('mixed'))
    expect(groupCount('sdlc')).toBe('1 / 2')
    expect(groupSwitch('acme/skills')?.getAttribute('aria-checked')).toBe('mixed')
    expect(groupCount('acme/skills')).toBe('3 / 4')
  })

  it('a rejected group save toasts and restores the saved selection', async () => {
    serve({ skills: catalogWithout(), importable: PLUGIN, failUiStateWrites: true })
    renderAt('/skills')
    await waitFor(() => expect(groupSwitch('sdlc')?.disabled).toBe(false))
    fireEvent.click(groupSwitch('sdlc')!)
    await waitFor(() => expect(document.body.textContent).toContain('disk full'))
    await waitFor(() => expect(groupSwitch('sdlc')?.getAttribute('aria-checked')).toBe('true'))
    expect(groupCount('sdlc')).toBe('2 / 2')
  })

  it('a skill link opens the skill and its parent groups', async () => {
    serve({ skills: catalogWithout(), importable: PLUGIN })
    renderAt('/skills?skill=plan-issue')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('plan-issue'))
    expect(groupToggle('sdlc')?.getAttribute('aria-expanded')).toBe('true')
    expect(groupToggle('frontend')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('a twin link with ?repo opens that copy under its own repository', async () => {
    serve({ skills: catalogWithout(), importable: [...PLUGIN, team('lint', 'beta/skills')] })
    renderAt('/skills?skill=lint&repo=beta%2Fskills')
    await waitFor(() => expect(detail()?.querySelector('[data-slot="skill-path"]')?.textContent).toContain('from beta/skills'))
    expect(groupToggle('frontend')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('search matches repository and group names and reveals matches inside folded groups', async () => {
    serve({ skills: catalogWithout(), importable: PLUGIN })
    renderAt('/skills')
    await waitFor(() => expect(groupRow('sdlc')).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'sdlc' } })
    expect(rowNames()).toEqual(['dev-flow', 'plan-issue'])
    expect(groupToggle('sdlc')?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'beta' } })
    expect(rowNames()).toEqual(['other'])
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'ticket' } })
    expect(rowNames()).toEqual(['dev-flow', 'plan-issue'])
  })

  it('fold and activation are separate keyboard controls with names', async () => {
    serve({ skills: catalogWithout(), importable: PLUGIN })
    renderAt('/skills')
    await waitFor(() => expect(groupSwitch('sdlc')?.disabled).toBe(false))
    const fold = groupToggle('sdlc')!
    const check = groupSwitch('sdlc')!
    expect(fold.tagName).toBe('BUTTON')
    expect(fold.textContent).toContain('sdlc')
    expect(fold.contains(check)).toBe(false)
    expect(check.getAttribute('role')).toBe('checkbox')
    expect(check.tabIndex).toBe(0)
    fireEvent.click(fold)
    expect(offListPuts()).toEqual([])
    expect(groupSwitch('sdlc')?.getAttribute('aria-checked')).toBe('true')
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
