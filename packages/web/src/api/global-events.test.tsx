import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { Profiler, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUsageStore, type UsageStore } from './events'
import { GlobalEventsProvider, useGlobalEvents, useRunUsage, useUsage } from './global-events'
import { setApiScope, toRunSummary } from '@open-mercato/cezar-api-client'
import { createQueryClient } from './query-client'
import { queryKeys, useHealth, useRunnerModels, useRun, useRuns, useProjectRuns, useProviderStatus, workspaceQueryKeys } from './queries'
import { TaskQuickList } from '../components/task-quick-list'
import { HandoffAction } from '../routes/task-thread/handoff-action'
import { RunNotifications } from '../components/run-notifications'
import { TasksOverview } from '../routes/tasks-overview'
import type { ApiRun, ProviderStatusResponse, RunRecord } from '@open-mercato/cezar-api-client'

/**
 * jsdom ships no EventSource at all (it is not in its supported-API set), so there is nothing to
 * spy on — the stub *is* the test double. Same lesson as `matchMedia` in the theme tests: stub the
 * missing global with something controllable rather than skip the behavior that depends on it.
 *
 * It implements only what the hook touches, and adds the levers the hook cannot: emit a message,
 * complete the connection, drop it the two ways a real one drops.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1)
    if (!instance) throw new Error('no EventSource was constructed')
    return instance
  }

  /** CONNECTING, as a real one starts. */
  readyState = 0
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string, readonly init?: EventSourceInit) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (event: Event) => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(fn)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, fn: (event: Event) => void): void {
    this.listeners.get(name)?.delete(fn)
  }

  close(): void {
    this.readyState = 2
    this.closeCount += 1
  }

  private dispatch(name: string, event: Event): void {
    // act() because a handler writes to the query cache, which re-renders subscribers.
    act(() => {
      for (const fn of this.listeners.get(name) ?? []) fn(event)
    })
  }

  // ---- levers -----------------------------------------------------------------------------

  /** The server accepted the stream. */
  open(): void {
    this.readyState = 1
    this.dispatch('open', new Event('open'))
  }

  /** One `event:`/`data:` frame. */
  emit(name: string, data: string): void {
    this.dispatch(name, new MessageEvent(name, { data }))
  }

  /** A dropped connection the browser will retry on its own. */
  drop(): void {
    this.readyState = 0
    this.dispatch('error', new Event('error'))
  }

  /** A connection the browser gave up on — what a non-2xx from a restarting server produces. */
  fail(): void {
    this.readyState = 2
    this.dispatch('error', new Event('error'))
  }
}

function runRecord(id: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: id,
    workflow: 'quick-task',
    task: 'do it',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const SAMPLE = { cpuPct: 12, rssBytes: 1024, procCount: 3 }

/** The boot project's id, as `GET /api/v1/health` reports it (`bootProject`). Unscoped, the
 *  workspace stream's filter compares every stamp against it. */
const BOOT = 'boot'

const CONNECTED_PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: false },
    { provider: 'opencode', status: 'connected', enabled: true },
  ],
}

/** A `run` frame as the workspace stream sends it (step 2.8): the record with a `project`
 *  stamp riding along, which the parser strips back off before the reducers see it. */
function stampedRun(record: RunRecord, project = BOOT): string {
  return JSON.stringify({ ...record, project })
}

