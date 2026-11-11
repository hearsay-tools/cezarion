import { productCommand } from '@/lib/product-name'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/api/queries'
import { skillSourcesKey } from '@/api/skill-sources-client'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { createQueryClient } from '@/api/query-client'
import type { TeamSkillSource, TeamSkillSourcesResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { statusText, TeamSourcesPanel } from './team-sources-panel'

/**
 * The team skill sources panel (hearsay-tools/cezarion#279) against a stubbed
 * `/api/v1/skills/sources`: the empty state, Add and its format check, enable and disable,
 * Remove, a failing source's Retry, and the read-only and unreadable-config notes.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const source = (over: Partial<TeamSkillSource> & Pick<TeamSkillSource, 'repo'>): TeamSkillSource => ({
  ref: 'main',
  enabled: true,
  status: { state: 'ok', skillCount: 2 },
  ...over,
})

/** While set, a GET of the sources answers only when the test calls `release`, with the list as
 *  it was when the GET arrived. */
let heldReads: { release: () => void } | undefined
/** While set, a write answers only when the test calls `release`, with the list it made. */
let heldWrites: Array<{ method: string; release: () => void }> = []

function serve(
  initial: Partial<TeamSkillSourcesResponse> = {},
  { failAdd, holdReads = false, holdWrites = [] }: { failAdd?: string; holdReads?: boolean; holdWrites?: string[] } = {},
) {
  requests = []
  heldReads = undefined
  heldWrites = []
  let state: TeamSkillSourcesResponse = { sources: [], editable: true, configIssue: null, ...initial }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      const answer = (method: string, made: TeamSkillSourcesResponse) => {
        if (!holdWrites.includes(method)) return json(made)
        return new Promise<Response>((resolve) => { heldWrites.push({ method, release: () => resolve(json(made)) }) })
      }
      if (url === '/api/v1/skills/sources/retry') {
        state = { ...state, sources: state.sources.map((s) => (s.repo === body?.repo ? { ...s, status: { state: 'ok', skillCount: 1 } } : s)) }
        return answer('RETRY', state)
      }
      if (url !== '/api/v1/skills/sources') return new Promise<never>(() => {})
      if (method === 'GET' && holdReads && requests.filter((r) => r.method === 'GET').length > 1) {
        const snapshot = state
        return new Promise<Response>((resolve) => { heldReads = { release: () => resolve(json(snapshot)) } })
      }
      if (method === 'POST') {
        if (failAdd) return json({ error: failAdd }, 409)
        state = { ...state, sources: [...state.sources, source({ repo: String(body?.repo), ref: String(body?.ref ?? 'main'), status: { state: 'ok', skillCount: 1 } })] }
      }
      if (method === 'PATCH') {
        state = { ...state, sources: state.sources.map((s) => (s.repo === body?.repo ? { ...s, enabled: Boolean(body?.enabled), status: { state: 'idle' } } : s)) }
      }
      if (method === 'DELETE') state = { ...state, sources: state.sources.filter((s) => s.repo !== body?.repo) }
      return method === 'GET' ? json(state) : answer(method, state)
    }),
  )
}

