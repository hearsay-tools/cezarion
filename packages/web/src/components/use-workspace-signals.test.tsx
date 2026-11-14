import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { ProjectsResponse, RunsIndexResponse } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { RUNS_INDEX_RECONCILE_HOLD_MS } from '@/api/runs-index-sync'
import { useWorkspaceSignals } from './use-workspace-signals'

const project = (id: string) => ({ id, name: id, root: `/repos/${id}`, status: 'ok' })
const INDEX: RunsIndexResponse = {
  runs: [
    { projectId: 'a', id: 'a1', title: 'a1', status: RUN_STATUS.running, createdAt: '2026-01-02', archived: false, workflow: 'quick-task', workflowLabel: 'Quick task', tokensUsed: 0 },
    { projectId: 'b', id: 'b1', title: 'b1', status: RUN_STATUS.running, createdAt: '2026-01-01', archived: false, workflow: 'quick-task', workflowLabel: 'Quick task', tokensUsed: 0 },
  ] as RunsIndexResponse['runs'],
  referenceStatuses: {}, perProjectLimit: 200, truncated: ['b'], generation: 'g1', eventSeq: 0,
}

const HEALTH = { bootProject: 'a', capabilities: {} }

let client: QueryClient
/** What `GET /workspace/projects` answers: the registry ids of the moment. */
let registry: string[]
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const indexReads = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/workspace/runs-index'))
const setRegistry = (ids: string[]) => act(() => {
  registry = ids
  client.setQueryData<ProjectsResponse>(workspaceQueryKeys.projects, (current) => ({ ...current!, projects: ids.map(project) } as ProjectsResponse))
})

beforeEach(() => {
  vi.useFakeTimers()
  registry = ['a', 'b']
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(
    String(path).includes('/workspace/runs-index') ? INDEX
      : String(path).includes('/workspace/projects') ? { projects: registry.map(project), bootProject: 'a' }
        : String(path).endsWith('/health') ? HEALTH : {},
  ))))
  client = createQueryClient()
  client.setQueryData(queryKeys.health, HEALTH)
  client.setQueryData(workspaceQueryKeys.projects, { projects: registry.map(project), bootProject: 'a' })
  client.setQueryData(workspaceQueryKeys.runsIndex, INDEX)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('useWorkspaceSignals: registry id-set changes (hearsay-tools/cezarion#2729)', () => {
  it('a new project id reconciles the index once, after the hold', async () => {
    renderHook(() => useWorkspaceSignals(), { wrapper })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const before = indexReads().length
    setRegistry(['a', 'b', 'c'])
    await act(async () => vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS))
    expect(indexReads().length).toBe(before + 1)
  })

  it('a removed project id drops its rows with no request', async () => {
    renderHook(() => useWorkspaceSignals(), { wrapper })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const before = indexReads().length
    setRegistry(['a'])
    // TanStack notifies observers on its next tick.
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(client.getQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex)?.runs.map((row) => row.id)).toEqual(['a1'])
    expect(client.getQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex)?.truncated).toEqual([])
    await act(async () => vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS * 2))
    expect(indexReads().length).toBe(before)
  })

  it('a reorder or rename is not a registry change', async () => {
    renderHook(() => useWorkspaceSignals(), { wrapper })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const before = indexReads().length
    setRegistry(['b', 'a'])
    await act(async () => vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS * 2))
    expect(indexReads().length).toBe(before)
  })
})
