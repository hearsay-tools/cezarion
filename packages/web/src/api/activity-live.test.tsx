import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_READ_MS, activityQueryKey, useActivityLive, type ActivityScope } from './activity-live'
import { configureLiveSession, resetLiveSession } from './live-coordinator'
import { LIVE_PROTOCOL } from './live-protocol'
import { createQueryClient } from './query-client'

class Worker {
  static all: Worker[] = []
  listeners = new Map<string, () => void>()
  port = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null, onmessageerror: null }
  addEventListener = vi.fn((type: string, listener: () => void) => { this.listeners.set(type, listener) })
  constructor() { Worker.all.push(this) }
}

const snapshot = (title: string, generatedAt = '2026-11-05T00:00:00.000Z') => ({
  generatedAt,
  projects: [{ projectId: 'shop', name: 'Shop', loaded: true, inReview: 0, tasks: [{ title }], requests: [], closed: [] }],
})
const shop: ActivityScope = { kind: 'project', projectId: 'shop' }
const readPath = '/api/v1/workspace/activity?project=shop'

let served = 'first'
/** When set, the activity route refuses the read with this answer. */
let refusal: { status: number; error: string } | undefined
beforeEach(() => {
  vi.useFakeTimers()
  Worker.all = []
  served = 'first'
  refusal = undefined
  vi.stubGlobal('SharedWorker', Worker)
  vi.stubGlobal('fetch', vi.fn(async () => refusal
    ? new Response(JSON.stringify({ error: refusal.error }), { status: refusal.status })
    : new Response(JSON.stringify(snapshot(served)))))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { cleanup(); resetLiveSession(); vi.useRealTimers(); vi.unstubAllGlobals() })

function mount(scope: ActivityScope = shop) {
  const client = createQueryClient()
  const hook = renderHook(() => useActivityLive(scope), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  const title = () => (client.getQueryData(activityQueryKey(scope)) as ReturnType<typeof snapshot> | undefined)?.projects[0]?.tasks[0]?.title
  const project = () => (client.getQueryData(activityQueryKey(scope)) as ReturnType<typeof snapshot> | undefined)?.projects[0]
  return { client, hook, title, project }
}

const reads = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path) === readPath)
/** The demands the document last handed the shared worker. */
const synced = (worker: Worker) => {
  const sync = worker.port.postMessage.mock.calls.map(([message]) => message as { type: string; epoch: number; entries: Array<{ id: string; demand: { kind: string; topic?: string } }> })
    .filter((message) => message.type === 'sync').at(-1)!
  return sync
}

describe('useActivityLive', () => {
  it('reads the snapshot once, then folds the project topic when the coordinator has topics', async () => {
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    const { hook, title } = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(title()).toBe('first')
    expect(Worker.all).toHaveLength(1)
    const worker = Worker.all[0]!
    const sync = synced(worker)
    expect(sync.entries.map((entry) => entry.demand)).toEqual([{ kind: 'topic', topic: 'activity:project:shop' }])

    await act(async () => {
      worker.port.onmessage?.({ data: { type: 'value', version: LIVE_PROTOCOL, epoch: sync.epoch, id: sync.entries[0]!.id, value: snapshot('pushed') } })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(title()).toBe('pushed')
    // No recurring HTTP read rides along with a working topic.
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * ACTIVITY_READ_MS) })
    expect(reads()).toHaveLength(1)

    hook.unmount()
    expect(worker.port.close).toHaveBeenCalled()
  })

  it('keeps a topic snapshot when an older initial read answers after it', async () => {
    let answer!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve })))
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    const { title } = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const worker = Worker.all[0]!
    const sync = synced(worker)
    await act(async () => {
      worker.port.onmessage?.({ data: { type: 'value', version: LIVE_PROTOCOL, epoch: sync.epoch, id: sync.entries[0]!.id, value: snapshot('pushed', '2026-11-05T00:00:02.000Z') } })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      answer(new Response(JSON.stringify(snapshot('first', '2026-11-05T00:00:01.000Z'))))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(title()).toBe('pushed')
  })

  it('never lets an older HTTP answer replace a newer cached snapshot', async () => {
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    const { client, title } = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => { client.setQueryData(activityQueryKey(shop), snapshot('pushed', '2026-11-05T00:00:02.000Z')) })
    await act(async () => { await client.refetchQueries({ queryKey: activityQueryKey(shop) }) })
    expect(reads()).toHaveLength(2)
    expect(title()).toBe('pushed')
  })

  it('subscribes the workspace topic for the global view', async () => {
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    mount({ kind: 'workspace' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(synced(Worker.all[0]!).entries.map((entry) => entry.demand)).toEqual([{ kind: 'topic', topic: 'activity:workspace' }])
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/v1/workspace/activity', expect.anything())
  })

  it.each([
    ['remote mode', () => configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })],
    ['no SharedWorker', () => {
      vi.stubGlobal('SharedWorker', undefined)
      configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    }],
    ['a failed SharedWorker', () => {
      configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
      Worker.all[0]!.listeners.get('error')!()
    }],
  ])('re-reads the snapshot every 5 s with %s', async (_name, arrange) => {
    const { hook, title } = mount()
    arrange()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(title()).toBe('first')
    const first = reads().length

    served = 'polled'
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVITY_READ_MS) })
    expect(reads().length).toBe(first + 1)
    expect(title()).toBe('polled')

    hook.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * ACTIVITY_READ_MS) })
    expect(reads().length).toBe(first + 1)
  })

  it('shows a project the finite read finds removed as unavailable', async () => {
    const { project } = mount()
    configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(project()).toMatchObject({ loaded: true, tasks: [{ title: 'first' }] })

    refusal = { status: 404, error: 'unknown project: shop' } // removed in another tab
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVITY_READ_MS) })
    expect(project()).toEqual({ projectId: 'shop', name: 'Shop', loaded: true, unavailable: { status: 404, error: 'unknown project: shop' },
      inReview: 0, tasks: [], requests: [], closed: [] })
  })

  it('reports any other failed finite read as the query error and keeps the last snapshot', async () => {
    const { title, client } = mount()
    configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    refusal = { status: 500, error: 'boom' }
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVITY_READ_MS) })
    expect(client.getQueryState(activityQueryKey(shop))).toMatchObject({ status: 'error', error: { status: 500, message: 'boom' } })
    expect(title()).toBe('first')

    refusal = undefined
    served = 'back'
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) }) // past the fallback's back-off
    expect(title()).toBe('back')
    expect(client.getQueryState(activityQueryKey(shop))).toMatchObject({ status: 'success', error: null })
  })

  it('shows a project its first read finds removed as unavailable', async () => {
    refusal = { status: 404, error: 'unknown project: shop' }
    const { project } = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(project()).toMatchObject({ projectId: 'shop', name: 'shop', unavailable: { status: 404 } })
  })
})
