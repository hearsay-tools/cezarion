import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { useApplicationUpdate } from './use-application-update'
import { ApplicationUpdateControl, ApplicationUpdateFeedback } from './application-update-control'

const fetchMock = vi.fn<typeof fetch>()
const health = { version: '1.0.0', latestVersion: '2.0.0', applicationUpdate: { status: 'idle', supported: true } } as HealthResponse
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

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

it('releases the visible action when health reports Ready before a lost Apply response', async () => {
  let deliver!: (response: Response) => void
  let requestSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', fetchMock.mockImplementation((_url, init) => {
    requestSignal = init?.signal as AbortSignal | undefined
    return new Promise<Response>((resolve) => { if (!deliver) deliver = resolve })
  }))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, health)
  function Harness({ current }: { current: HealthResponse }) {
    const update = useApplicationUpdate(current)
    return <><ApplicationUpdateControl version={current.version} latestVersion={current.latestVersion ?? null}
      state={current.applicationUpdate} onApplyUpdate={update.apply} onRestart={update.restart}
      busy={update.busy} error={update.error} />
      <ApplicationUpdateFeedback state={current.applicationUpdate} busy={update.busy} error={update.error} /></>
  }
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { rerender } = render(<Harness current={health} />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Update application' }))
  fireEvent.click(screen.getByRole('button', { name: 'Update application' }))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const ready = { ...health, applicationUpdate: { status: 'ready', supported: true, targetVersion: '2.0.0' } } as HealthResponse
  client.setQueryData(queryKeys.health, ready)
  rerender(<Harness current={ready} />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'Restart application' }) as HTMLButtonElement).disabled).toBe(false))
  expect(requestSignal?.aborted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Restart application' }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restart Now' }))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await act(async () => {
    deliver(new Response(JSON.stringify({ state: { status: 'error', supported: true, message: 'Stale failure' } }), { headers: { 'content-type': 'application/json' } }))
  })
  expect(client.getQueryData<HealthResponse>(queryKeys.health)?.applicationUpdate?.status).toBe('ready')
})

it('releases a lost Apply after a finite client wait without replaying it', async () => {
  let requestSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', fetchMock.mockImplementation((_url, init) => {
    requestSignal = init?.signal as AbortSignal | undefined
    return new Promise<Response>(() => {})
  }))
  vi.useFakeTimers()
  try {
    const client = createQueryClient()
    client.setQueryData(queryKeys.health, health)
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useApplicationUpdate(health), { wrapper })
    act(() => { void result.current.apply(); void result.current.apply() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestSignal?.aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(240_000) })
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toMatch(/status.*unknown|response.*lost/i)
    expect(requestSignal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})

it('bounds an unacknowledged Restart without inventing a successful handoff', async () => {
  let requestSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', fetchMock.mockImplementation((_url, init) => {
    requestSignal = init?.signal as AbortSignal | undefined
    return new Promise<Response>(() => {})
  }))
  vi.useFakeTimers()
  try {
    const ready = { ...health, applicationUpdate: { status: 'ready', supported: true, targetVersion: '2.0.0' } } as HealthResponse
    const client = createQueryClient()
    client.setQueryData(queryKeys.health, ready)
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useApplicationUpdate(ready), { wrapper })
    act(() => { void result.current.restart() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toMatch(/status.*unknown/i)
    expect(requestSignal?.aborted).toBe(true)
    expect(sessionStorage.getItem('cez:application-restart-from')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})

it('releases Apply on an authoritative error despite a pending response', async () => {
  vi.stubGlobal('fetch', fetchMock.mockImplementation(() => new Promise<Response>(() => {})))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, health)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, rerender } = renderHook(({ current }) => useApplicationUpdate(current), { wrapper, initialProps: { current: health } })
  act(() => { void result.current.apply() })
  expect(result.current.busy).toBe(true)
  rerender({ current: { ...health, applicationUpdate: { status: 'error', supported: true, message: 'Preparation failed.' } } as HealthResponse })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(result.current.error).toBeNull()
})

it('accepts authoritative Restart acknowledgement after its HTTP response is lost', async () => {
  vi.stubGlobal('fetch', fetchMock.mockImplementation(() => new Promise<Response>(() => {})))
  const ready = { ...health, applicationUpdate: { status: 'ready', supported: true, targetVersion: '2.0.0' } } as HealthResponse
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, ready)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, rerender } = renderHook(({ current }) => useApplicationUpdate(current), { wrapper, initialProps: { current: ready } })
  act(() => { void result.current.restart(); void result.current.restart() })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  rerender({ current: { ...ready, applicationUpdate: { status: 'restarting', supported: true, targetVersion: '2.0.0' } } as HealthResponse })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(sessionStorage.getItem('cez:application-restart-from')).toBe('1.0.0')
})

it('does not claim a restart while a completed Apply is reconciling Ready', () => {
  render(<ApplicationUpdateFeedback state={{ status: 'ready', supported: true, targetVersion: '2.0.0' }} busy />)
  expect(screen.getByRole('status').textContent).toMatch(/checking update status/i)
  expect(screen.getByRole('status').textContent).not.toMatch(/restarting/i)
})