let client: QueryClient
let usage: UsageStore

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Mount the stream and hand back the levers. */
function mount() {
  const view = renderHook(() => useGlobalEvents(usage), { wrapper })
  return { ...view, source: FakeEventSource.last }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  // No fetch: every query here is seeded via setQueryData, and an invalidate of a query nothing
  // observes never fetches. A stub that threw would be noise; one that answered would let a
  // refetch, rather than the reducer under test, be what put data in the cache.
  vi.stubGlobal('fetch', vi.fn())
  client = createQueryClient()
  usage = createUsageStore()
  // What the app's first health fetch establishes: which project this unscoped cockpit IS.
  // Without it every stamped frame is dropped (see the scoping describe below).
  client.setQueryData(queryKeys.health, { bootProject: BOOT })
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  setApiScope(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useGlobalEvents — connection', () => {
  it('opens exactly one stream, at /api/v1/workspace/events', () => {
    mount()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.last.url).toBe('/api/v1/workspace/events')
    expect(FakeEventSource.last.init).toEqual({ withCredentials: true })
  })

  it('closes the stream on unmount', () => {
    const { unmount, source } = mount()
    expect(source.closeCount).toBe(0)

    unmount()

    // A dropped reference is a leaked socket *and* a leaked retry loop: EventSource reconnects on
    // its own forever, so nothing but close() ends it.
    expect(source.closeCount).toBe(1)
    expect(source.readyState).toBe(2)
  })

  it('does not construct an EventSource where there is none', () => {
    // Prerender, or any jsdom test that renders <App/> without this stub. The guard is the reason
    // those don't explode.
    vi.stubGlobal('EventSource', undefined)
    expect(() => renderHook(() => useGlobalEvents(usage), { wrapper })).not.toThrow()
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})

describe('useGlobalEvents — archived run bursts (#657)', () => {
  it('keeps recovery stale when the last list observer unmounts during recovery', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const a = runRecord('a')
    const b = runRecord('b')
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, b])
    const list = renderHook(() => useRuns(), { wrapper })
    const first = deferredResponse()
    const second = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(first.promise).mockReturnValue(second.promise)
    const { source } = mount()
    source.emit('run', stampedRun({ ...a, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...a }, { ...b }])
    act(() => vi.advanceTimersByTime(50))
    expect(fetch).toHaveBeenCalledTimes(1)
    source.emit('run', stampedRun({ ...b, tokensUsed: 42 }))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)

    list.unmount()
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    renderHook(() => useRuns(), { wrapper })
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(json([{ ...a, archived: true }, { ...b, tokensUsed: 42 }])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true)
  })

  it('keeps a dirty inactive list stale after query reset', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1')
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...run }])
    act(() => vi.advanceTimersByTime(50))
    await act(async () => { await client.resetQueries({ queryKey: queryKeys.runs.list(), exact: true }) })
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)

    const fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValue(fresh.promise)
    renderHook(() => useRuns(), { wrapper })
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => fresh.resolve(json([{ ...run, archived: true }])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true)
  })

  it('does not settle dirty recovery with a list GET started before the archive', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const a = runRecord('a')
    const b = runRecord('b')
    const old = deferredResponse()
    const fresh = deferredResponse()
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, b])
    vi.mocked(fetch).mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise)
    renderHook(() => useRuns(), { wrapper })
    const { source } = mount()
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    expect(fetch).toHaveBeenCalledTimes(1)
    source.emit('run', stampedRun({ ...a, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, { ...b, seenAt: '2026-09-28T01:00:00.000Z' }])
    source.emit('run', stampedRun({ ...b, seenAt: '2026-09-28T01:00:00.000Z', tokensUsed: 42 }))

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => old.resolve(json([a, b])))
    await act(async () => fresh.resolve(json([{ ...a, archived: true }, b])))
    act(() => vi.advanceTimersByTime(50))
    await act(async () => {})
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
  })

  it('retains dirty recovery across query recreation until REST succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1')
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...run }])
    act(() => vi.advanceTimersByTime(50))
    client.removeQueries({ queryKey: queryKeys.runs.list(), exact: true })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)

    const fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValue(fresh.promise)
    renderHook(() => useRuns(), { wrapper })
    await act(async () => fresh.resolve(json([{ ...run, archived: true }])))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
    source.emit('run', stampedRun({ ...run, archived: true, status: 'done' }))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps dirty recovery after a failed fetch until a later fetch succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
    const a = runRecord('a')
    const b = runRecord('b')
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, b])
    renderHook(() => useRuns(), { wrapper })
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    const { source } = mount()
    source.emit('run', stampedRun({ ...a, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...a }, { ...b }])
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)

    const fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValue(fresh.promise)
    source.emit('run', stampedRun({ ...b, tokensUsed: 42 }))
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => fresh.resolve(json([{ ...a, archived: true }, b])))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
  })

  it('restarts recovery once for a new ambiguous archive while an older recovery runs', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const a = runRecord('a')
    const b = runRecord('b')
    const c = runRecord('c')
    const first = deferredResponse()
    const second = deferredResponse()
    const trailing = deferredResponse()
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, b, c])
    renderHook(() => useRuns(), { wrapper })
    vi.mocked(fetch).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValue(trailing.promise)
    const { source } = mount()
    source.emit('run', stampedRun({ ...a, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...a }, b, c])
    act(() => vi.advanceTimersByTime(50))
    expect(fetch).toHaveBeenCalledTimes(1)

    source.emit('run', stampedRun({ ...c, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, { ...b, seenAt: '2026-09-28T01:00:00.000Z' }, c])
    source.emit('run', stampedRun({ ...b, tokensUsed: 42 }))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    source.emit('run', stampedRun({ ...b, tokensUsed: 43 }))
    expect(fetch).toHaveBeenCalledTimes(2)

    await act(async () => first.resolve(json([a, b, c])))
    await act(async () => second.resolve(json([{ ...a, archived: true }, b, { ...c, archived: true }])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.filter(run => run.archived)).toHaveLength(2)
    // The token update overlapped the replacement GET, so it also needs a trailing snapshot.
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    await act(async () => trailing.resolve(json([{ ...a, archived: true }, { ...b, tokensUsed: 43 }, { ...c, archived: true }])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[1]?.tokensUsed).toBe(43)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
  })

  it('refetches an inactive list after a later SSE patches an ambiguous archive', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const a = runRecord('a')
    const b = runRecord('b')
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, b])
    const { source } = mount()
    source.emit('run', stampedRun({ ...a, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...a }, { ...b }])
    source.emit('run', stampedRun({ ...a, status: 'done', archived: true }))
    source.emit('run', stampedRun({ ...b, tokensUsed: 42 }))
    act(() => vi.advanceTimersByTime(50))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(false)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)

    const fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValue(fresh.promise)
    renderHook(() => useRuns(), { wrapper })
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => fresh.resolve(json([{ ...a, status: 'done', archived: true }, { ...b, tokensUsed: 42 }])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true)
  })

  it('follows an overlapping recovery GET with one trailing fetch for later SSE writes', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const a = runRecord('a')
    const b = runRecord('b')
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [a, b])
    renderHook(() => useRuns(), { wrapper })
    const fresh = deferredResponse()
    const trailing = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(fresh.promise).mockReturnValue(trailing.promise)
    const { source } = mount()
    source.emit('run', stampedRun({ ...a, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...a }, { ...b }])
    act(() => vi.advanceTimersByTime(50))
    expect(fetch).toHaveBeenCalledTimes(1)

    for (let tokensUsed = 40; tokensUsed <= 42; tokensUsed++) {
      source.emit('run', stampedRun({ ...b, tokensUsed }))
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[1]?.tokensUsed).toBe(42)
    // Recovery captured its snapshot before the live updates. Its success must not
    // settle recovery with b's old value or start one request per intervening event.
    await act(async () => fresh.resolve(json([{ ...a, archived: true }, b])))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    await act(async () => trailing.resolve(json([{ ...a, archived: true }, { ...b, tokensUsed: 42 }])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true)
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[1]?.tokensUsed).toBe(42)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)

    source.emit('run', stampedRun({ ...b, tokensUsed: 43 }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops watching dirty list writes after the stream unmounts', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1')
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source, unmount } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...run, tokensUsed: 1 }])
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    unmount() // flushes the ambiguous archive, then removes the cache subscription
    invalidate.mockClear()

    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...run, tokensUsed: 2 }])

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('keeps a structurally equal unarchive returned by REST after the event', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    const response = deferredResponse()
    vi.mocked(fetch).mockReturnValue(response.promise)
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const original = client.getQueryData(queryKeys.runs.list())
    const count = client.getQueryState(queryKeys.runs.list())?.dataUpdateCount
    renderHook(() => useRuns(), { wrapper })
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true, archivedAt: '2026-09-28T00:00:00.000Z' }))

    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    await act(async () => response.resolve(json([{ ...run }])))
    expect(client.getQueryState(queryKeys.runs.list())?.dataUpdateCount).toBe((count ?? 0) + 1)
    expect(client.getQueryData(queryKeys.runs.list())).toBe(original)
    act(() => vi.advanceTimersByTime(50))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(false)
  })

  it('does not apply a queued archive to a recreated list query', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    const list = [run]
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), list)
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))
    client.removeQueries({ queryKey: queryKeys.runs.list(), exact: true })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), list)

    act(() => vi.advanceTimersByTime(50))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(false)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
  })

  it('keeps a later live update after replacement and reconciles the list once', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'running' })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ ...run, archived: true, title: 'REST title' }])
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    source.emit('run', stampedRun({ ...run, archived: true, status: 'done', title: 'Worker finished' }))
    act(() => vi.advanceTimersByTime(100))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]).toMatchObject({
      status: 'done', title: 'Worker finished',
    })
    expect(invalidate.mock.calls.filter(([filter]) => filter?.exact === true &&
      JSON.stringify(filter.queryKey) === JSON.stringify(queryKeys.runs.list()))).toHaveLength(1)
  })

  it('does not resurrect a row absent from a newer REST list', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    client.setQueryData(queryKeys.runs.list(), [run])
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))
    client.setQueryData(queryKeys.runs.list(), [])

    act(() => vi.advanceTimersByTime(50))

    expect(client.getQueryData(queryKeys.runs.list())).toEqual([])
  })

  it('does not reverse an unarchive returned by newer REST', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    client.setQueryData(queryKeys.runs.list(), [run])
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))
    client.setQueryData(queryKeys.runs.list(), [{ ...run, title: 'Renamed after unarchive', archived: false }])

    act(() => vi.advanceTimersByTime(50))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]).toMatchObject({
      title: 'Renamed after unarchive', archived: false,
    })
  })

  it('reconciles a pre-event REST response that lands after the archive frame', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    const stale = deferredResponse()
    const fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    renderHook(() => useRuns(), { wrapper })
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) }) // starts before the event
    expect(fetch).toHaveBeenCalledTimes(1)
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true }))

    await act(async () => stale.resolve(json([{ ...run, tokensUsed: 42 }])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.tokensUsed).toBe(42)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await act(async () => fresh.resolve(json([{ ...run, archived: true, tokensUsed: 42 }])))

    await waitFor(() => expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]).toMatchObject({
      archived: true, tokensUsed: 42,
    }))
  })

  it('renders the actual overview once for a parent-and-worker archive burst', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const runs: RunRecord[] = []
    for (let p = 0; p < 12; p++) {
      const parent = runRecord(`parent-${p}`, { status: 'done' })
      runs.push(parent)
      for (let w = 0; w < 4; w++) {
        const id = `worker-${p}-${w}`
        runs.push(runRecord(id, {
          status: 'running',
          delegation: {
            role: 'worker', parentRunId: parent.id, permissions: [],
            workspace: {
              ownerRunId: id, resourceId: id, kind: 'owned-isolated', path: `/managed/${id}`,
              branch: `cez/${id}`, baselineSha: 'a'.repeat(40),
            },
          },
        }))
      }
    }
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), runs)
    let overviewCommits = 0
    function LiveOverview() {
      useGlobalEvents(usage)
      const list = useRuns()
      return <MemoryRouter><Profiler id="overview" onRender={() => { overviewCommits++ }}>
        <TasksOverview runs={list.data} view="active" onViewChange={() => undefined}
          onArchiveFinished={() => undefined} onMarkAllRead={() => undefined}
          onRename={() => undefined} />
      </Profiler></MemoryRouter>
    }
    render(<QueryClientProvider client={client}><LiveOverview /></QueryClientProvider>)
    const baseline = overviewCommits

    for (const run of runs) FakeEventSource.last.emit('run', stampedRun({ ...run, archived: true }))
    await act(async () => {})
    expect(overviewCommits).toBe(baseline)
    await waitFor(() => expect(overviewCommits - baseline).toBeGreaterThanOrEqual(1))
    expect(overviewCommits - baseline).toBeLessThanOrEqual(2)
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.filter(run => run.archived)).toHaveLength(60)
  })

  it('commits one list update and one subscriber render for 60 archived run frames', async () => {
    // A background tab may pause animation frames. The bounded timer must still flush the burst.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const original = Array.from({ length: 60 }, (_, i) => runRecord(`run-${i}`, { status: 'done' }))
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), original)
    let listWrites = 0
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && JSON.stringify(event.query.queryKey) === JSON.stringify(queryKeys.runs.list())) listWrites++
    })
    let renders = 0
    renderHook(() => {
      useGlobalEvents(usage)
      const runs = useRuns()
      renders++
      return runs.data
    }, { wrapper })
    const baseline = renders

    for (const run of original) {
      FakeEventSource.last.emit('run', stampedRun({ ...run, archived: true, archivedAt: '2026-09-28T00:00:00.000Z' }))
    }
    await act(async () => {})
    expect(listWrites).toBe(0)
    expect(renders).toBe(baseline)

    await waitFor(() => expect(listWrites).toBe(1))
    await waitFor(() => expect(renders - baseline).toBe(1))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.every(run => run.archived)).toBe(true)
    unsubscribe()
  })

  it('keeps detail permission updates immediate while the archived list waits', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    client.setQueryData(queryKeys.runs.detail('r1'), { ...run, finishBlocked: null })
    const { source, unmount } = mount()

    source.emit('run', stampedRun({ ...run, archived: true }))

    expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.archived).toBe(true)
    expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.finishBlocked).toBeUndefined()
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(false)
    unmount()
  })

  it('flushes an archived update before a later deletion so the row cannot return', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source } = mount()

    source.emit('run', stampedRun({ ...run, archived: true }))
    source.emit('run-deleted', JSON.stringify({ id: run.id, project: BOOT }))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
  })

  it('writes queued events to their receipt-time project keys across a scope switch', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    client.setQueryData<ApiRun[]>(['default', 'runs', 'list'], [])
    client.setQueryData<ApiRun[]>(['other-project', 'runs', 'list'], [])
    const { source, unmount } = mount()

    source.emit('run', stampedRun(runRecord('boot-run', { archived: true }), BOOT))
    setApiScope('other-project')
    source.emit('run', stampedRun(runRecord('other-run', { archived: true }), 'other-project'))
    unmount() // cleanup must commit pending updates, not leave stale cache behind

    expect(client.getQueryData<ApiRun[]>(['default', 'runs', 'list'])?.map(run => run.id)).toEqual(['boot-run'])
    expect(client.getQueryData<ApiRun[]>(['other-project', 'runs', 'list'])?.map(run => run.id)).toEqual(['other-run'])
  })

  it('flushes pending archived list events before reconnect reconciliation', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source } = mount()
    source.open()

    source.emit('run', stampedRun({ ...run, archived: true }))
    source.drop()
    source.open()

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true)
  })

  it('flushes a hidden tab on return before its authoritative reconciliation', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source } = mount()

    setVisibility('hidden')
    source.emit('run', stampedRun({ ...run, archived: true }))
    setVisibility('visible')

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true)
  })

  it('does not overwrite a newer authoritative archived row when the burst flushes', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = runRecord('r1', { status: 'done' })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [run])
    const { source } = mount()
    source.emit('run', stampedRun({ ...run, archived: true, archivedAt: '2026-09-28T00:00:00.000Z' }))

    // The mutation's authoritative refetch may finish before the animation frame.
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{
      ...run, title: 'Server-renamed title', archived: true, archivedAt: '2026-09-28T00:00:00.000Z',
    }])
    await waitFor(() => expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.archived).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.title).toBe('Server-renamed title')
  })

  it('applies later updates to an already archived live worker with the same archivedAt', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const worker = runRecord('worker', {
      status: 'running', archived: true, archivedAt: '2026-09-28T00:00:00.000Z',
    })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [worker])
    const { source } = mount()

    source.emit('run', stampedRun({ ...worker, status: 'done', title: 'Worker finished' }))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.status).toBe('done')
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.title).toBe('Worker finished')
  })
})

