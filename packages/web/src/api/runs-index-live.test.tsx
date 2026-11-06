import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { RunIndexEntry, RunsIndexResponse, RunSummary } from '@open-mercato/cezar-api-client'

import { createUsageStore } from './events'
import { useGlobalEvents } from './global-events'
import { configureLiveSession, resetLiveSession } from './live-coordinator'
import { LIVE_PROTOCOL } from './live-protocol'
import { createQueryClient } from './query-client'
import { RUNS_INDEX_BACKSTOP_MS, useRunsIndex, workspaceQueryKeys } from './queries'
import { runsIndexSync } from './runs-index-sync'

/**
 * The runs index through the real live coordinator (hearsay-tools/cezarion#2729): the shared
 * live read's merge hook, the visible-only backstop and the visibility-restore reconciliation.
 */

class Worker {
  static all: Worker[] = []
  port = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null, onmessageerror: null }
  addEventListener = vi.fn()
  constructor() { Worker.all.push(this) }
}

type SyncMessage = { type: string; epoch: number; entries: Array<{ id: string; demand: { kind: string; path?: string; intervalMs?: number } }> }

const HEALTH = { bootProject: 'boot', capabilities: { localHandoff: true, settingsAdmin: true, remoteSettingsAdmin: false, singleProject: false, automations: false, preview: false, voice: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true } }
const INDEX_PATH = '/api/v1/workspace/runs-index'

function summary(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return { id, title: id, status: RUN_STATUS.running, createdAt: '2026-01-02', archived: false, workflow: 'quick-task', workflowLabel: 'Quick task', tokensUsed: 0, ...over } as RunSummary
}

function snapshot(runs: RunIndexEntry[], eventSeq: number): RunsIndexResponse {
  return { runs, referenceStatuses: {}, perProjectLimit: 200, truncated: [], generation: 'g1', eventSeq }
}

let served: RunsIndexResponse
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers()
  Worker.all = []
  served = snapshot([{ projectId: 'a', ...summary('a1') }], 10)
  vi.stubGlobal('SharedWorker', Worker)
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(
    String(path).endsWith('/health') ? HEALTH : String(path).startsWith(INDEX_PATH) ? served : {},
  ))))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  client = createQueryClient()
})

afterEach(() => { cleanup(); resetLiveSession(); vi.useRealTimers(); vi.unstubAllGlobals() })

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const title = () => client.getQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex)?.runs[0]?.title
const indexReads = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).startsWith(INDEX_PATH))
const lastSync = (worker: Worker) => worker.port.postMessage.mock.calls.map(([message]) => message as SyncMessage).filter((message) => message.type === 'sync').at(-1)!
const readDemands = (worker: Worker) => lastSync(worker).entries.filter((entry) => entry.demand.kind === 'read' && entry.demand.path === INDEX_PATH)

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('runs index backstop (D2)', () => {
  it('asks the shared worker for one read per 60 s by default, a shorter interval when a page asks, none when disabled', () => {
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    const shell = renderHook(() => useRunsIndex(), { wrapper })
    const worker = Worker.all[0]!
    expect(readDemands(worker).map((entry) => entry.demand.intervalMs)).toEqual([RUNS_INDEX_BACKSTOP_MS])
    expect(RUNS_INDEX_BACKSTOP_MS).toBe(60_000)
    // The global Tasks page passes its own interval; the owner reads the path at the shortest one.
    renderHook(() => useRunsIndex(true, 15_000), { wrapper })
    expect(readDemands(worker).map((entry) => entry.demand.intervalMs).sort()).toEqual([15_000, RUNS_INDEX_BACKSTOP_MS])
    shell.unmount()
    renderHook(() => useRunsIndex(false), { wrapper })
    expect(readDemands(worker).map((entry) => entry.demand.intervalMs)).toEqual([15_000])
  })

  it('a hidden document releases the backstop demand', async () => {
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    renderHook(() => useRunsIndex(), { wrapper })
    const worker = Worker.all[0]!
    expect(readDemands(worker)).toHaveLength(1)
    act(() => setVisibility('hidden'))
    expect(lastSync(worker).entries).toEqual([])
    expect(worker.port.close).toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(RUNS_INDEX_BACKSTOP_MS * 2))
    expect(Worker.all).toHaveLength(1)
  })

  it('a hidden document makes no backstop request in finite mode', async () => {
    vi.stubGlobal('SharedWorker', undefined)
    configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })
    renderHook(() => useRunsIndex(), { wrapper })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    act(() => setVisibility('hidden'))
    vi.mocked(fetch).mockClear()
    await act(async () => vi.advanceTimersByTimeAsync(RUNS_INDEX_BACKSTOP_MS * 2))
    expect(indexReads()).toHaveLength(0)
  })

  it('the shared read passes the fence: a frame newer than the polled snapshot stays on top', async () => {
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    renderHook(() => useRunsIndex(), { wrapper })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(title()).toBe('a1')
    const sync = runsIndexSync(client)
    sync.ready('g1', 10)
    sync.run('a', { type: 'run-summary', summary: summary('a1', { title: 'renamed' }), seq: 11, relationships: 'd' })
    const worker = Worker.all[0]!
    const message = lastSync(worker)
    const read = readDemands(worker)[0]!
    // The worker's poll answer predates the frame.
    await act(async () => {
      worker.port.onmessage?.({ data: { type: 'value', version: LIVE_PROTOCOL, epoch: message.epoch, id: read.id, value: snapshot([{ projectId: 'a', ...summary('a1') }], 10) } })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(title()).toBe('renamed')
  })
})

describe('runs index: remote mode (D9)', () => {
  it('keeps the 5 s full reconciliation through the fence, with no extra read per snapshot', async () => {
    vi.stubGlobal('SharedWorker', undefined)
    configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })
    const usage = createUsageStore()
    renderHook(() => { useGlobalEvents(usage); return useRunsIndex() }, { wrapper })
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    const before = indexReads().length
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    // One read per 5 s workspace reconciliation; the 60 s backstop does not replace it, and no
    // snapshot (there is no stream generation to disagree with) asks for another read.
    expect(indexReads().length - before).toBe(4)
    expect(title()).toBe('a1')
  })
})

describe('runs index: visibility restore', () => {
  it('reconciles through the fence: the restored snapshot keeps frames newer than it', async () => {
    configureLiveSession({ local: true, bootProject: 'boot', apiBase: '' })
    const usage = createUsageStore()
    renderHook(() => { useGlobalEvents(usage); return useRunsIndex() }, { wrapper })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(title()).toBe('a1')
    const worker = Worker.all[0]!
    const message = lastSync(worker)
    const workspace = message.entries.find((entry) => entry.demand.kind === 'workspace')!
    const frame = (event: string, data: unknown) => worker.port.onmessage?.({ data: {
      type: 'frame', version: LIVE_PROTOCOL, epoch: message.epoch, id: workspace.id, frame: { event, data: JSON.stringify(data), id: '' },
    } })
    await act(async () => {
      frame('ready', { generation: 'g1', seq: 10 })
      frame('run-summary', { project: 'a', seq: 11, run: summary('a1', { title: 'renamed' }), relationships: 'd' })
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(title()).toBe('renamed')

    act(() => setVisibility('hidden'))
    const before = indexReads().length
    // The server answers a snapshot from before the frame, as a lagging read can.
    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    // bound: hang guard only; restoration chains the health read, the reconcile and the index read.
    await vi.waitFor(() => expect(indexReads().length).toBeGreaterThan(before))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(title()).toBe('renamed')
  })
})
