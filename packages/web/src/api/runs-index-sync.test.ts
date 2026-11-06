import { QueryObserver, type QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { RunIndexEntry, RunsIndexResponse, RunSummary } from '@open-mercato/cezar-api-client'

import { createQueryClient } from './query-client'
import { createRunsIndexSync, RUNS_INDEX_QUERY_KEY, RUNS_INDEX_RECONCILE_HOLD_MS, type RunsIndexSync } from './runs-index-sync'

function summary(id: string, createdAt: string, over: Partial<RunSummary> = {}): RunSummary {
  return { id, title: id, status: RUN_STATUS.running, createdAt, archived: false, workflow: 'quick-task', workflowLabel: 'Quick task', tokensUsed: 0, ...over } as RunSummary
}

function row(projectId: string, id: string, createdAt: string, over: Partial<RunSummary> = {}): RunIndexEntry {
  return { projectId, ...summary(id, createdAt, over) }
}

function snapshot(runs: RunIndexEntry[], over: Partial<RunsIndexResponse> = {}): RunsIndexResponse {
  return { runs, referenceStatuses: {}, perProjectLimit: 2, truncated: [], generation: 'g1', eventSeq: 10, ...over }
}

const SEED = () => snapshot([row('a', 'a2', '2026-01-02'), row('b', 'b1', '2026-01-01')])

let client: QueryClient
let sync: RunsIndexSync
let frames: Array<() => void>
let seq: number

const cached = () => client.getQueryData<RunsIndexResponse>(RUNS_INDEX_QUERY_KEY)
const titles = () => cached()?.runs.map((entry) => entry.title)
const runFrame = (project: string, run: RunSummary) => sync.run(project, { type: 'run-summary', summary: run, seq: ++seq, relationships: 'd' })
const runAnimationFrames = () => {
  const due = frames
  frames = []
  for (const callback of due) callback()
}

/** An observed index whose query function answers `answer()` through the sync's fence. */
function observe(answer: () => RunsIndexResponse | Promise<RunsIndexResponse>) {
  const queryFn = vi.fn(async () => sync.merge(await answer()))
  const observer = new QueryObserver(client, { queryKey: RUNS_INDEX_QUERY_KEY, queryFn, staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  return { queryFn, unsubscribe }
}

beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  seq = 10
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: () => void) => { frames.push(callback); return frames.length }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  client = createQueryClient()
  sync = createRunsIndexSync(client)
  sync.ready('g1', 10)
})