describe('useGlobalEvents — back/forward cache', () => {
  // jsdom has no PageTransitionEvent; a plain Event with `persisted` defined is what the
  // handler reads either way.
  function firePageShow(persisted: boolean): void {
    const event = new Event('pageshow')
    Object.defineProperty(event, 'persisted', { value: persisted })
    act(() => {
      window.dispatchEvent(event)
    })
  }

  it('closes the stream when the document is navigated away (pagehide)', () => {
    const { source } = mount()

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    // The leak this prevents: a bfcached document's open EventSource keeps a real socket, and
    // six parked documents exhaust the per-origin pool — the NEXT page load hangs.
    expect(source.closeCount).toBe(1)
  })

  it('reopens the stream when the document is restored from bfcache', () => {
    mount()

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    firePageShow(true)

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.last.url).toBe('/api/v1/workspace/events')
  })

  it('does nothing on the pageshow of a normal load', () => {
    mount()

    firePageShow(false)

    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('useGlobalEvents — run events', () => {
  it('upserts a run into the list cache without refetching', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'queued' })))

    // A list row is the summary of the streamed record (#817), never the record itself.
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([
      toRunSummary(runRecord('r1', { status: 'queued' })),
    ])
    // The whole point: a live run emits constantly, and none of it may become HTTP traffic.
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['own', 'worker'])('coalesces %s detail updates and keeps stale permission hidden during a burst', async kind => {
    vi.useFakeTimers()
    try {
      const run = { ...runRecord('r1', { status: 'waiting' }), finishBlocked: null }
      client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), run)
      vi.mocked(fetch).mockImplementation(async () => json(run))
      renderHook(() => useRun('r1'), { wrapper })
      const { source } = mount()
      for (let i = 0; i < 20; i++) {
        source.emit('run', stampedRun(kind === 'own' ? runRecord('r1', { status: 'waiting' }) : runRecord('worker', {
          delegation: { role: 'worker', parentRunId: 'r1', permissions: [],
            workspace: { ownerRunId: 'worker', resourceId: 'worker', kind: 'owned-isolated', path: '/worker', branch: 'worker', baselineSha: 'a'.repeat(40) } },
        })))
        await act(async () => { await vi.advanceTimersByTimeAsync(20) })
        expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.finishBlocked).toBeUndefined()
      }
      expect(fetch).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.finishBlocked).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['own', 'worker'] as const)('preserves cached detail during an in-flight %s event and debounces the replacement', async kind => {
    const id = kind === 'own' ? 'r1' : 'parent'
    const key = queryKeys.runs.detail(id)
    const before = { ...runRecord(id, { status: 'running' }), finishBlocked: null, usage: SAMPLE }
    const stale = deferredResponse()
    const fresh = deferredResponse()
    client.setQueryData<ApiRun>(key, before)
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const { result } = renderHook(() => useRun(id), { wrapper })
    const { source } = mount()
    void client.refetchQueries({ queryKey: key })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(client.getQueryState(key)?.fetchStatus).toBe('fetching')

    source.emit('run', stampedRun(kind === 'own'
      ? runRecord(id, { status: 'waiting', tokensUsed: 42 })
      : runRecord('worker', {
        delegation: { role: 'worker', parentRunId: id, permissions: [],
          workspace: { ownerRunId: 'worker', resourceId: 'worker', kind: 'owned-isolated', path: '/worker', branch: 'worker', baselineSha: 'a'.repeat(40) } },
      })))

    // A cancelled fetch must not become an error (the run-detail error flash), and cancelling
    // must not roll back the event's patch or the last successful GET's usage sample.
    await act(async () => {})
    expect(result.current.isError).toBe(false)
    expect(client.getQueryState(key)?.status).toBe('success')
    expect(client.getQueryState(key)?.fetchStatus).toBe('idle')
    expect(client.getQueryData<ApiRun>(key)).toMatchObject({ id, usage: SAMPLE,
      status: kind === 'own' ? 'waiting' : 'running',
      tokensUsed: kind === 'own' ? 42 : 0 })
    expect(client.getQueryData<ApiRun>(key)?.finishBlocked).toBeUndefined()
    await act(async () => stale.resolve(json({ ...before, finishBlocked: null })))
    expect(client.getQueryData<ApiRun>(key)?.finishBlocked).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await act(async () => fresh.resolve(json({ ...before, status: 'waiting', finishBlocked: 'Wait for the worker.' })))
    await waitFor(() => expect(client.getQueryData<ApiRun>(key)?.finishBlocked).toBe('Wait for the worker.'))
    expect(result.current.isError).toBe(false)
  })

  it('cancels pending detail refreshes when the event provider unmounts', async () => {
    vi.useFakeTimers()
    try {
      client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), { ...runRecord('r1'), finishBlocked: null })
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      const { source, unmount } = mount()
      source.emit('run', stampedRun(runRecord('r1')))
      unmount()
      invalidate.mockClear()
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(invalidate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['own', 'worker'])('an %s event during initial loading replaces the stale in-flight verdict', async kind => {
    const stale = deferredResponse()
    const fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise)
    renderHook(() => useRun('r1'), { wrapper })
    const { source } = mount()
    source.emit('run', stampedRun(kind === 'own' ? runRecord('r1', { status: 'waiting' }) : runRecord('worker', {
      delegation: { role: 'worker', parentRunId: 'r1', permissions: [],
        workspace: { ownerRunId: 'worker', resourceId: 'worker', kind: 'owned-isolated', path: '/worker', branch: 'worker', baselineSha: 'a'.repeat(40) } },
    })))
    // Initial loading has no last good result to restore: stay pending (not error), and do
    // not let the pre-event response install an obsolete Finish permission.
    await act(async () => {})
    expect(client.getQueryState(queryKeys.runs.detail('r1'))?.status).toBe('pending')
    expect(client.getQueryState(queryKeys.runs.detail('r1'))?.fetchStatus).toBe('idle')
    expect(client.getQueryData(queryKeys.runs.detail('r1'))).toBeUndefined()
    stale.resolve(json({ ...runRecord('r1', { status: 'waiting' }), finishBlocked: null }))
    await act(async () => {})
    expect(client.getQueryData(queryKeys.runs.detail('r1'))).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    fresh.resolve(json({ ...runRecord('r1', { status: 'waiting' }), finishBlocked: 'Answer the pending human question.' }))
    await waitFor(() => expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.finishBlocked).toBe('Answer the pending human question.'))
  })

  it('clears stale Finish permission and refreshes the mounted parent on a worker update', async () => {
    const parent = { ...runRecord('parent', { status: 'waiting' }), finishBlocked: null }
    client.setQueryData<ApiRun>(queryKeys.runs.detail('parent'), parent)
    const response = deferredResponse()
    vi.mocked(fetch).mockReturnValue(response.promise)
    renderHook(() => useRun('parent'), { wrapper })
    const { source } = mount()
    source.emit('run', stampedRun(runRecord('worker', {
      delegation: { role: 'worker', parentRunId: 'parent', permissions: [],
        workspace: { ownerRunId: 'worker', resourceId: 'worker', kind: 'owned-isolated', path: '/worker', branch: 'worker', baselineSha: 'a'.repeat(40) } },
    })))
    expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('parent'))?.finishBlocked).toBeUndefined()
    response.resolve(json({ ...parent, finishBlocked: 'Collect the latest worker result.' }))
    await waitFor(() => expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('parent'))?.finishBlocked).toBe('Collect the latest worker result.'))
  })

  it('refreshes the mounted run after its own event without refetching the list', async () => {
    client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), { ...runRecord('r1'), finishBlocked: 'no open session' })
    const response = deferredResponse()
    vi.mocked(fetch).mockReturnValue(response.promise)
    renderHook(() => useRun('r1'), { wrapper })
    const { source } = mount()
    source.emit('run', stampedRun(runRecord('r1', { status: 'waiting' })))
    response.resolve(json({ ...runRecord('r1', { status: 'waiting' }), finishBlocked: null }))
    await waitFor(() => expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.finishBlocked).toBeNull())
    expect(vi.mocked(fetch).mock.calls.every(([input]) => String(input).replace('?archived=recent', '').endsWith('/runs/r1'))).toBe(true)
  })

  it('updates in place on a second event for the same run — no duplicate row', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'queued' })))
    source.emit('run', stampedRun(runRecord('r1', { status: 'running', tokensUsed: 42 })))
    source.emit('run', stampedRun(runRecord('r1', { status: 'done', tokensUsed: 99 })))

    const list = client.getQueryData<ApiRun[]>(queryKeys.runs.list())
    expect(list).toHaveLength(1)
    expect(list?.[0]?.status).toBe('done')
    expect(list?.[0]?.tokensUsed).toBe(99)
  })

  it('patches a run detail cache that exists, and creates none that does not', () => {
    client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), { ...runRecord('r1'), usage: SAMPLE })
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'done' })))
    source.emit('run', stampedRun(runRecord('r2', { status: 'done' })))

    const detail = client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))
    expect(detail?.status).toBe('done')
    // The live sample the GET attached survives an event that never carried one.
    expect(detail?.usage).toEqual(SAMPLE)
    // r2 was never opened: a summary must not masquerade as a fetched detail.
    expect(client.getQueryData(queryKeys.runs.detail('r2'))).toBeUndefined()
  })

  it('refreshes an opened Cursor detail for its server-resolved resume command', async () => {
    client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), runRecord('r1', { runner: 'claude' }))
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()
    source.emit('run', stampedRun(runRecord('r1', { runner: 'claude', status: 'done', steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'cursor', sessionId: 's1' }] })))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail('r1') }))
  })

  it('invalidates the changes cache on a run event so an ended run’s final writes appear (#488)', () => {
    // The Changes tab stops polling the moment a run leaves the active set, so without this the
    // last diff would wait for the next SSE reconnect. A cache the user opened must refresh.
    client.setQueryData(queryKeys.runs.changes('r1'), { files: [], stat: { adds: 0, dels: 0, files: 0 } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'done' })))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.changes('r1') })
  })

  it('does not invalidate a changes cache nobody opened — no background diff fetch', () => {
    // Mirror of the detail-cache guard: a run event for a task whose Changes tab was never viewed
    // must not spawn a fetch for a diff no one is looking at.
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r2', { status: 'done' })))

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.runs.changes('r2') })
  })

  it('refreshes the cross-project index from ANOTHER project\u2019s run event', async () => {
    // The bug this covers: every non-active project's event was dropped before it touched
    // anything, so the global Tasks page — which spans the whole registry — heard nothing and ran
    // on its poll alone. A renamed or finished task in a project you were not standing in stayed
    // stale on screen until the next tick, and the tick does not run in a hidden tab.
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r9', { status: 'done' }), 'some-other-project'))

    // Debounced: one run emits many events, and a busy workspace emits from everywhere at once.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.runsIndex })
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.runsIndex }),
    )
  })

  it('still refuses to write another project\u2019s run into THIS scope\u2019s list', async () => {
    // The index is cross-project; the scoped caches are not. Widening one must not widen the other.
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r9', { status: 'done' }), 'some-other-project'))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
  })

  it('coalesces a burst of run events into ONE index refresh', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    for (const status of ['queued', 'running', 'done'] as const) {
      source.emit('run', stampedRun(runRecord('r1', { status })))
    }

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.runsIndex }),
    )
    const indexRefreshes = invalidate.mock.calls.filter(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey?.[1] === 'runs-index',
    )
    expect(indexRefreshes).toHaveLength(1)
  })

  it('ignores a malformed frame and keeps serving the next one', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', 'not json{')
    source.emit('run', '{"no":"id"}')
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])

    source.emit('run', stampedRun(runRecord('r1')))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toHaveLength(1)
  })

  it('drops a deleted run from the list and throws away its detail and diff caches', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [runRecord('r1'), runRecord('r2')])
    client.setQueryData(queryKeys.runs.detail('r1'), runRecord('r1'))
    client.setQueryData(queryKeys.runs.diff('r1'), { files: [] })
    const { source } = mount()

    source.emit('run-deleted', JSON.stringify({ id: 'r1', project: BOOT }))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.map((r) => r.id)).toEqual(['r2'])
    // Removed, not emptied: anything still mounted on them must go ask the server and get its 404.
    expect(client.getQueryData(queryKeys.runs.detail('r1'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.runs.diff('r1'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.runs.detail('r2'))).toBeUndefined()
  })

  it('drops a deleted run from loaded archived pages too, whatever their search (#864)', () => {
    const page = (ids: string[]) => ({ runs: ids.map((id) => runRecord(id)), nextCursor: null, total: ids.length })
    client.setQueryData(queryKeys.runs.archived(''), { pages: [page(['r1', 'r2'])], pageParams: [undefined] })
    client.setQueryData(queryKeys.runs.archived('#864'), { pages: [page(['r1'])], pageParams: [undefined] })
    const { source } = mount()

    source.emit('run-deleted', JSON.stringify({ id: 'r1', project: BOOT }))

    type Pages = { pages: { runs: { id: string }[] }[] }
    expect(client.getQueryData<Pages>(queryKeys.runs.archived(''))?.pages[0]?.runs.map((r) => r.id)).toEqual(['r2'])
    expect(client.getQueryData<Pages>(queryKeys.runs.archived('#864'))?.pages[0]?.runs).toEqual([])
  })
})

