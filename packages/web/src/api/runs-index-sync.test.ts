import { QueryObserver, type QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { RunIndexEntry, RunsIndexResponse, RunSummary } from '@open-mercato/cezar-api-client'

import { createQueryClient } from './query-client'
import { createRunsIndexSync, RUNS_INDEX_QUERY_KEY, RUNS_INDEX_RECONCILE_HOLD_MS, RUNS_INDEX_WRITE_INTERVAL_MS, type RunsIndexSync } from './runs-index-sync'

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
/** The times of the sync's own index writes (`setQueryData`), as fake `Date.now()` values. */
const indexWrites = () => {
  const times: number[] = []
  const original = client.setQueryData.bind(client)
  vi.spyOn(client, 'setQueryData').mockImplementation(((key: unknown, value: unknown) => {
    if (JSON.stringify(key) === JSON.stringify(RUNS_INDEX_QUERY_KEY)) times.push(Date.now())
    return original(key as never, value as never)
  }) as typeof client.setQueryData)
  return () => times
}
const minGap = (times: number[]) => Math.min(Infinity, ...times.slice(1).map((at, i) => at - times[i]!))
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

  it('usage ticks patch the project\'s rows; an empty tick clears them', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const sample = { cpuPct: 5, rssBytes: 10, procCount: 1 }
    sync.usage('a', { a2: sample })
    runAnimationFrames()
    expect(cached()?.runs[0]?.usage).toEqual(sample)
    sync.usage('a', {})
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_WRITE_INTERVAL_MS)
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

describe('runs index sync: review round 1', () => {
  it('B1: a snapshot read before a project removal does not bring the project back', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, snapshot(SEED().runs, { truncated: ['a'], referenceStatuses: { a: { prs: {}, issues: {} } } as RunsIndexResponse['referenceStatuses'] }))
    sync.dropProject('a')
    expect(titles()).toEqual(['b1'])
    // The query function or the shared live read answers with a snapshot taken before the removal.
    const late = sync.merge(snapshot(SEED().runs, { truncated: ['a'], referenceStatuses: { a: { prs: {}, issues: {} } } as RunsIndexResponse['referenceStatuses'] }))
    expect(late.runs.map((entry) => entry.projectId)).toEqual(['b'])
    expect(late.truncated).toEqual([])
    expect(late.referenceStatuses).toEqual({})
    // Frames of the removed project do not bring it back either.
    runFrame('a', summary('a9', '2026-01-09'))
    runAnimationFrames()
    expect(titles()).toEqual(['b1'])
    // A snapshot without the project confirms the removal; a project added again comes back.
    sync.merge(snapshot([row('b', 'b1', '2026-01-01')]))
    sync.restoreProject('a')
    expect(sync.merge(snapshot(SEED().runs)).runs.map((entry) => entry.id)).toEqual(['a2', 'b1'])
  })

  it('B1: a project added again before any confirming snapshot comes back', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    sync.dropProject('a')
    sync.restoreProject('a')
    expect(sync.merge(snapshot(SEED().runs)).runs.map((entry) => entry.id)).toEqual(['a2', 'b1'])
  })

  it('D1: a patch queued under one generation is not applied after a restart', () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    runFrame('a', summary('a2', '2026-01-02', { title: 'from g1' }))
    sync.ready('g2', 0)
    client.setQueryData(RUNS_INDEX_QUERY_KEY, snapshot([row('a', 'a2', '2026-01-02', { title: 'from g2' }), row('b', 'b1', '2026-01-01')], { generation: 'g2', eventSeq: 0 }))
    runAnimationFrames()
    expect(titles()).toEqual(['from g2', 'b1'])
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

describe('runs index sync: write bound', () => {
  it('a single patch after a quiet period lands in the next animation frame', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const writes = indexWrites()
    runFrame('a', summary('a2', '2026-01-02', { title: 'one' }))
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_WRITE_INTERVAL_MS * 4)
    runFrame('a', summary('a2', '2026-01-02', { title: 'two' }))
    runAnimationFrames()
    expect(titles()?.[0]).toBe('two')
    expect(writes()).toHaveLength(2)
  })

  it('a burst gives writes at least the interval apart, and the last patch still lands', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const writes = indexWrites()
    for (let i = 0; i < 40; i++) {
      runFrame('a', summary('a2', '2026-01-02', { title: `burst ${i}` }))
      runAnimationFrames()
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_WRITE_INTERVAL_MS)
    expect(titles()?.[0]).toBe('burst 39')
    expect(writes().length).toBeLessThanOrEqual(Math.ceil((40 * 20) / RUNS_INDEX_WRITE_INTERVAL_MS) + 1)
    expect(minGap(writes())).toBeGreaterThanOrEqual(RUNS_INDEX_WRITE_INTERVAL_MS)
  })

  it('frames inside the interval cannot postpone the held write', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const writes = indexWrites()
    runFrame('a', summary('a2', '2026-01-02', { title: 'first' }))
    runAnimationFrames()
    for (let i = 0; i < 10; i++) {
      runFrame('a', summary('a2', '2026-01-02', { title: `held ${i}` }))
      await vi.advanceTimersByTimeAsync(20)
    }
    // 200 ms passed with a frame every 20 ms; the held write fires at 250 ms regardless.
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_WRITE_INTERVAL_MS - 200)
    expect(writes()).toHaveLength(2)
    expect(titles()?.[0]).toBe('held 9')
  })

  it('a hidden document with no animation frames still writes, through the fallback and the held timer', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    runFrame('a', summary('a2', '2026-01-02', { title: 'hidden one' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(titles()?.[0]).toBe('hidden one')
    runFrame('a', summary('a2', '2026-01-02', { title: 'hidden two' }))
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_WRITE_INTERVAL_MS)
    expect(titles()?.[0]).toBe('hidden two')
  })

  it('usage ticks share the bound', async () => {
    client.setQueryData(RUNS_INDEX_QUERY_KEY, SEED())
    const writes = indexWrites()
    for (let i = 1; i <= 20; i++) {
      sync.usage('a', { a2: { cpuPct: i, rssBytes: 10, procCount: 1 } })
      runAnimationFrames()
      await vi.advanceTimersByTimeAsync(25)
    }
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_WRITE_INTERVAL_MS)
    expect(cached()?.runs[0]?.usage?.cpuPct).toBe(20)
    expect(minGap(writes())).toBeGreaterThanOrEqual(RUNS_INDEX_WRITE_INTERVAL_MS)
  })
})

