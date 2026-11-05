import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { jsonResponse } from '@/test/fetch-routes'

import { ACTIVITY_WAIT_KIND, RUN_STATUS, iso, project, request, run, snapshot, worker } from './activity.testkit'
import { GlobalActivityRoute } from './global-activity-route'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const A1 = run({ runId: 'a1', title: 'Porting upstream SSE' })
const A2 = run({ runId: 'a2', title: 'Fixing flaky shard', status: RUN_STATUS.waiting, rung: 'needs-you', wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-60_000), detail: { reason: 'question', question: 'Retry the shard?' } } })
const G1 = run({ runId: 'g1', title: 'Adding verdict schema', workers: [worker({ runId: 'g1-w1' }), worker({ runId: 'g1-w2' }), worker({ runId: 'g1-w3', status: RUN_STATUS.done, rung: 'done' })] })
const ALPHA_PEER = request({ senderRunId: 'a1', recipientRunId: 'a2' })
// A request whose other end is not a pill of its panel: it has no arc anywhere.
const GAMMA_AWAY = request({ senderRunId: 'g1', recipientRunId: 'a1', recipientTitle: 'Porting upstream SSE' })

const SNAPSHOT = snapshot(
  project({ projectId: 'alpha', name: 'alpha', inReview: 1, tasks: [A1, A2], requests: [ALPHA_PEER] }),
  project({ projectId: 'beta', name: 'beta', loaded: false }),
  project({ projectId: 'gamma', name: 'gamma', tasks: [G1], requests: [GAMMA_AWAY] }),
  project({ projectId: 'delta', name: 'delta', inReview: 2 }),
  project({ projectId: 'eps', name: 'eps', unavailable: { status: 503, error: 'The run store is locked by another process.' } }),
  project({ projectId: 'zeta', name: 'zeta' }),
)

const registryEntry = (id: string) => ({ id, name: id, root: `/home/me/${id}`, addedAt: iso(-86_400_000), lastOpenedAt: iso(-60_000), source: 'local', status: 'ok' })

function serve({ body = SNAPSHOT, status = 200, order = ['gamma', 'alpha'] }: { body?: unknown; status?: number; order?: string[] } = {}) {
  fetchMock.mockImplementation(async (input) => {
    const path = new URL(String(input), 'http://cockpit.test').pathname
    if (path === '/api/v1/workspace/activity') return jsonResponse(body, status)
    if (path === '/api/v1/projects') return jsonResponse({ projects: ['alpha', 'beta', 'gamma', 'delta', 'eps'].map(registryEntry), bootProject: 'alpha', projectsDir: '~/projects' })
    if (path === '/api/v1/workspace/ui-state') return jsonResponse({ sidebar: { projectOrder: order } })
    return jsonResponse({ error: 'not found' }, 404)
  })
}

function renderRoute() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/activity']}>
        <GlobalActivityRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const panelIds = () => Array.from(document.querySelectorAll('[data-slot="activity-panel"]')).map((panel) => panel.getAttribute('data-project'))
const panel = (id: string) => document.querySelector(`[data-slot="activity-panel"][data-project="${id}"]`) as HTMLElement
const pill = (runId: string) => document.querySelector(`[data-activity-pill="${runId}"]`) as HTMLElement
const chip = (label: string) => document.querySelector(`[data-chip="${label}"]`)?.textContent
const lineText = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-slot="activity-line-text"] li')).map((li) => li.textContent)