describe('useGlobalEvents — todos', () => {
  it('replaces the inbox cache, seeding it even when nothing fetched it', () => {
    const { source } = mount()

    source.emit('todos', JSON.stringify({ project: BOOT, items: [{ id: 't1', summary: 'Review the PR' }] }))
    expect(client.getQueryData(queryKeys.todos)).toEqual([{ id: 't1', summary: 'Review the PR' }])

    // The payload is the whole inbox, so an emptied inbox really empties the badge.
    source.emit('todos', JSON.stringify({ project: BOOT, items: [] }))
    expect(client.getQueryData(queryKeys.todos)).toEqual([])
  })
})

describe('useGlobalEvents — usage', () => {
  it('feeds the usage store and never touches the runs cache', () => {
    const list: ApiRun[] = [runRecord('r1')]
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), list)
    client.setQueryData(queryKeys.runs.detail('r1'), runRecord('r1'))
    const { source } = mount()

    source.emit('usage', JSON.stringify({ project: BOOT, usage: { r1: SAMPLE } }))

    expect(usage.get()).toEqual({ r1: SAMPLE })
    // Identity, not equality: a ~2 s tick that replaced the cached list would re-render every
    // task row in the app forever, and would write telemetry into records that are never persisted.
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toBe(list)
    expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.usage).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores ping — it is a keep-alive, not news', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('ping', '')

    expect(invalidate).not.toHaveBeenCalled()
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
    expect(usage.get()).toEqual({})
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('useGlobalEvents — provider status', () => {
  it('delivers completed remote health over SSE without letting a cold HTTP response overwrite it', async () => {
    const health = {
      version: 'test', repoRoot: 'repo', repo: null, defaultRunner: 'claude', forge: null,
      projects: [], bootProject: BOOT,
      capabilities: { localHandoff: false, followups: false, singleProject: false, automations: false, preview: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true },
      checks: [{ name: 'cursor', available: true }],
    }
    client.removeQueries({ queryKey: queryKeys.health })
    const initial = deferredResponse()
    vi.mocked(fetch).mockReturnValue(initial.promise)
    const { source } = mount()
    const { result } = renderHook(() => useHealth(), { wrapper })
    source.emit('health', 'invalid json')
    source.emit('health', JSON.stringify({ checks: [] }))
    expect(result.current.data).toBeUndefined()
    source.emit('health', JSON.stringify(health))
    await waitFor(() => expect(result.current.data?.checks).toEqual(health.checks))
    await act(async () => initial.resolve(json({ ...health, checks: [] })))
    expect(result.current.data?.checks).toEqual(health.checks)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('replaces a pending cold Cursor HTTP response after SSE reconnect', async () => {
    const { source } = mount()
    await act(async () => source.open())
    const initial = deferredResponse()
    const fresh = { runner: 'cursor', models: [{ id: 'auto', label: 'Auto', description: '' }], source: 'cache', stale: false }
    vi.mocked(fetch).mockReturnValueOnce(initial.promise).mockResolvedValue(json(fresh))
    const { result } = renderHook(() => useRunnerModels('cursor'), { wrapper })
    expect(result.current.data).toBeUndefined()
    source.drop()
    source.open()
    await waitFor(() => expect(result.current.data?.models[0]?.id).toBe('auto'))
    await act(async () => initial.resolve(json({ runner: 'cursor', models: [], source: 'unavailable', stale: false })))
    expect(result.current.data?.models[0]?.id).toBe('auto')
  })

  it('fills the Cursor catalog from authenticated SSE completion and rejects malformed events', () => {
    const { source } = mount()
    const key = workspaceQueryKeys.models('cursor')
    source.emit('model-catalog', 'not json')
    source.emit('model-catalog', JSON.stringify({ runner: 'cursor', models: 'invalid' }))
    expect(client.getQueryData(key)).toBeUndefined()
    const result = { runner: 'cursor', models: [{ id: 'auto', label: 'Auto', description: '' }], source: 'live', stale: false }
    source.emit('model-catalog', JSON.stringify(result))
    expect(client.getQueryData(key)).toEqual(result)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('patches the provider cache immediately from a workspace provider-status event', () => {
    client.setQueryData(workspaceQueryKeys.providerStatus, CONNECTED_PROVIDERS)
    const { source } = mount()

    source.emit('provider-status', JSON.stringify({
      provider: 'claude',
      status: 'disconnected',
      enabled: true,
      hint: 'Authentication was rejected during a run. Reconnect, then try again.',
    }))

    expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[0]).toEqual({
      provider: 'claude',
      status: 'disconnected',
      enabled: true,
      hint: 'Authentication was rejected during a run. Reconnect, then try again.',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores malformed frames without poisoning the next provider-status event', () => {
    client.setQueryData(workspaceQueryKeys.providerStatus, CONNECTED_PROVIDERS)
    const { source } = mount()

    source.emit('provider-status', 'not json{')
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBe(CONNECTED_PROVIDERS)

    source.emit('provider-status', JSON.stringify({
      provider: 'future',
      status: 'disconnected',
    }))
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBe(CONNECTED_PROVIDERS)

    source.emit('provider-status', JSON.stringify({
      provider: 'codex',
      status: 'disconnected',
      enabled: false,
    }))
    expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[1]).toEqual({
      provider: 'codex',
      status: 'disconnected',
      enabled: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not invent an unfetched provider cache', () => {
    const { source } = mount()

    source.emit('provider-status', JSON.stringify({
      provider: 'claude',
      status: 'disconnected',
    }))

    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores malformed and unknown unfetched provider events without starting a query', () => {
    const { source } = mount()

    source.emit('provider-status', 'not json{')
    source.emit('provider-status', JSON.stringify({ provider: 'future', status: 'disconnected' }))

    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels a stale initial provider request and refetches after an SSE incident', async () => {
    const initial = deferredResponse()
    const replacement = deferredResponse()
    const staleConnected = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    const latched = {
      providers: [
        {
          provider: 'claude',
          status: 'disconnected',
          enabled: true,
          authFailureId: 'incident-1',
          hint: 'Reconnect, then try again.',
        },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    vi.mocked(fetch).mockReturnValueOnce(initial.promise).mockReturnValueOnce(replacement.promise)

    function ProviderProbe() {
      const status = useProviderStatus()
      return <output data-testid="provider-status">{status.data?.providers[0]?.status ?? 'pending'}</output>
    }

    render(
      <QueryClientProvider client={client}>
        <GlobalEventsProvider>
          <ProviderProbe />
        </GlobalEventsProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    FakeEventSource.last.emit('provider-status', JSON.stringify({
      provider: 'claude',
      status: 'disconnected',
      authFailureId: 'incident-1',
      hint: 'Reconnect, then try again.',
    }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    await act(async () => initial.resolve(json(staleConnected)))
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBeUndefined()
    expect(document.querySelector('[data-testid="provider-status"]')?.textContent).not.toBe('connected')

    await act(async () => replacement.resolve(json(latched)))
    await waitFor(() => expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[0]).toMatchObject({ status: 'disconnected', authFailureId: 'incident-1' }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('coalesces a second uncached provider event into one trailing refetch', async () => {
    const initial = deferredResponse()
    const replacement = deferredResponse()
    const final = deferredResponse()
    const staleConnected = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    const onlyClaudeIncident = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'incident-a' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    const bothIncidents = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'incident-a' },
        { provider: 'codex', status: 'disconnected', enabled: true, authFailureId: 'incident-b' },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    vi.mocked(fetch)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(replacement.promise)
      .mockReturnValueOnce(final.promise)

    function ProviderProbe() {
      useProviderStatus()
      return null
    }

    render(
      <QueryClientProvider client={client}>
        <GlobalEventsProvider>
          <ProviderProbe />
        </GlobalEventsProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    FakeEventSource.last.emit('provider-status', JSON.stringify({
      provider: 'claude', status: 'disconnected', authFailureId: 'incident-a',
    }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    FakeEventSource.last.emit('provider-status', JSON.stringify({
      provider: 'codex', status: 'disconnected', authFailureId: 'incident-b',
    }))
    expect(fetch).toHaveBeenCalledTimes(2)

    await act(async () => initial.resolve(json(staleConnected)))
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => replacement.resolve(json(onlyClaudeIncident)))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    await act(async () => final.resolve(json(bothIncidents)))

    await waitFor(() => expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )).toEqual(bothIncidents))
    await act(async () => {})
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('applies provider status while a different project scope is active', () => {
    setApiScope('other-project')
    client.setQueryData(workspaceQueryKeys.providerStatus, CONNECTED_PROVIDERS)
    const { source } = mount()

    source.emit('provider-status', JSON.stringify({
      provider: 'opencode',
      status: 'disconnected',
      enabled: true,
    }))

    expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[2]).toEqual({
      provider: 'opencode',
      status: 'disconnected',
      enabled: true,
    })
  })
})

describe('useGlobalEvents — project scoping (multi-project spec, step 3.1)', () => {
  it('drops another project\'s stamped events when unscoped — no cross-project cache bleed', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('theirs'), 'other-project'))
    source.emit('todos', JSON.stringify({ project: 'other-project', items: [{ id: 't9' }] }))
    source.emit('usage', JSON.stringify({ project: 'other-project', usage: { theirs: SAMPLE } }))

    // The one stream carries every project; only the boot project's news may land here.
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
    expect(client.getQueryData(queryKeys.todos)).toBeUndefined()
    expect(usage.get()).toEqual({})
  })

  it('drops an unstamped frame — without an owner it belongs to no one', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    // The pre-workspace wire shape. Applying it unattributed is exactly the bleed the
    // envelope exists to prevent.
    source.emit('run', JSON.stringify(runRecord('r1')))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
  })

  it('drops stamped events until health has named the boot project, without crashing', () => {
    client.removeQueries({ queryKey: queryKeys.health })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    // Harmless by the doctrine: at boot the authoritative queries are fetching right now.
    source.emit('run', stampedRun(runRecord('r1')))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])

    // Health answered — from here on the boot project's events flow.
    client.setQueryData(queryKeys.health, { bootProject: BOOT })
    source.emit('run', stampedRun(runRecord('r1')))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toHaveLength(1)
  })

  it('applies the scoped project\'s events — and only those — once a scope is mounted', () => {
    setApiScope('other-project')
    // Scoped keys: this cache belongs to other-project (queries.ts leads every key with the scope).
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('boot-run'), BOOT))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])

    source.emit('run', stampedRun(runRecord('theirs'), 'other-project'))
    source.emit('usage', JSON.stringify({ project: 'other-project', usage: { theirs: SAMPLE } }))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.map((r) => r.id)).toEqual(['theirs'])
    expect(usage.get()).toEqual({ theirs: SAMPLE })
  })

  it('patches the stamped project\'s run list, never another project\'s (#129)', () => {
    // Sidebar groups keep their own list caches. A boot-stamped run arriving while another
    // project is the mounted scope must land in the boot group's `default` key — the one
    // `useProjectRuns(..., boot)` reads — and must not insert into the active project's list.
    setApiScope('other-project')
    const otherRun = runRecord('theirs')
    client.setQueryData<ApiRun[]>(['default', 'runs', 'list'], [])
    client.setQueryData<ApiRun[]>(['other-project', 'runs', 'list'], [otherRun])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('boot-run'), BOOT))

    expect(client.getQueryData<ApiRun[]>(['other-project', 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'theirs',
    ])
    expect(client.getQueryData<ApiRun[]>(['default', 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'boot-run',
    ])
  })

  it('patches a non-boot list while unscoped, without touching the boot list (#129)', () => {
    client.setQueryData<ApiRun[]>(['default', 'runs', 'list'], [runRecord('boot-run')])
    client.setQueryData<ApiRun[]>(['other-project', 'runs', 'list'], [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('theirs'), 'other-project'))

    expect(client.getQueryData<ApiRun[]>(['default', 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'boot-run',
    ])
    expect(client.getQueryData<ApiRun[]>(['other-project', 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'theirs',
    ])
  })

  it('aliases boot from the registry when health has not answered yet', () => {
    client.removeQueries({ queryKey: queryKeys.health })
    client.removeQueries({ queryKey: ['default', 'health'] })
    client.setQueryData(workspaceQueryKeys.projects, { bootProject: BOOT, projects: [], projectsDir: '/' })
    setApiScope('other-project')
    client.setQueryData<ApiRun[]>(['default', 'runs', 'list'], [])
    client.setQueryData<ApiRun[]>(['other-project', 'runs', 'list'], [runRecord('theirs')])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('boot-run'), BOOT))

    expect(client.getQueryData<ApiRun[]>(['other-project', 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'theirs',
    ])
    expect(client.getQueryData<ApiRun[]>(['default', 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'boot-run',
    ])
  })

  it('writes a boot-stamped run to both default and the boot id when the boot project is scoped', () => {
    // Registry error path: `/p/<boot>` mounts scoped under the real id, so the main view
    // reads `[bootId, 'runs', 'list']` while sidebar groups (when present) still alias boot
    // to `'default'`. Both entries must receive the event.
    setApiScope(BOOT)
    client.setQueryData<ApiRun[]>(['default', 'runs', 'list'], [])
    client.setQueryData<ApiRun[]>([BOOT, 'runs', 'list'], [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('boot-run'), BOOT))

    expect(client.getQueryData<ApiRun[]>(['default', 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'boot-run',
    ])
    expect(client.getQueryData<ApiRun[]>([BOOT, 'runs', 'list'])?.map((r) => r.id)).toEqual([
      'boot-run',
    ])
  })
})

describe('useGlobalEvents — reconcile doctrine', () => {
  /** The keys a reconcile must reach. */
  function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
    return spy.mock.calls
      .map((call) => (call[0] as { queryKey?: unknown }).queryKey)
      .filter((key) => key !== undefined)
  }

  it('invalidates the Git view branch classes on run and run-deleted events (issue 08)', () => {
    const { source } = mount()
    source.open()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    source.emit('run', stampedRun({ ...runRecord('r1'), status: 'done' }))
    expect(invalidatedKeys(invalidate)).toContainEqual(queryKeys.repoBranches)
    invalidate.mockClear()
    source.emit('run-deleted', JSON.stringify({ id: 'r1', project: BOOT }))
    expect(invalidatedKeys(invalidate)).toContainEqual(queryKeys.repoBranches)
  })

  it('reconciles background discovery on first open', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.open()

    await waitFor(() => expect(invalidatedKeys(invalidate)).toEqual([workspaceQueryKeys.models('cursor'), queryKeys.health]))
  })

  it('refetches the authoritative endpoints on reconnect', async () => {
    const { source } = mount()
    await act(async () => source.open())
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    // The socket dropped; EventSource retried it on its own and got back in. Whatever happened in
    // between never reached this client, so the cache is now a guess.
    source.drop()
    source.open()

    await waitFor(() => expect(invalidatedKeys(invalidate)).toEqual([
      queryKeys.runs.all, // covers the list and every detail under it
      // The cross-project index behind the global Tasks page. Nothing else here covers it: the
      // scoped caches hold one project, and this spans the workspace.
      workspaceQueryKeys.runsIndex,
      queryKeys.todos,
      queryKeys.worktrees, // the Resources panel's list/total (#483)
      queryKeys.repoBranches, // the Git view's branch classes (issue 08)
      workspaceQueryKeys.providerStatus,
      workspaceQueryKeys.models('cursor'),
      queryKeys.health,
    ]))
  })

  it('invalidates cached GitHub lists across projects on reconnect without invalidating threads', () => {
    const { source } = mount()
    source.open()
    const lists = [['default', 'github', null], ['shop', 'github', 1000]]
    const thread = ['shop', 'github', 'comments', 'issue', 152]
    for (const key of [...lists, thread]) client.setQueryData(key, { available: true })
    source.drop()
    source.open()
    for (const key of lists) expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(client.getQueryState(thread)?.isInvalidated).toBe(false)
  })

  it('marks every cached run list stale on reconnect, not only the active scope', () => {
    setApiScope('other-project')
    const { source } = mount()
    source.open()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    source.drop()
    source.open()

    const predicates = invalidate.mock.calls
      .map((call) => (call[0] as { predicate?: (query: { queryKey: unknown[] }) => boolean }).predicate)
      .filter((predicate): predicate is (query: { queryKey: unknown[] }) => boolean => typeof predicate === 'function')
    expect(predicates.some((predicate) => predicate({ queryKey: ['default', 'runs', 'list'] }))).toBe(true)
    expect(predicates.some((predicate) => predicate({ queryKey: ['shop', 'runs', 'list'] }))).toBe(true)
    expect(predicates.every((predicate) => !predicate({ queryKey: ['shop', 'runs', 'detail', 'r1'] }))).toBe(
      true,
    )
  })

  it('refetches when a hidden tab comes back', async () => {
    const { source } = mount()
    await act(async () => source.open())
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    setVisibility('hidden')
    expect(invalidate).not.toHaveBeenCalled()

    // A phone that slept: the tab was frozen, no error handler ever ran, and the stream may have
    // been dead for an hour. What is on screen is about to be read as true.
    setVisibility('visible')
    await waitFor(() => expect(invalidatedKeys(invalidate)).toEqual([
      queryKeys.runs.all,
      // The cross-project index behind the global Tasks page — nothing else here covers it.
      workspaceQueryKeys.runsIndex,
      queryKeys.todos,
      queryKeys.worktrees,
      queryKeys.repoBranches,
      workspaceQueryKeys.providerStatus,
      workspaceQueryKeys.models('cursor'),
      queryKeys.health,
    ]))
  })

  it('stops listening for visibility once unmounted', () => {
    const { unmount, source } = mount()
    source.open()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    unmount()
    setVisibility('hidden')
    setVisibility('visible')

    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('useGlobalEvents — recovery', () => {
  it('leaves an ordinary drop to the browser', () => {
    vi.useFakeTimers()
    const { source } = mount()
    source.open()

    // readyState CONNECTING: EventSource is already retrying on its own backoff, and a second
    // stream racing it would be two connections and duplicate events.
    source.drop()
    act(() => void vi.advanceTimersByTime(30_000))

    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('rebuilds a stream the browser gave up on', () => {
    vi.useFakeTimers()
    const { source } = mount()
    source.open()

    // What a restarting server produces: the request is answered with a non-2xx, EventSource closes
    // for good, and nothing would ever reopen it — the cockpit would look live showing stale state.
    source.fail()
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => void vi.advanceTimersByTime(3_000))
    expect(FakeEventSource.instances).toHaveLength(2)

    // And the rebuilt stream is a reconnect: its open reconciles.
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    FakeEventSource.last.open()
    expect(invalidate).toHaveBeenCalled()
  })

  it('does not reopen after unmount', () => {
    vi.useFakeTimers()
    const { unmount, source } = mount()
    source.fail()
    unmount()

    act(() => void vi.advanceTimersByTime(30_000))
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('reopens a dead stream immediately when the tab comes back, without waiting out the backoff', () => {
    vi.useFakeTimers()
    const { source } = mount()
    source.open()
    source.fail()

    setVisibility('visible')

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.last.readyState).toBe(0)

    // The pending backoff must not then build a third one on top.
    act(() => void vi.advanceTimersByTime(30_000))
    expect(FakeEventSource.instances).toHaveLength(2)
  })
})

describe('GlobalEventsProvider', () => {
  it('mounts one stream for the whole tree and publishes usage to it', () => {
    function Probe() {
      const all = useUsage()
      const one = useRunUsage('r1')
      return <output data-testid="probe">{`${Object.keys(all).join(',')}|${one?.cpuPct ?? '-'}`}</output>
    }

    const view = render(
      <QueryClientProvider client={client}>
        <GlobalEventsProvider>
          <Probe />
          <Probe />
        </GlobalEventsProvider>
      </QueryClientProvider>,
    )

    // Two consumers, one connection.
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(view.getAllByTestId('probe')[0]?.textContent).toBe('|-')

    FakeEventSource.last.emit('usage', JSON.stringify({ project: BOOT, usage: { r1: SAMPLE } }))

    for (const probe of view.getAllByTestId('probe')) {
      expect(probe.textContent).toBe('r1|12')
    }
  })

  it('renders outside a provider as an idle cockpit, not a crash', () => {
    function Probe() {
      return <output data-testid="probe">{`${Object.keys(useUsage()).length}${useRunUsage('r1') ? '!' : ''}`}</output>
    }
    // Telemetry must never be the reason a tree fails to render.
    const view = render(<Probe />)
    expect(view.getByTestId('probe').textContent).toBe('0')
  })
})

/** A worker of `parent`, as the stream carries it: the record the relationships readers care about. */
function workerOf(parent: string, id: string, over: Partial<RunRecord> = {}): RunRecord {
  return runRecord(id, {
    delegation: { role: 'worker', parentRunId: parent, permissions: [],
      workspace: { ownerRunId: id, resourceId: id, kind: 'owned-isolated', path: `/${id}`, branch: id, baselineSha: 'a'.repeat(40) } },
    ...over,
  })
}

describe('relationships refresh (#659)', () => {
  const key = ['default', 'runs', 'relationships', 'parent']
  const otherKey = ['other', 'runs', 'relationships', 'parent']
  const siblingKey = ['default', 'runs', 'relationships', 'sibling']

  function seed(): void {
    for (const k of [key, otherKey, siblingKey]) client.setQueryData(k, { workers: [] })
  }
  const invalidated = (k: readonly unknown[]) => client.getQueryState(k)?.isInvalidated

  it.each(['run', 'run-deleted', 'reconnect'] as const)('invalidates relationships for an invisible worker on %s without crossing projects', async event => {
    vi.useFakeTimers()
    seed()
    client.setQueryData(queryKeys.runs.list(), [])
    const { source } = mount()
    source.open()
    // Opening reconciles; establish a fresh snapshot before the event being tested.
    seed()
    if (event === 'run') source.emit('run', stampedRun(workerOf('parent', 'off-page')))
    // Never seen on this stream, so no parent is known: the whole family refreshes, once.
    else if (event === 'run-deleted') source.emit('run-deleted', JSON.stringify({ id: 'off-page', project: BOOT }))
    else { source.drop(); source.open() }
    if (event !== 'reconnect') {
      // Debounced: nothing fires on the event itself.
      expect(invalidated(key)).toBe(false)
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    }
    expect(invalidated(key)).toBe(true)
    expect(invalidated(otherKey)).toBe(false)
  })

  it('refreshes only the touched parent, and nothing for an ordinary run', async () => {
    vi.useFakeTimers()
    seed()
    const { source } = mount()
    source.open()
    seed()
    source.emit('run', stampedRun(runRecord('ordinary')))
    source.emit('run', stampedRun(workerOf('parent', 'w1')))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(invalidated(key)).toBe(true)
    expect(invalidated(siblingKey)).toBe(false)
    expect(invalidated(otherKey)).toBe(false)
  })

  it('drops a token-only tick and refreshes on a change the response carries', async () => {
    vi.useFakeTimers()
    seed()
    const { source } = mount()
    source.open()
    seed()
    source.emit('run', stampedRun(workerOf('parent', 'w1', { tokensUsed: 1 })))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(invalidated(key)).toBe(true)
    seed()
    // Same status, step, activity and delegation: the relationships answer cannot have moved.
    source.emit('run', stampedRun(workerOf('parent', 'w1', { tokensUsed: 2 })))
    source.emit('run', stampedRun(workerOf('parent', 'w1', { tokensUsed: 3, title: 'renamed' })))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(invalidated(key)).toBe(false)
    source.emit('run', stampedRun(workerOf('parent', 'w1', { tokensUsed: 4, status: 'done' })))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(invalidated(key)).toBe(true)
  })

  it('coalesces a burst of real changes into one refresh per quiet window', async () => {
    vi.useFakeTimers()
    seed()
    const { source } = mount()
    source.open()
    seed()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    for (let i = 0; i < 20; i++) {
      source.emit('run', stampedRun(workerOf('parent', 'w1', { currentStepId: `step-${i}` })))
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    const parentRefreshes = invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(key))
    expect(parentRefreshes.length).toBeLessThanOrEqual(2)
    expect(parentRefreshes.length).toBeGreaterThan(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refreshes the known parent of a deleted worker and drops the worker\'s own entry', async () => {
    vi.useFakeTimers()
    seed()
    const workerKey = ['default', 'runs', 'relationships', 'w1']
    client.setQueryData(workerKey, { parentRunId: 'parent', workers: [] })
    const { source } = mount()
    source.open()
    seed()
    source.emit('run', stampedRun(workerOf('parent', 'w1')))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    seed()
    source.emit('run-deleted', JSON.stringify({ id: 'w1', project: BOOT }))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(invalidated(key)).toBe(true)
    expect(invalidated(siblingKey)).toBe(false)
    expect(client.getQueryState(workerKey)).toBeUndefined()
  })
})


it('delivers a secondary-project structured ASK waiting transition to browser notifications', () => {
  const notifications: string[] = []
  function NotificationStub(title: string) { notifications.push(title) }
  Object.assign(NotificationStub, { permission: 'granted' })
  vi.stubGlobal('Notification', NotificationStub)
  client.setQueryData(workspaceQueryKeys.uiState, { notifications: { enabled: true } })
  const live = runRecord('structured-ask')
  client.setQueryData(['secondary', 'runs', 'list'], [live])
  render(<RunNotifications />, { wrapper })
  const { source } = mount()
  setVisibility('hidden')

  // The server's CEZ:ASK turn-end path publishes this run summary on the workspace stream.
  source.emit('run', stampedRun({ ...live, status: 'waiting', hasPendingHumanAsk: true }, 'secondary'))
  expect(notifications).toEqual(['structured-ask'])
  source.emit('run', stampedRun({ ...live, status: 'waiting', hasPendingHumanAsk: true, tokensUsed: 42 }, 'secondary'))
  expect(notifications).toHaveLength(1)
})

// #795: the stop mutation's list GET may resolve after the external re-enable SSE.
// Render the actual glyph and thread action: cache-only assertions miss UI divergence.
describe('live run list responses overlapping newer workspace events (#795)', () => {
  it.each(['boot-alias', 'boot-scoped', 'other-project'] as const)('%s keeps the re-enabled glyph after the older off-state GET completes', async scope => {
    const project = scope === 'other-project' ? 'other' : BOOT
    setApiScope(scope === 'boot-alias' ? null : project)
    const key = [scope === 'boot-alias' ? 'default' : project, 'runs', 'list'] as const
    const record = runRecord('desktop', { status: 'review', notify: true })
    const off = { ...record, notify: undefined }
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockImplementation(input => {
      if (String(input).replace('?archived=recent', '').endsWith('/run-summaries')) return stale.promise
      return Promise.resolve(json(record))
    })
    client.setQueryData(key, [record])
    client.setQueryData(queryKeys.runs.detail(record.id), record)
    client.setQueryData(workspaceQueryKeys.projects, {
      bootProject: BOOT, projectsDir: '/repos', projects: [{ id: project, name: project, root: '/repo', status: 'ok', source: 'local', addedAt: '', lastOpenedAt: '', webhook: { url: 'https://bot.example/hooks/cez', tokenSet: true } }],
    })
    function LiveHandoff() {
      useGlobalEvents(usage)
      const list = useProjectRuns(project, true, scope === 'boot-alias')
      const detail = useRun(record.id)
      return <MemoryRouter initialEntries={[`/p/${project}/tasks/${record.id}`]}>
        <TaskQuickList runs={list.data ?? []} view="active" onViewChange={() => undefined} now={Date.parse(record.createdAt)} />
        {detail.data && <HandoffAction run={detail.data} />}
      </MemoryRouter>
    }
    render(<QueryClientProvider client={client}><LiveHandoff /></QueryClientProvider>)
    const glyph = () => document.querySelector('[data-run-id="desktop"] [data-slot="task-row-notify"]')
    const source = FakeEventSource.last
    await waitFor(() => expect(glyph()).not.toBeNull())
    source.emit('run', stampedRun(off, project))
    await waitFor(() => expect(glyph()).toBeNull())
    await act(async () => { void client.invalidateQueries({ queryKey: key, exact: true }) })
    expect(client.getQueryState(key)?.fetchStatus).toBe('fetching')
    vi.mocked(fetch).mockImplementation(input => String(input).replace('?archived=recent', '').endsWith('/run-summaries') ? fresh.promise : Promise.resolve(json(record)))
    source.emit('run', stampedRun(record, project))
    await waitFor(() => expect(glyph()).not.toBeNull())
    await act(async () => stale.resolve(json([off])))
    // Detail cancellation already preserves its live event. The list must do the same.
    expect(document.querySelector('[data-slot="notifying-chip"]')).not.toBeNull()
    expect(client.getQueryData<ApiRun[]>(key)?.[0]?.notify).toBe(true)
    expect(glyph()).not.toBeNull()
    await act(async () => fresh.resolve(json([record])))
    await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))
    expect(glyph()).not.toBeNull()
  })
})

// The same missing boundary affects every ordinary run field and deletion, not just notify.
describe('ordinary run events while authoritative lists are fetching (#795)', () => {
  it.each(['warm-update', 'cold-update', 'warm-delete', 'cold-delete'] as const)('%s cannot be reversed by a pre-event GET', async kind => {
    const record = runRecord('r1')
    const newer = { ...record, title: 'New title', status: 'done' as const, pinned: true, tokensUsed: 37 }
    const newerRow = toRunSummary(newer)
    const deleted = kind.endsWith('delete')
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise)
    if (kind.startsWith('warm')) client.setQueryData(queryKeys.runs.list(), [record])
    const list = renderHook(() => useRuns(), { wrapper })
    if (kind.startsWith('warm')) await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    if (deleted) source.emit('run-deleted', JSON.stringify({ id: record.id, project: BOOT }))
    else source.emit('run', stampedRun(newer))
    if (kind.startsWith('cold')) expect(list.result.current.data).toBeUndefined() // do not invent a partial list
    else await waitFor(() => expect(list.result.current.data).toEqual(deleted ? [] : [newerRow]))
    await act(async () => stale.resolve(json([record])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.find(row => row.id === record.id)?.title).not.toBe(record.title)
    await act(async () => fresh.resolve(json(deleted ? [] : [newerRow])))
    await waitFor(() => expect(list.result.current.data).toEqual(deleted ? [] : [newerRow]))
  })

  it('keeps both inactive boot aliases fresh without fetching for absent observers', async () => {
    const record = runRecord('r1')
    client.setQueryData(['default', 'runs', 'list'], [record])
    client.setQueryData([BOOT, 'runs', 'list'], [record])
    setApiScope('other')
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, notify: true }))
    expect(client.getQueryData<ApiRun[]>(['default', 'runs', 'list'])?.[0]?.notify).toBe(true)
    expect(client.getQueryData<ApiRun[]>([BOOT, 'runs', 'list'])?.[0]?.notify).toBe(true)
    source.emit('run-deleted', JSON.stringify({ id: record.id, project: BOOT }))
    expect(client.getQueryData(['default', 'runs', 'list'])).toEqual([])
    expect(client.getQueryData([BOOT, 'runs', 'list'])).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds a live event burst to replacement plus one trailing authoritative fetch', async () => {
    const record = runRecord('r1')
    const stale = deferredResponse(), replacement = deferredResponse(), trailing = deferredResponse()
    client.setQueryData(queryKeys.runs.list(), [record])
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise).mockReturnValue(trailing.promise)
    const list = renderHook(() => useRuns(), { wrapper })
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, tokensUsed: 1 }))
    await act(async () => {})
    for (let tokensUsed = 2; tokensUsed <= 60; tokensUsed++) source.emit('run', stampedRun({ ...record, tokensUsed }))
    await act(async () => stale.resolve(json([record])))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(list.result.current.data?.[0]?.tokensUsed).toBe(60)
    await act(async () => replacement.resolve(json([{ ...record, tokensUsed: 1 }])))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    await act(async () => trailing.resolve(json([{ ...record, tokensUsed: 60 }])))
    await waitFor(() => expect(list.result.current.data?.[0]?.tokensUsed).toBe(60))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retains reconciliation after the last observer leaves and returns', async () => {
    const record = runRecord('r1')
    const stale = deferredResponse(), replacement = deferredResponse(), fresh = deferredResponse()
    client.setQueryData(queryKeys.runs.list(), [record])
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise).mockReturnValue(fresh.promise)
    const list = renderHook(() => useRuns(), { wrapper })
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, notify: true }))
    await act(async () => {})
    list.unmount()
    await act(async () => stale.resolve(json([record])))
    const returned = renderHook(() => useRuns(), { wrapper })
    await act(async () => fresh.resolve(json([{ ...record, notify: true }])))
    await waitFor(() => expect(returned.result.current.data?.[0]?.notify).toBe(true))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
  })
})