describe('runs index sync: generation mismatch (R1)', () => {
  it('stream generation A, snapshots keep arriving from B, no stream ready: at most one extra read', async () => {
    sync.ready('A', 0)
    client.setQueryData(RUNS_INDEX_QUERY_KEY, snapshot(SEED().runs, { generation: 'A', eventSeq: 0 }))
    const { queryFn, unsubscribe } = observe(() => snapshot(SEED().runs, { generation: 'B', eventSeq: 7 }))
    await sync.reconcile()
    await vi.advanceTimersByTimeAsync(RUNS_INDEX_RECONCILE_HOLD_MS * 10)
    expect(queryFn).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})

describe('runs index sync: sustained updates', () => {
  it('events every 200 ms for 5 s stay visible within the write bound, and a boundary read still fires', async () => {
    // A snapshot includes every frame up to its eventSeq, as the server's does.
    let latest = 0
    const answer = () => snapshot([row('a', 'a2', '2026-01-02', { title: `tick ${latest}`, tokensUsed: latest }), row('a', 'a1', '2026-01-01', { archived: latest < 5 })], { truncated: ['a'], eventSeq: seq })
    client.setQueryData(RUNS_INDEX_QUERY_KEY, answer())
    const { queryFn, unsubscribe } = observe(answer)
    const writes = indexWrites()
    const emitted: Array<[number, number]> = []
    const shownTick = () => cached()?.runs.find((entry) => entry.id === 'a2')?.tokensUsed ?? 0
    let firstRead: number | undefined
    for (let step = 0; step < 100; step++) {
      const now = Date.now()
      if (step % 4 === 0) {
        const tick = step / 4 + 1
        runFrame('a', summary('a2', '2026-01-02', { title: `tick ${tick}`, tokensUsed: tick }))
        latest = tick
        emitted.push([now, tick])
        // A boundary move in the middle of the stream.
        if (tick === 5) runFrame('a', summary('a1', '2026-01-01'))
      }
      runAnimationFrames()
      // Nothing waits for the stream to go quiet: a tick older than one write interval plus one
      // step is on screen.
      const due = emitted.filter(([at]) => now - at >= RUNS_INDEX_WRITE_INTERVAL_MS + 50).at(-1)?.[1] ?? 0
      expect(shownTick()).toBeGreaterThanOrEqual(due)
      await vi.advanceTimersByTimeAsync(50)
      if (firstRead === undefined && queryFn.mock.calls.length > 0) firstRead = step
    }
    expect(minGap(writes())).toBeGreaterThanOrEqual(RUNS_INDEX_WRITE_INTERVAL_MS)
    // The boundary move (step 16) is written within one write interval; the reconciliation hold
    // then fires 400 ms later, under sustained events.
    expect(firstRead).toBeLessThanOrEqual(16 + (RUNS_INDEX_WRITE_INTERVAL_MS + RUNS_INDEX_RECONCILE_HOLD_MS) / 50 + 1)
    expect(queryFn.mock.calls.length).toBeLessThanOrEqual(2)
    unsubscribe()
  })
})