function renderPanel() {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <div className="@container">
        <TeamSourcesPanel />
      </div>
      <Toaster />
    </QueryClientProvider>,
  )
  return client
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="skill-source"]')]
const rowFor = (repo: string) => document.querySelector<HTMLElement>(`[data-slot="skill-source"][data-repo="${repo}"]`)
const field = (slot: string) => document.querySelector<HTMLInputElement>(`[data-slot="${slot}"]`)!
const writes = () => requests.filter((r) => r.method !== 'GET')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('TeamSourcesPanel', () => {
  it('with no sources says how to add one, and adds a repo with the default ref', async () => {
    serve()
    renderPanel()
    await waitFor(() => expect(document.querySelector('[data-slot="skill-sources-empty"]')).not.toBeNull())
    fireEvent.change(field('skill-source-repo'), { target: { value: ' acme/skills ' } })
    fireEvent.click(field('skill-source-submit'))
    await waitFor(() => expect(rowFor('acme/skills')).not.toBeNull())
    expect(writes()).toEqual([{ method: 'POST', url: '/api/v1/skills/sources', body: { repo: 'acme/skills' } }])
    expect(rowFor('acme/skills')?.textContent).toContain('1 skill')
    expect(field('skill-source-repo').value).toBe('')
  })

  it('sends a ref the user typed', async () => {
    serve()
    renderPanel()
    await waitFor(() => expect(field('skill-source-repo')).not.toBeNull())
    fireEvent.change(field('skill-source-repo'), { target: { value: 'acme/skills' } })
    fireEvent.change(field('skill-source-ref'), { target: { value: 'v2' } })
    fireEvent.click(field('skill-source-submit'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]?.body).toEqual({ repo: 'acme/skills', ref: 'v2' })
  })

  it('refuses a repo format before sending it, and names the accepted formats', async () => {
    serve()
    renderPanel()
    await waitFor(() => expect(field('skill-source-repo')).not.toBeNull())
    fireEvent.change(field('skill-source-repo'), { target: { value: 'ext::sh -c evil' } })
    fireEvent.click(field('skill-source-submit'))
    const problem = await waitFor(() => {
      const found = document.querySelector('[data-slot="skill-source-problem"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(problem.getAttribute('role')).toBe('alert')
    expect(problem.textContent).toContain('owner/name')
    expect(field('skill-source-repo').getAttribute('aria-invalid')).toBe('true')
    expect(writes()).toEqual([])
  })

  it('shows a refused add in a toast with the server message', async () => {
    serve({ sources: [source({ repo: 'acme/skills' })] }, { failAdd: 'acme/skills at main is already listed.' })
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.change(field('skill-source-repo'), { target: { value: 'acme/skills' } })
    fireEvent.click(field('skill-source-submit'))
    await waitFor(() => expect(document.body.textContent).toContain('acme/skills at main is already listed.'))
    expect(rows()).toHaveLength(1)
  })

  it('a failing source names its cause and retries, while the other source keeps its count', async () => {
    serve({
      sources: [
        source({ repo: 'acme/skills' }),
        source({ repo: 'acme/broken', status: { state: 'error', cause: 'fetch-failed', detail: 'git clone failed: not found.', skillCount: 0 } }),
      ],
    })
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rowFor('acme/skills')?.textContent).toContain('2 skills')
    const status = rowFor('acme/broken')!.querySelector('[data-slot="skill-source-status"]')!
    expect(status.getAttribute('role')).toBe('alert')
    expect(status.textContent).toContain('git clone failed: not found.')
    expect(status.textContent).toContain('then Retry')
    expect(rowFor('acme/skills')?.querySelector('[data-slot="skill-source-retry"]')).toBeNull()
    fireEvent.click(rowFor('acme/broken')!.querySelector('[data-slot="skill-source-retry"]')!)
    await waitFor(() => expect(rowFor('acme/broken')?.textContent).toContain('1 skill'))
    expect(writes()).toEqual([{ method: 'POST', url: '/api/v1/skills/sources/retry', body: { repo: 'acme/broken', ref: 'main' } }])
  })

  it('disables a source with its switch, and removes one with a toast about restoring switches', async () => {
    serve({ sources: [source({ repo: 'acme/skills' }), source({ repo: 'acme/other' })] })
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    const toggle = rowFor('acme/skills')!.querySelector<HTMLButtonElement>('[data-slot="skill-source-switch"]')!
    expect(toggle.getAttribute('aria-label')).toBe('Enable acme/skills @ main')
    fireEvent.click(toggle)
    await waitFor(() => expect(rowFor('acme/skills')?.getAttribute('data-state')).toBe('disabled'))
    expect(rowFor('acme/skills')?.textContent).toContain('Disabled.')
    expect(writes()[0]).toEqual({ method: 'PATCH', url: '/api/v1/skills/sources', body: { repo: 'acme/skills', ref: 'main', enabled: false } })

    fireEvent.click(rowFor('acme/other')!.querySelector('[data-slot="skill-source-remove"]')!)
    await waitFor(() => expect(rowFor('acme/other')).toBeNull())
    expect(document.body.textContent).toContain('Removed acme/other @ main. Add it again to restore its skill switches.')
  })

  it('a source change also marks the wait=1 skill reads stale, so an older answer cannot bring skills back', async () => {
    serve({ sources: [source({ repo: 'acme/skills' })] })
    const client = renderPanel()
    for (const key of [queryKeys.skillsReady, queryKeys.importableSkillsReady]) client.setQueryData(key, [])
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rowFor('acme/skills')!.querySelector('[data-slot="skill-source-remove"]')!)
    await waitFor(() => expect(rowFor('acme/skills')).toBeNull())
    expect(client.getQueryState(queryKeys.skillsReady)?.isInvalidated).toBe(true)
    expect(client.getQueryState(queryKeys.importableSkillsReady)?.isInvalidated).toBe(true)
  })

  it('a source read already in flight does not overwrite the answer of a later change', async () => {
    serve({ sources: [source({ repo: 'acme/skills' }), source({ repo: 'acme/other' })] }, { holdReads: true })
    const client = renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    void client.refetchQueries({ queryKey: skillSourcesKey() })
    await waitFor(() => expect(heldReads).toBeDefined())
    fireEvent.click(rowFor('acme/other')!.querySelector('[data-slot="skill-source-remove"]')!)
    await waitFor(() => expect(rowFor('acme/other')).toBeNull())
    await act(async () => heldReads!.release())
    // bound: the held read settles in microtasks; this guards only against a hang
    await waitFor(() => expect(client.isFetching({ queryKey: skillSourcesKey() })).toBe(0))
    expect(rowFor('acme/other')).toBeNull()
  })

  it('two writes that answer out of order still end on the server list', async () => {
    serve({
      sources: [
        source({ repo: 'acme/broken', status: { state: 'error', cause: 'fetch-failed', detail: 'no access.', skillCount: 0 } }),
        source({ repo: 'acme/other' }),
      ],
    }, { holdWrites: ['RETRY'] })
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(rowFor('acme/broken')!.querySelector('[data-slot="skill-source-retry"]')!)
    await waitFor(() => expect(heldWrites).toHaveLength(1))
    fireEvent.click(rowFor('acme/other')!.querySelector('[data-slot="skill-source-remove"]')!)
    await waitFor(() => expect(rowFor('acme/other')).toBeNull())
    // The Retry answer was made before the Remove, so it still lists the removed source.
    await act(async () => heldWrites[0]!.release())
    await waitFor(() => expect(rowFor('acme/broken')?.textContent).toContain('1 skill'))
    await waitFor(() => expect(rowFor('acme/other')).toBeNull())
  })

  it('a write that answers after a project switch writes only its own project cache', async () => {
    serve({ sources: [source({ repo: 'acme/skills' })] }, { holdWrites: ['DELETE'] })
    const client = renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(1))
    const openKey = skillSourcesKey()
    fireEvent.click(rowFor('acme/skills')!.querySelector('[data-slot="skill-source-remove"]')!)
    await waitFor(() => expect(heldWrites).toHaveLength(1))
    try {
      setApiScope('other-project')
      client.setQueryData(skillSourcesKey(), { sources: [source({ repo: 'other/skills' })], editable: true, configIssue: null })
      await act(async () => heldWrites[0]!.release())
      await waitFor(() => expect(client.getQueryData<TeamSkillSourcesResponse>(openKey)?.sources).toEqual([]))
      expect(client.getQueryData<TeamSkillSourcesResponse>(skillSourcesKey())?.sources.map((s) => s.repo)).toEqual(['other/skills'])
    } finally {
      setApiScope(null)
    }
  })

  it('is read-only on a remote cockpit', async () => {
    serve({ sources: [source({ repo: 'acme/skills' })], editable: false })
    renderPanel()
    await waitFor(() => expect(document.querySelector('[data-slot="skill-sources-read-only"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="skill-sources-read-only"]')?.textContent).toContain(`${productCommand()} remote-settings enable`)
    expect(rowFor('acme/skills')!.querySelector<HTMLButtonElement>('[data-slot="skill-source-switch"]')!.disabled).toBe(true)
    expect(rowFor('acme/skills')!.querySelector<HTMLButtonElement>('[data-slot="skill-source-remove"]')!.disabled).toBe(true)
    expect(field('skill-source-submit').disabled).toBe(true)
  })

  it('an unreadable config.json shows its issue and locks the form', async () => {
    serve({ configIssue: '.ai/cezar/config.json cannot be read: Unexpected token. Fix the file, then reload.' })
    renderPanel()
    const notice = await waitFor(() => {
      const found = document.querySelector('[data-slot="skill-sources-config-issue"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toContain('Fix the file')
    expect(document.querySelector('[data-slot="skill-sources-empty"]')).toBeNull()
    expect(field('skill-source-submit').disabled).toBe(true)
  })
})

describe('statusText', () => {
  it('says what to try next for each cause', () => {
    const failed = (cause: 'refused-format' | 'fetch-failed' | 'ref-not-found', skillCount = 0) =>
      statusText(source({ repo: 'r', status: { state: 'error', cause, detail: 'The ref "x" was not found in r.', skillCount } }))
    expect(failed('refused-format')).toContain('Remove it, then add it as owner/name')
    expect(failed('ref-not-found')).toBe('The ref "x" was not found in r. Check the ref, or remove the source and add it with another ref.')
    expect(failed('fetch-failed', 3)).toContain('Skills from an earlier fetch still show.')
    const gitSays = statusText(source({ repo: 'r', status: { state: 'error', cause: 'fetch-failed', detail: "fatal: 'r' does not exist", skillCount: 0 } }))
    expect(gitSays).toBe("Could not fetch: fatal: 'r' does not exist. Check the network and your access to the repo, then Retry.")
    expect(statusText(source({ repo: 'r', status: { state: 'loading' } }))).toBe('Fetching…')
    expect(statusText(source({ repo: 'r', status: { state: 'ok', skillCount: 1 } }))).toBe('1 skill')
  })
})