describe('cold recovery obligations recorded at event receipt (#795)', () => {
  it.each(['update', 'delete'] as const)('a second %s during cold recovery requires a trailing full snapshot', async kind => {
    const record = runRecord('r1')
    const stale = deferredResponse(), replacement = deferredResponse(), trailing = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise).mockReturnValue(trailing.promise)
    const list = renderHook(() => useRuns(), { wrapper })
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, tokensUsed: 1 }))
    await act(async () => {})
    expect(list.result.current.data).toBeUndefined()
    if (kind === 'delete') source.emit('run-deleted', JSON.stringify({ id: record.id, project: BOOT }))
    else source.emit('run', stampedRun({ ...record, tokensUsed: 2 }))
    expect(list.result.current.data).toBeUndefined()
    await act(async () => stale.resolve(json([record])))
    await act(async () => replacement.resolve(json([{ ...record, tokensUsed: 1 }])))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    const final = kind === 'delete' ? [] : [{ ...record, tokensUsed: 2 }]
    await act(async () => trailing.resolve(json(final)))
    await waitFor(() => expect(list.result.current.data).toEqual(final))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps a newly inserted row ordered and unique after the pre-event response', async () => {
    const first = runRecord('first')
    const newer = runRecord('newer', { createdAt: '2026-07-15T00:00:00.000Z' })
    client.setQueryData(queryKeys.runs.list(), [first])
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise)
    const list = renderHook(() => useRuns(), { wrapper })
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    source.emit('run', stampedRun(newer))
    await waitFor(() => expect(list.result.current.data?.map(row => row.id)).toEqual(['newer', 'first']))
    await act(async () => stale.resolve(json([first])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.map(row => row.id)).toEqual(['newer', 'first'])
    await act(async () => fresh.resolve(json([newer, first])))
    await waitFor(() => expect(list.result.current.data?.map(row => row.id)).toEqual(['newer', 'first']))
  })
})

