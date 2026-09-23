import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { useApplicationUpdate } from './use-application-update'

const fetchMock = vi.fn<typeof fetch>()
const health = { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'idle', supported: true } } as HealthResponse
afterEach(() => { fetchMock.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('prevents duplicate apply and reconciles the returned state into health', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal('fetch', fetchMock.mockImplementation(() => new Promise((done) => { resolve = done })))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, health)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useApplicationUpdate(health), { wrapper })
  act(() => { void result.current.apply(); void result.current.apply() })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  act(() => resolve(new Response(JSON.stringify({ state: { status: 'ready', supported: true, targetVersion: '2.0.0' } }), { headers: { 'content-type': 'application/json' } })))
  await waitFor(() => expect(client.getQueryData<HealthResponse>(queryKeys.health)?.applicationUpdate?.status).toBe('ready'))
})

it('preserves actionable state and explains a failed request', async () => {
  vi.stubGlobal('fetch', fetchMock.mockRejectedValue(new Error('Network unavailable')))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, health)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useApplicationUpdate(health), { wrapper })
  await act(async () => { await result.current.apply() })
  expect(result.current.error).toMatch(/cannot reach the cezar server/)
  expect(client.getQueryData<HealthResponse>(queryKeys.health)?.applicationUpdate?.status).toBe('idle')
})

it('reloads once after authoritative health confirms the new running version', async () => {
  vi.stubGlobal('fetch', fetchMock.mockResolvedValue(new Response(JSON.stringify({ state: { status: 'restarting', supported: true, targetVersion: '2.0.0' } }), { headers: { 'content-type': 'application/json' } })))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, health)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const reload = vi.fn()
  const { result, rerender } = renderHook(({ current }) => useApplicationUpdate(current, reload), { wrapper, initialProps: { current: health } })
  await act(async () => { await result.current.restart() })
  expect(reload).not.toHaveBeenCalled()
  rerender({ current: { ...health, version: '2.0.0', applicationUpdate: { status: 'idle', supported: true } } })
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  expect(sessionStorage.getItem('cez:application-restart-from')).toBeNull()
})

it('reacts to offline and online events without forgetting health state', async () => {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, health)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useApplicationUpdate(health), { wrapper })
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  act(() => window.dispatchEvent(new Event('offline')))
  expect(result.current.offline).toBe(true)
  expect(client.getQueryData<HealthResponse>(queryKeys.health)?.applicationUpdate?.status).toBe('idle')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  act(() => window.dispatchEvent(new Event('online')))
  expect(result.current.offline).toBe(false)
})

it('refreshes assets when another tab confirms a new running version', async () => {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const reload = vi.fn()
  const { rerender } = renderHook(({ current }) => useApplicationUpdate(current, reload), { wrapper, initialProps: { current: health } })
  rerender({ current: { ...health, version: '2.0.0', applicationUpdate: { status: 'idle', supported: true } } })
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
})

it('reloads a newly booted version when a prior restart marker survived navigation', async () => {
  sessionStorage.setItem('cez:application-restart-from', '1.0.0')
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const reload = vi.fn()
  renderHook(() => useApplicationUpdate({ ...health, version: '2.0.0' }, reload), { wrapper })
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  expect(sessionStorage.getItem('cez:application-restart-from')).toBeNull()
})

it('clears a transient network error when health reports Ready', async () => {
  vi.stubGlobal('fetch', fetchMock.mockRejectedValue(new Error('offline')))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, health)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, rerender } = renderHook(({ current }) => useApplicationUpdate(current), { wrapper, initialProps: { current: health } })
  await act(async () => { await result.current.apply() })
  expect(result.current.error).not.toBeNull()
  rerender({ current: { ...health, applicationUpdate: { status: 'ready', supported: true, targetVersion: '2.0.0' } } })
  await waitFor(() => expect(result.current.error).toBeNull())
})

it('does not arm an asset reload when restart acknowledgement fails', async () => {
  vi.stubGlobal('fetch', fetchMock.mockRejectedValue(new Error('offline')))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { ...health, applicationUpdate: { status: 'restarting', supported: true } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useApplicationUpdate(health), { wrapper })
  await act(async () => { await result.current.restart() })
  expect(result.current.error).not.toBeNull()
  expect(sessionStorage.getItem('cez:application-restart-from')).toBeNull()
})
