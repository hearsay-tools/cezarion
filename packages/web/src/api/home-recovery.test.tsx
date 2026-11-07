import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { onLiveReconcile } from './live-coordinator'
import { queryKeys, workspaceQueryKeys } from './queries'
import { subscribeTopic } from './ws'
import { getHomeRecovery, HOME_RECOVERY_QUERY_KEY, useAcceptHomeRecovery, useHomeRecovery,
  useHomeRecoverySubscription, useRestoreHomeRecovery } from './home-recovery'

vi.mock('./ws', () => ({ subscribeTopic: vi.fn() }))
vi.mock('./live-coordinator', async original => ({
  ...await original<typeof import('./live-coordinator')>(), onLiveReconcile: vi.fn(), invalidateLiveReads: vi.fn(),
}))

const fetchMock = vi.fn<typeof fetch>()
const clients: QueryClient[] = []
const flagged = { files: [{ file: 'config.json', reason: 'outside-write', detectedAt: '2026-11-07T09:00:00.000Z', canRestore: true }] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.mocked(subscribeTopic).mockReturnValue(() => {})
  vi.mocked(onLiveReconcile).mockReturnValue(() => {})
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function setup(local = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(queryKeys.health, { capabilities: { localHandoff: local } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, wrapper }
}

it('reads one workspace snapshot and turns malformed server bodies into API errors', async () => {
  fetchMock.mockResolvedValueOnce(json(flagged))
  const { wrapper } = setup()
  const hook = renderHook(() => useHomeRecovery(), { wrapper })
  await waitFor(() => expect(hook.result.current.data).toEqual(flagged))
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/home/recovery')
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', signal: expect.any(AbortSignal) })
  expect(subscribeTopic).not.toHaveBeenCalled()
  fetchMock.mockResolvedValueOnce(json({ files: 'invalid' }))
  await expect(getHomeRecovery()).rejects.toThrow('unexpected body')
});

it('holds one local topic after bootstrap, validates frames, and releases it while hidden', async () => {
  const { client, wrapper } = setup(false)
  const release = vi.fn()
  vi.mocked(subscribeTopic).mockReturnValue(release)
  client.setQueryData(queryKeys.health, {}) // An incomplete bootstrap must keep topic demand closed.
  const hook = renderHook(() => useHomeRecoverySubscription(), { wrapper })
  expect(subscribeTopic).not.toHaveBeenCalled()
  act(() => client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true } }))
  expect(subscribeTopic).toHaveBeenCalledTimes(1)
  expect(subscribeTopic).toHaveBeenCalledWith('home:recovery', expect.any(Function))
  const frame = vi.mocked(subscribeTopic).mock.calls[0]![1]
  await act(async () => { frame(flagged) })
  expect(client.getQueryData(HOME_RECOVERY_QUERY_KEY)).toEqual(flagged)
  fetchMock.mockResolvedValueOnce(json(flagged))
  await act(async () => { frame({ files: 'invalid' }) })
  expect(client.getQueryData(HOME_RECOVERY_QUERY_KEY)).toEqual(flagged)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(release).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  hook.unmount()
  expect(release).toHaveBeenCalledTimes(1)
});

it('uses finite authenticated reconciliation in remote mode and does no periodic or hidden read', async () => {
  const { client, wrapper } = setup(false)
  renderHook(() => useHomeRecoverySubscription(), { wrapper })
  expect(subscribeTopic).not.toHaveBeenCalled()
  const reconcile = vi.mocked(onLiveReconcile).mock.calls[0]![0]
  const signal = new AbortController().signal
  await act(async () => { await reconcile(signal, true) })
  expect(fetchMock).not.toHaveBeenCalled()
  fetchMock.mockResolvedValueOnce(json(flagged))
  await act(async () => { await reconcile(signal, false) })
  expect(client.getQueryData(HOME_RECOVERY_QUERY_KEY)).toEqual(flagged)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => { await reconcile(signal, false) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
});

it('does not read while hidden and reports an HTTP read error without inventing a banner', async () => {
  const { wrapper } = setup()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const hook = renderHook(() => useHomeRecovery(), { wrapper })
  expect(fetchMock).not.toHaveBeenCalled()
  fetchMock.mockResolvedValueOnce(json({ error: 'Home cannot be read' }, 409))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => expect(hook.result.current.error).toBeInstanceOf(ApiError))
  expect(hook.result.current.error?.message).toBe('Home cannot be read')
  expect(hook.result.current.data).toBeUndefined()
});

it('cancels a finite recovery read when the page becomes hidden', async () => {
  const { client, wrapper } = setup(false)
  fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Hidden page', 'AbortError')), { once: true })
  }))
  renderHook(() => useHomeRecoverySubscription(), { wrapper })
  const reconcile = vi.mocked(onLiveReconcile).mock.calls[0]![0]
  const settled = Promise.resolve(reconcile(new AbortController().signal, false)).then(() => 'resolved', () => 'rejected')
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(await settled).toBe('rejected')
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  expect(client.getQueryData(HOME_RECOVERY_QUERY_KEY)).toBeUndefined()
});

it('writes restore and accept actions, keeps their authoritative result, and refreshes the affected caches', async () => {
  const { client, wrapper } = setup()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const hooks = renderHook(() => ({ restore: useRestoreHomeRecovery(), accept: useAcceptHomeRecovery() }), { wrapper })
  client.setQueryData(HOME_RECOVERY_QUERY_KEY, flagged)
  fetchMock.mockResolvedValueOnce(json({ files: [] }))
  await act(async () => { await hooks.result.current.restore.mutateAsync('config.json') })
  expect(client.getQueryData(HOME_RECOVERY_QUERY_KEY)).toEqual({ files: [] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.projects })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.config })
  fetchMock.mockResolvedValueOnce(json({ files: [] }))
  await act(async () => { await hooks.result.current.accept.mutateAsync('agent-accounts.json') })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.agentProfiles })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.providerStatus })
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
    ['/api/v1/home/recovery/restore', 'POST', JSON.stringify({ file: 'config.json' })],
    ['/api/v1/home/recovery/accept', 'POST', JSON.stringify({ file: 'agent-accounts.json' })],
  ])
  client.setQueryData(HOME_RECOVERY_QUERY_KEY, flagged)
  fetchMock.mockResolvedValueOnce(json({ error: 'Backup cannot be read' }, 409))
  await act(async () => { await expect(hooks.result.current.restore.mutateAsync('config.json')).rejects.toThrow('Backup cannot be read') })
  expect(client.getQueryData(HOME_RECOVERY_QUERY_KEY)).toEqual(flagged)
});