describe('requested list attachment and recovery lifecycle (#795)', () => {
  it('reconciles once at the post-attachment ping even when open preceded the missed update', async () => {
    const record = runRecord('r1')
    const stale = deferredResponse(), preAttachment = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(preAttachment.promise).mockReturnValue(fresh.promise)
    const list = renderHook(() => useRuns(), { wrapper })
    const { source } = mount()
    source.open()
    await act(async () => {})
    expect(fetch).toHaveBeenCalledTimes(2)
    source.emit('ping', '') // server listeners are now attached; earlier update was not delivered
    await act(async () => {})
    expect(fetch).toHaveBeenCalledTimes(3)
    await act(async () => { stale.resolve(json([record])); preAttachment.resolve(json([record])); fresh.resolve(json([{ ...record, notify: true }])) })
    await waitFor(() => expect(list.result.current.data?.[0]?.notify).toBe(true))
    for (let beat = 0; beat < 20; beat++) source.emit('ping', '')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('marks disabled cached aliases stale and never fetches or invents untouched lists at attachment', async () => {
    client.setQueryData(['other', 'runs', 'list'], [runRecord('r1')])
    renderHook(() => useProjectRuns('other', false), { wrapper })
    renderHook(() => useProjectRuns('never-requested', false), { wrapper })
    const { source } = mount()
    source.open()
    source.emit('ping', '')
    await act(async () => {})
    expect(fetch).not.toHaveBeenCalled()
    expect(client.getQueryState(['other', 'runs', 'list'])?.isInvalidated).toBe(true)
    expect(client.getQueryData(['never-requested', 'runs', 'list'])).toBeUndefined()
  })

  it('retains latest warm data and a stale obligation after recovery errors, then settles once', async () => {
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
    const record = runRecord('r1')
    client.setQueryData(queryKeys.runs.list(), [record])
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new Error('offline')).mockReturnValue(fresh.promise)
    const list = renderHook(() => useRuns(), { wrapper })
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, notify: true }))
    await waitFor(() => expect(list.result.current.fetchStatus).toBe('idle'))
    await act(async () => stale.resolve(json([record])))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.[0]?.notify).toBe(true)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    await act(async () => fresh.resolve(json([{ ...record, notify: true }])))
    await waitFor(() => expect(list.result.current.data?.[0]?.notify).toBe(true))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retains an ordinary recovery obligation across removal and recreation of the same key', async () => {
    const record = runRecord('r1')
    const stale = deferredResponse(), replacement = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise).mockReturnValue(fresh.promise)
    client.setQueryData(queryKeys.runs.list(), [record])
    const list = renderHook(() => useRuns(), { wrapper })
    await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, notify: true }))
    await act(async () => {})
    list.unmount()
    client.removeQueries({ queryKey: queryKeys.runs.list(), exact: true })
    client.setQueryData(queryKeys.runs.list(), [record])
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    const returned = renderHook(() => useRuns(), { wrapper })
    await act(async () => { stale.resolve(json([record])); replacement.resolve(json([record])); fresh.resolve(json([{ ...record, notify: true }])) })
    await waitFor(() => expect(returned.result.current.data?.[0]?.notify).toBe(true))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
  })
})

