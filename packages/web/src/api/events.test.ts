import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import {
  applyRunDeleted,
  applyRunSummary,
  createUsageStore,
  createWorkspaceSeqFence,
  parseGlobalEvent,
  parseWorkspaceEvent,
  type GlobalEvent,
  type WorkspaceEvent,
} from './events'
import { toRunSummary, type ApiRun, type RunRecord, type RunSummary } from '@open-mercato/cezar-api-client/contract/runs'

function run(id: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: id,
    workflow: 'quick-task',
    task: 'do it',
    status: RUN_STATUS.running,
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** A list row, as `GET /run-summaries` answers it (#817). */
function summary(id: string, over: Partial<RunRecord> = {}): RunSummary {
  return toRunSummary(run(id, over))
}

const SAMPLE = { cpuPct: 12, rssBytes: 1024, procCount: 3 }

describe('parseGlobalEvent', () => {
  const cases: Array<[string, string, GlobalEvent | null]> = [
    ['ping', '', { type: 'ping' }],
    // The server sends `event: ping` with an empty data line — parsing it as JSON would throw.
    ['ping', 'anything', { type: 'ping' }],
    ['run', JSON.stringify(run('r1')), { type: 'run', run: run('r1') }],
    ['run-deleted', '{"id":"r1"}', { type: 'run-deleted', id: 'r1' }],
    ['todos', '[]', null],
    ['usage', JSON.stringify({ r1: SAMPLE }), { type: 'usage', usage: { r1: SAMPLE } }],
    ['usage', '{}', { type: 'usage', usage: {} }],
    // Garbage costs one frame, never the stream.
    ['run', 'not json', null],
    ['run', '{"title":"no id"}', null],
    ['run', 'null', null],
    ['run-deleted', '{}', null],
    ['run-deleted', '{"id":""}', null],
    ['todos', '{"not":"an array"}', null],
    ['usage', '[]', null],
    ['usage', 'null', null],
    // A name this client does not know (the server may grow events first).
    ['permission', '{"id":"x"}', null],
  ]

  it.each(cases)('%s + %j → %j', (name, data, expected) => {
    expect(parseGlobalEvent(name, data)).toEqual(expected)
  })
})

describe('parseWorkspaceEvent', () => {
  // The summary-mode workspace stream (hearsay-tools/cezarion#2730): every payload is validated
  // against the contract and unwrapped to a typed event plus its owner.
  const frame = (over: Record<string, unknown> = {}) => JSON.stringify({ project: 'a', seq: 4, run: summary('r1'), relationships: 'd1', ...over })
  const cases: Array<[string, string, { project: string | null; event: WorkspaceEvent } | null]> = [
    ['ping', '', { project: null, event: { type: 'ping' } }],
    ['run-summary', frame(), { project: 'a', event: { type: 'run-summary', summary: summary('r1'), seq: 4, relationships: 'd1' } }],
    ['run-deleted', '{"project":"a","seq":5,"id":"r1"}', { project: 'a', event: { type: 'run-deleted', id: 'r1', seq: 5 } }],
    ['ready', '{"generation":"g","seq":0}', { project: null, event: { type: 'ready', generation: 'g', seq: 0 } }],
    [
      'usage',
      JSON.stringify({ project: 'a', usage: { r1: SAMPLE } }),
      { project: 'a', event: { type: 'usage', usage: { r1: SAMPLE } } },
    ],
    // The empty tick that clears a project whose last live row stopped.
    ['usage', '{"project":"a","usage":{}}', { project: 'a', event: { type: 'usage', usage: {} } }],
    // A full record is not a summary-mode frame: the cockpit never reads the legacy shape.
    ['run', JSON.stringify({ ...run('r1'), project: 'a' }), null],
    // No stamp, no owner, no way to route it — dropped whole rather than guessed at.
    ['run-summary', frame({ project: undefined }), null],
    ['run-summary', frame({ project: '' }), null],
    ['run-deleted', '{"id":"r1","project":"a"}', null],
    ['usage', JSON.stringify({ r1: SAMPLE }), null],
    // Whatever the contract refuses costs one frame.
    ['run-summary', 'not json', null],
    ['run-summary', frame({ seq: 0 }), null],
    ['run-summary', frame({ relationships: undefined }), null],
    ['run-summary', frame({ run: { id: 'r1' } }), null],
    ['run-deleted', '{"project":"a","seq":5,"id":""}', null],
    ['ready', '{"generation":"g"}', null],
    ['usage', '{"project":"a","usage":[]}', null],
    ['project-added', '{"project":"a"}', null],
  ]

  it.each(cases)('%s + %j → %j', (name, data, expected) => {
    expect(parseWorkspaceEvent(name, data)).toEqual(expected)
  })

  it('keeps no field the row schema does not name', () => {
    const parsed = parseWorkspaceEvent('run-summary', frame({ run: { ...run('r1'), ...summary('r1') } }))
    expect(parsed?.event.type === 'run-summary' && parsed.event.summary).not.toHaveProperty('task')
  })
})

describe('createWorkspaceSeqFence', () => {
  it('accepts contiguous frames after ready and flags a jump once', () => {
    const fence = createWorkspaceSeqFence()
    fence.ready(7)
    expect([8, 9].map(fence.frame)).toEqual([false, false])
    expect(fence.frame(12)).toBe(true)
    expect(fence.frame(13)).toBe(false)
  })

  it('takes the first frame as the baseline when it saw no ready', () => {
    const fence = createWorkspaceSeqFence()
    expect([41, 42].map(fence.frame)).toEqual([false, false])
  })

  it('treats a new generation as a reset, not a gap', () => {
    const fence = createWorkspaceSeqFence()
    fence.ready(5)
    fence.frame(6)
    // The server restarted: its numbers start again.
    fence.ready(0)
    expect(fence.frame(1)).toBe(false)
  })

  it('takes a new baseline after a reopened connection', () => {
    const fence = createWorkspaceSeqFence()
    fence.ready(1)
    fence.frame(2)
    fence.reset()
    expect(fence.frame(30)).toBe(false)
  })

  it('flags a repeated or older number', () => {
    const fence = createWorkspaceSeqFence()
    fence.ready(3)
    fence.frame(4)
    expect(fence.frame(4)).toBe(true)
  })
})

describe('applyRunSummary', () => {
  it('leaves an unfetched list alone rather than inventing one', () => {
    // A one-run "list" assembled from whichever event happened to arrive is not the run list.
    // `undefined` is what setQueryData reads as "don't touch it".
    expect(applyRunSummary(undefined, summary('r1'))).toBeUndefined()
  })

  it('upserts a run the list has never seen', () => {
    expect(applyRunSummary([], summary('r1'))).toEqual([summary('r1')])
  })

  it('carries a streamed automation task\'s origin, so the sidebar files it under Automations (#1332)', () => {
    const next = applyRunSummary([summary('manual')], summary('nightly', {
      automationTrigger: { automationId: 'auto-1', automationRevision: 1, receiptId: 'r', trigger: 'schedule', occurrenceAt: '2026-07-14T09:00:00.000Z' },
    }))
    expect(next?.find((row) => row.id === 'nightly')).toHaveProperty('automationId', 'auto-1')
    expect(next?.find((row) => row.id === 'manual')).not.toHaveProperty('automationId')
  })

  it('takes the frame\'s live usage, and drops a sample the frame no longer carries', () => {
    const live = applyRunSummary([summary('r1')], { ...summary('r1'), usage: SAMPLE })
    expect(live?.[0]?.usage).toEqual(SAMPLE)
    const stopped = applyRunSummary(live, summary('r1', { status: RUN_STATUS.review }))
    expect(stopped?.[0]?.usage).toBeUndefined()
    expect(stopped?.[0]?.status).toBe('review')
  })

  it('updates title, status, references, tokens and archive in place — one run stays one row', () => {
    const list: RunSummary[] = [summary('r1', { status: RUN_STATUS.queued }), summary('r2')]
    const next = applyRunSummary(list, summary('r1', {
      status: RUN_STATUS.done, tokensUsed: 99, titleSummary: 'Renamed', prNumber: 12, issueNumber: 7, archived: true,
    }))

    expect(next).toHaveLength(2)
    expect(next?.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(next?.[0]).toMatchObject({ status: RUN_STATUS.done, tokensUsed: 99, titleSummary: 'Renamed', prNumber: 12, issueNumber: 7, archived: true })
  })

  it('does not duplicate a row however many events one run emits', () => {
    let list: RunSummary[] | undefined = []
    for (const status of ['queued', 'running', 'review', 'done'] as const) {
      list = applyRunSummary(list, summary('r1', { status }))
    }
    expect(list).toHaveLength(1)
    expect(list?.[0]?.status).toBe('done')
  })

  it('inserts a new run by createdAt descending, matching the server order', () => {
    const list: RunSummary[] = [
      summary('newest', { createdAt: '2026-07-14T12:00:00.000Z' }),
      summary('oldest', { createdAt: '2026-07-14T08:00:00.000Z' }),
    ]

    const middle = applyRunSummary(list, summary('middle', { createdAt: '2026-07-14T10:00:00.000Z' }))
    expect(middle?.map((r) => r.id)).toEqual(['newest', 'middle', 'oldest'])

    // A run started right now — the common case — goes to the top.
    const top = applyRunSummary(list, summary('now', { createdAt: '2026-07-14T13:00:00.000Z' }))
    expect(top?.map((r) => r.id)).toEqual(['now', 'newest', 'oldest'])

    // And one older than everything goes to the bottom rather than off the end.
    const bottom = applyRunSummary(list, summary('ancient', { createdAt: '2020-01-01T00:00:00.000Z' }))
    expect(bottom?.map((r) => r.id)).toEqual(['newest', 'oldest', 'ancient'])
  })

  it('never mutates the list it was given', () => {
    const list: RunSummary[] = [summary('r1', { status: RUN_STATUS.queued })]
    const frozen = Object.freeze([...list])
    applyRunSummary(frozen as RunSummary[], summary('r1', { status: RUN_STATUS.done }))
    applyRunSummary(frozen as RunSummary[], summary('r2'))
    expect(list[0]?.status).toBe('queued')
    expect(frozen).toHaveLength(1)
  })
})

describe('applyRunDeleted', () => {
  it('removes the run', () => {
    const next = applyRunDeleted([run('r1'), run('r2')], 'r1')
    expect(next?.map((r) => r.id)).toEqual(['r2'])
  })

  it('returns the same list for an id it never held — no re-render for someone else\'s news', () => {
    const list: ApiRun[] = [run('r1')]
    expect(applyRunDeleted(list, 'nope')).toBe(list)
  })

  it('leaves an unfetched list alone', () => {
    expect(applyRunDeleted(undefined, 'r1')).toBeUndefined()
  })
})

describe('createUsageStore', () => {
  it('starts empty and hands back a stable snapshot', () => {
    const store = createUsageStore()
    expect(store.get()).toEqual({})
    // Stable identity between reads, or useSyncExternalStore re-renders forever.
    expect(store.get()).toBe(store.get())
  })

  it('replaces the map on each tick and notifies subscribers', () => {
    const store = createUsageStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.set({ r1: SAMPLE })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get()).toEqual({ r1: SAMPLE })

    // A finished run drops out of the tick, and must stop reporting rather than keep its last
    // number — which is why a tick replaces instead of merging.
    store.set({ r2: SAMPLE })
    expect(store.get()).toEqual({ r2: SAMPLE })
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.set({ r3: SAMPLE })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.get()).toEqual({ r3: SAMPLE })
  })
})