describe('GlobalActivityRoute', () => {
  it('shows one panel per project with work or a notice, in project-rail order', async () => {
    serve()
    renderRoute()
    // The rail puts projects the stored order does not name first, in registry order; zeta is not
    // registered and has no panel anyway.
    await waitFor(() => expect(panelIds()).toEqual(['beta', 'eps', 'gamma', 'alpha']))
  })

  it('collapses loaded idle projects into one line, and never an unloaded or unavailable one', async () => {
    serve()
    renderRoute()
    const idle = await screen.findByText(/more projects have no active work/)
    expect(idle.textContent).toBe('2 more projects have no active work: delta, zeta')
    expect(within(idle).getByRole('link', { name: 'delta' }).getAttribute('href')).toBe('/p/delta/activity')
    expect(within(idle).queryByRole('link', { name: 'beta' })).toBeNull()
    expect(within(idle).queryByRole('link', { name: 'eps' })).toBeNull()
    expect(panel('beta').textContent).toContain('Not loaded in this cockpit')
    expect(within(panel('beta')).getByRole('link', { name: 'Open project →' }).getAttribute('href')).toBe('/p/beta/')
    expect(panel('eps').textContent).toContain('The run store is locked by another process.')
  })

  it('counts every project in the summary chips and offers the scope switch', async () => {
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 2, name: 'alpha' })
    expect(chip('needs you')).toBe('1 needs you')
    expect(chip('working')).toBe('2 working')
    expect(chip('active workers')).toBe('2 active workers')
    expect(chip('open requests')).toBe('2 open requests')
    expect(chip('in review')).toBe('3 in review')
    expect(screen.getByRole('link', { name: /3 in review/ }).getAttribute('href')).toBe('/tasks')
    const scope = screen.getByRole('navigation', { name: 'Activity scope' })
    expect(within(scope).getByRole('link', { name: 'All projects' }).getAttribute('aria-current')).toBe('page')
    expect(within(scope).getByRole('link', { name: 'This project' }).getAttribute('href')).toBe('/p/alpha/activity')
  })

  it('draws a pill per card with its verb, main line, heartbeat and one dot per live worker', async () => {
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 2, name: 'gamma' })
    expect(within(panel('alpha')).getByRole('link', { name: 'Open project activity →' }).getAttribute('href')).toBe('/p/alpha/activity')
    expect(panel('gamma').querySelector('[data-slot="activity-panel-detail"]')?.textContent).toBe('1 active task · 2 workers')
    expect(pill('a2').querySelector('[data-slot="activity-pill-line"]')?.textContent).toBe('Needs you · Retry the shard?')
    expect(pill('a1').querySelector('[data-slot="activity-heartbeat"]')).not.toBeNull()
    expect(pill('g1').querySelectorAll('[data-slot="activity-pill-workers"] [data-activity-anchor]')).toHaveLength(2)
    expect(pill('g1').querySelector('[data-slot="activity-pill-workers"]')?.textContent).toBe('2 workers')
  })

  it('draws an arc only between two pills of one panel', async () => {
    // The label's age ticks from the server clock and the client's receive time: about 4:10.
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 2, name: 'gamma' })
    await waitFor(() => expect(panel('alpha').querySelector(`path[data-request="${ALPHA_PEER.requestId}"]`)).not.toBeNull())
    expect(panel('alpha').querySelector(`[data-slot="activity-arc-label"][data-request="${ALPHA_PEER.requestId}"]`)?.textContent).toMatch(/^Request · 4:\d{2}$/)
    expect(document.querySelector(`path[data-request="${GAMMA_AWAY.requestId}"]`)).toBeNull()
    expect(panel('gamma').querySelector('[data-slot="activity-arcs"]')).toBeNull()
  })

  it('makes each pill a link to its task, with the text form of its arcs', async () => {
    serve()
    renderRoute()
    await screen.findByRole('heading', { level: 2, name: 'alpha' })
    expect(within(pill('a1')).getByRole('link', { name: 'Porting upstream SSE' }).getAttribute('href')).toBe('/p/alpha/tasks/a1')
    expect(within(pill('g1')).getByRole('link', { name: 'Adding verdict schema' }).getAttribute('href')).toBe('/p/gamma/tasks/g1')
    expect(lineText(pill('a1'))).toEqual(['Waiting for a reply from Fixing flaky shard'])
    expect(lineText(pill('a2'))).toEqual(['Porting upstream SSE waits for your reply'])
    expect(lineText(pill('g1'))).toEqual(['Waiting for a reply from Porting upstream SSE'])
    // The narrow layout names the peer on the sender pill instead of the arc.
    expect(within(pill('a1')).getByRole('link', { name: '→ Fixing flaky shard' }).getAttribute('href')).toBe('/p/alpha/tasks/a2')
  })

  it('says when there is no project to show', async () => {
    serve({ body: snapshot() })
    renderRoute()
    expect(await screen.findByText('No projects to show.')).toBeTruthy()
  })

  it('says so when the snapshot cannot be read, with a retry', async () => {
    serve({ status: 404, body: { error: 'project not found' } })
    renderRoute()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not load activity')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