// Review regressions: the first-archive fast path must protect the same HTTP/SSE boundary.
describe('archive flush and failed recovery freshness (#795)', () => {
  const captureFrame = () => {
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    return () => {
      expect(frame).toBeTypeOf('function')
      const current = frame
      frame = undefined
      act(() => current?.(performance.now()))
    }
  }

  it.each((['boot-alias', 'boot-scoped', 'other-project'] as const).flatMap(scope =>
    [false, true].map(cold => ({ scope, cold }))))('$scope cold=$cold first archive flush beats a late GET', async ({ scope, cold }) => {
    const project = scope === 'other-project' ? 'other' : BOOT
    setApiScope(scope === 'boot-alias' ? null : project)
    const key = [scope === 'boot-alias' ? 'default' : project, 'runs', 'list'] as const
    const record = runRecord('r1'), unrelated = runRecord('unrelated')
    const final = [{ ...record, archived: true }, unrelated]
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReset().mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise)
    if (!cold) client.setQueryData(key, [record, unrelated])
    const flushFrame = captureFrame()
    const list = renderHook(() => useProjectRuns(project, true, scope === 'boot-alias'), { wrapper })
    if (!cold) await act(async () => { void client.invalidateQueries({ queryKey: key, exact: true }) })
    expect(fetch).toHaveBeenCalledTimes(1)
    const stream = mount()
    stream.source.emit('run', stampedRun(final[0]!, project))
    flushFrame() // Never release the stale GET until the archive batch has written.
    if (cold) expect(client.getQueryData(key)).toBeUndefined()
    else expect(client.getQueryData<ApiRun[]>(key)?.[0]?.archived).toBe(true)
    await act(async () => stale.resolve(json([record, unrelated])))
    expect(client.getQueryData<ApiRun[]>(key)?.[0]?.archived).not.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => fresh.resolve(json(final)))
    await waitFor(() => expect(list.result.current.data).toEqual(final))
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    list.unmount(); stream.unmount()
  })

  it.each(['warm', 'cold'] as const)('%s archive burst keeps one replacement plus one trailing fetch', async temperature => {
    const records = Array.from({ length: 30 }, (_, i) => runRecord(`r${i}`))
    const final = records.map(record => ({ ...record, archived: true }))
    const stale = deferredResponse(), replacement = deferredResponse(), trailing = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise).mockReturnValue(trailing.promise)
    if (temperature === 'warm') client.setQueryData(queryKeys.runs.list(), records)
    const flushFrame = captureFrame()
    const list = renderHook(() => useRuns(), { wrapper })
    if (temperature === 'warm') await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    for (const record of final.slice(0, 15)) source.emit('run', stampedRun(record))
    flushFrame()
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const record of final.slice(15)) source.emit('run', stampedRun(record))
    flushFrame()
    expect(fetch).toHaveBeenCalledTimes(2)
    if (temperature === 'cold') expect(client.getQueryData(queryKeys.runs.list())).toBeUndefined()
    await act(async () => stale.resolve(json(records)))
    await act(async () => replacement.resolve(json(records.map((record, i) => i < 15 ? final[i] : record))))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    await act(async () => trailing.resolve(json(final)))
    await waitFor(() => expect(list.result.current.data).toEqual(final))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('records a cold archive as dirty before its deferred frame can patch anything', async () => {
    const record = runRecord('r1')
    const stale = deferredResponse(), replacement = deferredResponse(), afterEvent = deferredResponse(), afterFlush = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise).mockReturnValueOnce(afterEvent.promise).mockReturnValue(afterFlush.promise)
    const flushFrame = captureFrame()
    const list = renderHook(() => useRuns(), { wrapper })
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, notify: true }))
    source.emit('run', stampedRun({ ...record, archived: true }))
    expect(client.getQueryData(queryKeys.runs.list())).toBeUndefined()
    // Recovery completes before the archive frame. Receipt itself must retain its obligation.
    await act(async () => replacement.resolve(json([{ ...record, notify: true }])))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    flushFrame() // The intervening success keeps the existing generation-conflict recovery rule.
    expect(fetch).toHaveBeenCalledTimes(4)
    await act(async () => { stale.resolve(json([record])); afterEvent.resolve(json([{ ...record, archived: true }])); afterFlush.resolve(json([{ ...record, archived: true }])) })
    await waitFor(() => expect(list.result.current.data?.[0]?.archived).toBe(true))
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it.each(['warm-update', 'cold-update', 'warm-delete', 'cold-delete', 'warm-archive', 'cold-archive'] as const)('%s new event resumes failed recovery once without automatic retry', async kind => {
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
    const record = runRecord('r1'), unrelated = runRecord('unrelated')
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new Error('offline')).mockReturnValue(fresh.promise)
    if (kind.startsWith('warm')) client.setQueryData(queryKeys.runs.list(), [record, unrelated])
    const flushFrame = captureFrame()
    const list = renderHook(() => useRuns(), { wrapper })
    expect(list.result.current.data).toEqual(kind.startsWith('warm') ? [record, unrelated] : undefined)
    if (kind.startsWith('warm')) await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.runs.list() }) })
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, notify: true }))
    await waitFor(() => expect(list.result.current.isError).toBe(true))
    await act(async () => stale.resolve(json([record, unrelated])))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    const newer = { ...record, notify: true, title: 'New name', archived: kind.endsWith('archive') }
    const final = kind.endsWith('delete') ? [unrelated] : [newer, unrelated]
    if (kind.endsWith('delete')) source.emit('run-deleted', JSON.stringify({ id: record.id, project: BOOT }))
    else source.emit('run', stampedRun(newer))
    if (kind.endsWith('archive')) flushFrame()
    await act(async () => {})
    expect(fetch).toHaveBeenCalledTimes(3)
    if (kind.startsWith('cold')) expect(client.getQueryData(queryKeys.runs.list())).toBeUndefined()
    await act(async () => fresh.resolve(json(final)))
    await waitFor(() => expect(list.result.current.data).toEqual(final))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('failed cold recovery with no enabled reader (#795)', () => {
  it('keeps the obligation stale without a background fetch until the disabled reader returns', async () => {
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
    const record = runRecord('r1')
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new Error('offline')).mockReturnValue(fresh.promise)
    const list = renderHook(({ enabled }) => useProjectRuns(BOOT, enabled, true), { wrapper, initialProps: { enabled: true } })
    expect(list.result.current.data).toBeUndefined() // subscribe to data as well as the error state
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, notify: true }))
    await waitFor(() => expect(list.result.current.isError).toBe(true))
    list.rerender({ enabled: false })
    source.emit('run', stampedRun({ ...record, notify: true, title: 'Latest' }))
    await act(async () => stale.resolve(json([record])))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(queryKeys.runs.list())).toBeUndefined()
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    list.rerender({ enabled: true })
    expect(fetch).toHaveBeenCalledTimes(3)
    await act(async () => fresh.resolve(json([{ ...record, notify: true, title: 'Latest' }])))
    await waitFor(() => expect(list.result.current.data?.[0]?.title).toBe('Latest'))
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
  })
})

