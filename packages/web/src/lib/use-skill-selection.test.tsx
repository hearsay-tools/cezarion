import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { useTeamSkillSwitches } from './use-skill-selection'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast: toastMock }))

/**
 * The write half of the per-project team-skill off-list (hearsay-tools/cezarion#1494). Pinned
 * here: an absent list switches nothing off, quick toggles reach the server in order, a save
 * queued in one project never lands in another, and a failed save does not leave a switch the
 * file never took.
 */

const X = { repo: 'a/s', name: 'x' } as const
const Y = { repo: 'a/s', name: 'y' } as const
const X_OTHER = { repo: 'b/s', name: 'x' } as const

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
  const view = renderHook(({ project }) => useTeamSkillSwitches(project), {
    wrapper,
    initialProps: { project: projectId },
  })
  return { ...view, client }
}

const loaded = (view: ReturnType<typeof mount>, project = 'a') =>
  waitFor(() => expect(view.client.getQueryData([project, 'ui-state'])).toBeDefined())

describe('useTeamSkillSwitches', () => {
  it('with no stored list, every team skill is on', async () => {
    const view = mount()
    await loaded(view)
    expect(view.result.current.ready).toBe(true)
    expect(view.result.current.disabled).toEqual([])
    for (const ref of [X, Y, X_OTHER]) expect(view.result.current.isOn(ref)).toBe(true)
  })

  it('a toggle adds the ref to the off-list, and a second toggle removes it', async () => {
    const view = mount()
    await loaded(view)
    act(() => view.result.current.toggle(X))
    expect(view.result.current.isOn(X)).toBe(false)
    // Same name, other source: still on.
    expect(view.result.current.isOn(X_OTHER)).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ project: 'a', body: { disabledTeamSkills: [{ repo: 'a/s', name: 'x' }] } })
    act(() => view.result.current.toggle(X))
    expect(view.result.current.isOn(X)).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toEqual({ project: 'a', body: { disabledTeamSkills: [] } })
  })

  it('two quick toggles both persist, in order', async () => {
    const view = mount()
    await loaded(view)
    act(() => {
      view.result.current.toggle(X)
      view.result.current.toggle(Y)
    })
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts.map((put) => put.body.disabledTeamSkills)).toEqual([[X], [X, Y]])
    await waitFor(() => expect(view.result.current.pending).toBe(false))
    expect(files.a!.disabledTeamSkills).toEqual([X, Y])
  })

  it('ignores junk entries in a hand-edited list', async () => {
    files.a = { disabledTeamSkills: ['x', { name: 'x' }, 7, Y] }
    const view = mount()
    await waitFor(() => expect(view.result.current.isOn(Y)).toBe(false))
    expect(view.result.current.isOn(X)).toBe(true)
    expect(view.result.current.disabled).toEqual([Y])
  })

  it('keeps a queued save on its project', async () => {
    const view = mount('a')
    await loaded(view)
    holdWrites = true
    act(() => view.result.current.toggle(X))
    await waitFor(() => expect(puts).toHaveLength(1))
    view.rerender({ project: 'b' })
    await loaded(view, 'b')
    act(() => heldWrites.splice(0).forEach((release) => release()))
    await waitFor(() => expect(view.result.current.pending).toBe(false))
    expect(puts.map((put) => put.project)).toEqual(['a'])
    expect(files.a!.disabledTeamSkills).toEqual([X])
    expect(files.b).toEqual({})
    expect(view.client.getQueryData(['b', 'ui-state'])).toEqual({})
    expect(view.result.current.isOn(X)).toBe(true)
  })

  it('a rejected save toasts and the switch goes back to the stored value', async () => {
    files.a = { disabledTeamSkills: [Y] }
    const view = mount()
    await waitFor(() => expect(view.result.current.isOn(Y)).toBe(false))
    failWrites = 'disk full'
    act(() => view.result.current.toggle(X))
    expect(view.result.current.isOn(X)).toBe(false)
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(String(toastMock.mock.calls[0]![0])).toContain('disk full')
    await waitFor(() => expect(view.result.current.isOn(X)).toBe(true))
    expect(view.result.current.isOn(Y)).toBe(false)
  })

  it('a successful save re-reads that project skills, catalog and importable list alike', async () => {
    const view = mount()
    await loaded(view)
    view.client.setQueryData(['a', 'skills'], [])
    view.client.setQueryData(['a', 'skills', 'importable'], [])
    view.client.setQueryData(['b', 'skills'], [])
    act(() => view.result.current.toggle(X))
    await waitFor(() => expect(view.client.getQueryState(['a', 'skills'])?.isInvalidated).toBe(true))
    expect(view.client.getQueryState(['a', 'skills', 'importable'])?.isInvalidated).toBe(true)
    expect(view.client.getQueryState(['b', 'skills'])?.isInvalidated).toBe(false)
  })
})
