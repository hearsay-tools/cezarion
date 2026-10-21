import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { useSkillSelection } from './use-skill-selection'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast: toastMock }))

/**
 * The write half of the per-project default-skill selection (hearsay-tools/cezarion#1408, port of
 * upstream open-mercato/cezar#1082). Pinned here: the first toggle expands "not curated" into an
 * explicit list, quick toggles reach the server in order, a save queued in one project never lands
 * in another, and a failed save does not leave a switch the file never took.
 */

const NAMES = ['om-fix', 'om-review', 'om-plan'] as const

let files: Record<string, Record<string, unknown>>
let puts: Array<{ project: string; body: Record<string, unknown> }>
let failWrites: string | null
let heldWrites: Array<() => void>
let holdWrites: boolean
const fetchMock = vi.fn<typeof fetch>()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  files = { a: {}, b: {} }
  puts = []
  failWrites = null
  heldWrites = []
  holdWrites = false
  toastMock.mockReset()
  fetchMock.mockImplementation(async (input, init) => {
    const match = /^\/api\/v1\/p\/([^/]+)\/ui-state$/.exec(String(input))
    if (!match) return json({ error: 'not found' }, 404)
    const project = match[1]!
    if ((init?.method ?? 'GET') !== 'PUT') return json(files[project] ?? {})
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    puts.push({ project, body })
    if (holdWrites) await new Promise<void>((resolve) => heldWrites.push(resolve))
    if (failWrites !== null) return json({ error: failWrites }, 500)
    files[project] = { ...files[project], ...body }
    return json(files[project])
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function mount(projectId = 'a', client: QueryClient = createQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = renderHook(({ project }) => useSkillSelection(project, NAMES), {
    wrapper,
    initialProps: { project: projectId },
  })
  return { ...view, client }
}

const enabledOf = (view: ReturnType<typeof mount>) => [...view.result.current.enabled].sort()

describe('useSkillSelection', () => {
  it('enables every offered skill while the project has no selection', async () => {
    const view = mount()
    await waitFor(() => expect(view.client.getQueryData(['a', 'ui-state'])).toBeDefined())
    expect(enabledOf(view)).toEqual([...NAMES].sort())
  })

  it('the first toggle expands "not curated" into every offered name but the toggled one', async () => {
    const view = mount()
    await waitFor(() => expect(view.client.getQueryData(['a', 'ui-state'])).toBeDefined())
    act(() => view.result.current.toggle('om-review'))
    expect(enabledOf(view)).toEqual(['om-fix', 'om-plan'])
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ project: 'a', body: { importedSkills: ['om-fix', 'om-plan'] } })
  })

  it('two quick toggles both persist, in order', async () => {
    const view = mount()
    await waitFor(() => expect(view.client.getQueryData(['a', 'ui-state'])).toBeDefined())
    act(() => {
      view.result.current.toggle('om-fix')
      view.result.current.toggle('om-plan')
    })
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts.map((put) => put.body.importedSkills)).toEqual([['om-review', 'om-plan'], ['om-review']])
    await waitFor(() => expect(view.result.current.pending).toBe(false))
    expect(files.a!.importedSkills).toEqual(['om-review'])
    expect(enabledOf(view)).toEqual(['om-review'])
  })

  it('keeps a queued save on its project', async () => {
    const view = mount('a')
    await waitFor(() => expect(view.client.getQueryData(['a', 'ui-state'])).toBeDefined())
    holdWrites = true
    act(() => view.result.current.toggle('om-fix'))
    await waitFor(() => expect(puts).toHaveLength(1))
    view.rerender({ project: 'b' })
    await waitFor(() => expect(view.client.getQueryData(['b', 'ui-state'])).toBeDefined())
    act(() => heldWrites.splice(0).forEach((release) => release()))
    await waitFor(() => expect(view.result.current.pending).toBe(false))
    expect(puts.map((put) => put.project)).toEqual(['a'])
    expect(files.a!.importedSkills).toEqual(['om-review', 'om-plan'])
    expect(files.b).toEqual({})
    expect(view.client.getQueryData(['b', 'ui-state'])).toEqual({})
    expect(enabledOf(view)).toEqual([...NAMES].sort())
  })

  it('a failed save toasts and the switch goes back to the stored value', async () => {
    files.a = { importedSkills: ['om-fix'] }
    const view = mount()
    await waitFor(() => expect(enabledOf(view)).toEqual(['om-fix']))
    failWrites = 'disk full'
    act(() => view.result.current.toggle('om-plan'))
    expect(enabledOf(view)).toEqual(['om-fix', 'om-plan'])
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(String(toastMock.mock.calls[0]![0])).toContain('disk full')
    await waitFor(() => expect(enabledOf(view)).toEqual(['om-fix']))
  })

  it('a legacy selection the server answers seeds the switches', async () => {
    // GET /ui-state answers the workspace value when the project has none of its own.
    files.a = { importedSkills: ['om-plan'] }
    const view = mount()
    await waitFor(() => expect(enabledOf(view)).toEqual(['om-plan']))
  })

  it('a successful save re-reads that project skills, catalog and importable list alike', async () => {
    const view = mount()
    await waitFor(() => expect(view.client.getQueryData(['a', 'ui-state'])).toBeDefined())
    view.client.setQueryData(['a', 'skills'], [])
    view.client.setQueryData(['a', 'skills', 'importable'], [])
    view.client.setQueryData(['b', 'skills'], [])
    act(() => view.result.current.toggle('om-fix'))
    await waitFor(() => expect(view.client.getQueryState(['a', 'skills'])?.isInvalidated).toBe(true))
    expect(view.client.getQueryState(['a', 'skills', 'importable'])?.isInvalidated).toBe(true)
    expect(view.client.getQueryState(['b', 'skills'])?.isInvalidated).toBe(false)
  })
})