describe('incomplete inactive snapshots remain stale across live patches (#795)', () => {
  it.each((['default', 'boot'] as const).flatMap(alias =>
    (['invalidate', 'first-open', 'reconnect'] as const).flatMap(boundary =>
      (['update', 'delete', 'archive'] as const).map(kind => ({ alias, boundary, kind }))))
  )('$alias $boundary $kind preserves missed-history reconciliation until enabled', async ({ alias, boundary, kind }) => {
    setApiScope('other')
    client.setQueryData(workspaceQueryKeys.projects, { bootProject: BOOT, projects: [] })
    const record = runRecord('r1'), missedDeletion = runRecord('removed-while-offline')
    const newer = { ...record, title: 'Latest', archived: kind === 'archive' }
    const key = [alias === 'default' ? 'default' : BOOT, 'runs', 'list'] as const
    client.setQueryData(['default', 'runs', 'list'], [record, missedDeletion])
    client.setQueryData([BOOT, 'runs', 'list'], [record, missedDeletion])
    const fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValue(fresh.promise)
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const list = renderHook(({ enabled }) => useProjectRuns(BOOT, enabled, alias === 'default'), { wrapper, initialProps: { enabled: false } })
    const { source } = mount()
    if (boundary === 'invalidate') await act(async () => { await client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' }) })
    else {
      source.open()
      source.emit('ping', '')
      if (boundary === 'reconnect') source.open()
    }
    // Attachment's queued cancel/invalidate callbacks finish while the reader is still disabled.
    await act(async () => {})
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    if (kind === 'delete') source.emit('run-deleted', JSON.stringify({ id: record.id, project: BOOT }))
    else source.emit('run', stampedRun(newer))
    if (kind === 'archive') {
      expect(frame).toBeTypeOf('function')
      act(() => frame?.(performance.now()))
    }
    // Immediate complete-record news is visible, but cannot certify all rows we missed offline.
    expect(client.getQueryData<ApiRun[]>(key)?.find(row => row.id === record.id)).toEqual(kind === 'delete' ? undefined : toRunSummary(newer))
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    list.rerender({ enabled: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    const final = kind === 'delete' ? [] : [toRunSummary(newer)]
    await act(async () => fresh.resolve(json(final)))
    await waitFor(() => expect(list.result.current.data).toEqual(final))
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('exhausted cold recovery remains event driven (#795)', () => {
  it('bounds a new event burst to one failed attempt and waits for another event to recover', async () => {
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
    const record = runRecord('r1'), unrelated = runRecord('unrelated')
    const stale = deferredResponse(), fresh = deferredResponse()
    vi.mocked(fetch).mockReturnValueOnce(stale.promise)
      .mockRejectedValueOnce(new Error('offline once')).mockRejectedValueOnce(new Error('offline again')).mockReturnValue(fresh.promise)
    const list = renderHook(() => useRuns(), { wrapper })
    expect(list.result.current.data).toBeUndefined()
    const { source } = mount()
    source.emit('run', stampedRun({ ...record, tokensUsed: 1 }))
    await waitFor(() => expect(list.result.current.isError).toBe(true))
    expect(fetch).toHaveBeenCalledTimes(2)
    for (let tokensUsed = 2; tokensUsed <= 30; tokensUsed++) source.emit('run', stampedRun({ ...record, tokensUsed }))
    await waitFor(() => expect(client.getQueryState(queryKeys.runs.list())?.errorUpdateCount).toBe(2))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(list.result.current.data).toBeUndefined()
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(true)
    await act(async () => stale.resolve(json([record, unrelated])))
    expect(fetch).toHaveBeenCalledTimes(3) // Exhaustion itself has no retry timer or self-loop.
    source.emit('run', stampedRun({ ...record, tokensUsed: 31 }))
    expect(fetch).toHaveBeenCalledTimes(4)
    await act(async () => fresh.resolve(json([{ ...record, tokensUsed: 31 }, unrelated])))
    await waitFor(() => expect(list.result.current.data).toEqual([{ ...record, tokensUsed: 31 }, unrelated]))
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(client.getQueryState(queryKeys.runs.list())?.isInvalidated).toBe(false)
  })
})