afterEach(() => {
  sync.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('runs index sync: patches', () => {
  it('patches the cached row in the next animation frame, with no request', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    runFrame('a', summary('a2', '2026-01-02', { title: 'renamed' }))
    expect(titles()).toEqual(['a2', 'b1'])
    runAnimationFrames()
    expect(titles()).toEqual(['renamed', 'b1'])
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('coalesces every frame of one animation frame into one cache write', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const writes = vi.spyOn(client, 'setQueryData')
    for (const title of ['one', 'two', 'three']) runFrame('a', summary('a2', '2026-01-02', { title }))
    runFrame('b', summary('b1', '2026-01-01', { status: RUN_STATUS.done }))
    runAnimationFrames()
    expect(writes).toHaveBeenCalledTimes(1)
    expect(titles()).toEqual(['three', 'b1'])
    expect(cached()?.runs[1]?.status).toBe('done')
  })

  it('a hidden document without animation frames still patches within the fallback bound', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    runFrame('a', summary('a2', '2026-01-02', { title: 'hidden' }))
    vi.advanceTimersByTime(100)
    expect(titles()).toEqual(['hidden', 'b1'])
  })

  it('skips frames the cached snapshot already includes', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, snapshot(SEED().runs, { eventSeq: 50 }))
    runFrame('a', summary('a2', '2026-01-02', { title: 'older than the snapshot' }))
    runAnimationFrames()
    expect(titles()).toEqual(['a2', 'b1'])
  })

  it('usage ticks patch the project\'s rows; an empty tick clears them', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const sample = { cpuPct: 5, rssBytes: 10, procCount: 1 }
    sync.usage('a', { a2: sample })
    runAnimationFrames()
    expect(cached()?.runs[0]?.usage).toEqual(sample)
    sync.usage('a', {})
    runAnimationFrames()
    expect(cached()?.runs[0]).not.toHaveProperty('usage')
  })

  it('a removed project drops its rows at once, with no request, and its queued frames are discarded', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    runFrame('b', summary('b9', '2026-01-09'))
    sync.dropProject('b')
    expect(cached()?.runs.map((entry) => entry.id)).toEqual(['a2'])
    runAnimationFrames()
    expect(cached()?.runs.map((entry) => entry.id)).toEqual(['a2'])
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a cold cache records the overlay but is never created by a frame; the first read merges it', async () => {
    runFrame('a', summary('a2', '2026-01-02', { title: 'heard before the read' }))
    runAnimationFrames()
    expect(client.getQueryCache().find({ queryKey: RUNS_INDEX_QUERY_KEY })).toBeUndefined()
    const { unsubscribe } = observe(() => SEED())
    await vi.advanceTimersByTimeAsync(0)
    expect(titles()).toEqual(['heard before the read', 'b1'])
    unsubscribe()
  })

  it('a truncated-boundary move patches, then reconciles after the hold', async () => {
    const answer = vi.fn(() => snapshot(SEED().runs, { truncated: ['a'], eventSeq: seq }))
    client.setQueryData(RUNS_INDEX_QUERY_KEY, answer())
    const { queryFn, unsubscribe } = observe(answer)
    runFrame('a', summary('a2', '2026-01-02', { archived: true }))
    runAnimationFrames()
    expect(cached()?.runs[0]?.archived).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS)
    expect(queryFn).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('an unknown project reconciles instead of inventing its rows', async () => {
    client.setQueryData(['workspace', 'projects'], { projects: [{ id: 'a' }, { id: 'b' }] })
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    // A read that starts after the frame includes it, as the server's `eventSeq` does.
    const { queryFn, unsubscribe } = observe(() => snapshot(SEED().runs, { eventSeq: seq }))
    runFrame('new', summary('n1', '2026-01-09'))
    runAnimationFrames()
    expect(cached()?.runs.map((entry) => entry.id)).toEqual(['a2', 'b1'])
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS)
    expect(queryFn).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('runs index sync: reconciliation', () => {
  it('runs at most one read at a time, plus one trailing read for triggers during it', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    let release!: () => void
    const { queryFn, unsubscribe } = observe(() => new Promise<RunsIndexResponse>((resolve) => { release = () => resolve(SEED()) }))
    void sync.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(queryFn).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) void sync.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(queryFn).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(queryFn).toHaveBeenCalledTimes(2)
    release()
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS * 2)
    expect(queryFn).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('holds then fires: sustained triggers cannot postpone the read', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const { queryFn, unsubscribe } = observe(() => SEED())
    for (let elapsed = 0; elapsed < RUNS_INDEX_RECONCILE_HOLD_MS; elapsed += 100) {
      void sync.reconcile({ hold: true })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(queryFn).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('an immediate trigger fires a held read at once', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const { queryFn, unsubscribe } = observe(() => SEED())
    void sync.reconcile({ hold: true })
    void sync.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(queryFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS)
    expect(queryFn).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('creates no cache when nothing observes the index', async () => {
    await sync.reconcile()
    expect(client.getQueryCache().find({ queryKey: RUNS_INDEX_QUERY_KEY })).toBeUndefined()
  })

  it('replaces a cold read that predates the trigger', async () => {
    const first = vi.fn(() => new Promise<RunsIndexResponse>(() => {}))
    const { unsubscribe } = observe(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledTimes(1)
    const cancel = vi.spyOn(client, 'cancelQueries')
    void sync.reconcile()
    expect(cancel).toHaveBeenCalledWith({ queryKey: RUNS_INDEX_QUERY_KEY, exact: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('a missed prefix triggers exactly one more reconciliation', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const reads = [snapshot(SEED().runs, { eventSeq: 30 }), snapshot(SEED().runs, { eventSeq: 20 }), snapshot(SEED().runs, { eventSeq: 30 })]
    const { queryFn, unsubscribe } = observe(() => reads.shift() ?? snapshot(SEED().runs, { eventSeq: 30 }))
    await sync.reconcile()
    expect(queryFn).toHaveBeenCalledTimes(1)
    // A late, older answer: frames 21..30 are no longer in the overlay. It asks for one more
    // read, which runs as the trailing read of this one.
    await sync.reconcile()
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS)
    expect(queryFn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS * 3)
    expect(queryFn).toHaveBeenCalledTimes(3)
    unsubscribe()
  })
})

describe('runs index sync: sustained updates', () => {
  it('events every 200 ms for 5 s patch rows each animation frame, and a boundary read still fires', async () => {
    const answer = () => snapshot([row('a', 'a2', '2026-01-02'), row('a', 'a1', '2026-01-01', { archived: true })], { truncated: ['a'], eventSeq: seq })
    client.setQueryData(RUNS_INDEX_QUERY_KEY, answer())
    const { queryFn, unsubscribe } = observe(answer)
    let firstRead: number | undefined
    for (let tick = 1; tick <= 25; tick++) {
      runFrame('a', summary('a2', '2026-01-02', { title: `tick ${tick}`, tokensUsed: tick }))
      // A boundary move in the middle of the stream.
      if (tick === 5) runFrame('a', summary('a1', '2026-01-01'))
      runAnimationFrames()
      // The row is current after every frame; nothing waits for the stream to go quiet.
      expect(cached()?.runs.find((entry) => entry.id === 'a2')?.title).toBe(`tick ${tick}`)
      await vi.advanceTimersByTimeAsync(200)
      if (firstRead === undefined && queryFn.mock.calls.length > 0) firstRead = tick
    }
    // The hold fired 400 ms after the boundary move (tick 5), under sustained events.
    expect(firstRead).toBeLessThanOrEqual(7)
    expect(queryFn.mock.calls.length).toBeLessThanOrEqual(2)
    unsubscribe()
  })
})
