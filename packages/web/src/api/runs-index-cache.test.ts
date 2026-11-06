import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { describe, expect, it } from 'vitest'
import type { RunIndexEntry, RunsIndexResponse, RunSummary } from '@open-mercato/cezar-api-client'

import {
  applyIndexChange,
  applyIndexUsage,
  createIndexOverlay,
  dropIndexProject,
  mergeIndexSnapshot,
  overlayDropProject,
  overlayReady,
  overlayRecord,
  type IndexChange,
} from './runs-index-cache'

const SAMPLE = { cpuPct: 12, rssBytes: 1024, procCount: 3 }

function summary(id: string, createdAt: string, over: Partial<RunSummary> = {}): RunSummary {
  return { id, title: id, status: RUN_STATUS.running, createdAt, archived: false, workflow: 'quick-task', workflowLabel: 'Quick task', tokensUsed: 0, ...over } as RunSummary
}

function row(projectId: string, id: string, createdAt: string, over: Partial<RunSummary> = {}): RunIndexEntry {
  return { projectId, ...summary(id, createdAt, over) }
}

function index(runs: RunIndexEntry[], over: Partial<RunsIndexResponse> = {}): RunsIndexResponse {
  return { runs, referenceStatuses: {}, perProjectLimit: 2, truncated: [], generation: 'g1', eventSeq: 10, ...over }
}

function runChange(project: string, run: RunSummary, seq = 11): IndexChange {
  return { type: 'run', project, seq, run }
}

function deleted(project: string, id: string, seq = 11): IndexChange {
  return { type: 'deleted', project, seq, id }
}

const ids = (value: RunsIndexResponse) => value.runs.map((entry) => `${entry.projectId}/${entry.id}`)

/** Project `a`: two unarchived roots and two archived roots (the window is 2 archived). */
function projectA(over: Partial<RunsIndexResponse> = {}): RunsIndexResponse {
  return index([
    row('a', 'a4', '2026-01-04'),
    row('b', 'b3', '2026-01-03'),
    row('a', 'a2', '2026-01-02', { archived: true }),
    row('a', 'a1', '2026-01-01', { archived: true }),
  ], over)
}

describe('applyIndexChange: the S1 and S5 case table', () => {
  it('create root: inserts the row at its createdAt position with no reconciliation', () => {
    const result = applyIndexChange(projectA(), runChange('b', summary('b5', '2026-01-05')))
    expect(ids(result.index)).toEqual(['b/b5', 'a/a4', 'b/b3', 'a/a2', 'a/a1'])
    expect(result.index.runs[0]).toEqual(row('b', 'b5', '2026-01-05'))
    expect(result.reconcile).toBe(false)
    const middle = applyIndexChange(projectA(), runChange('a', summary('a3', '2026-01-03T12:00:00Z')))
    expect(ids(middle.index)).toEqual(['a/a4', 'a/a3', 'b/b3', 'a/a2', 'a/a1'])
  })

  it.each([
    ['title', { title: 'renamed' }],
    ['status', { status: RUN_STATUS.done }],
    ['tokens', { tokensUsed: 42 }],
  ] as const)('update (%s): replaces the row in place, keeping order', (_field, patch) => {
    const before = projectA()
    const result = applyIndexChange(before, runChange('a', summary('a4', '2026-01-04', patch)))
    expect(ids(result.index)).toEqual(ids(before))
    expect(result.index.runs[0]).toMatchObject(patch)
    // Other rows keep their objects, so their consumers do not re-render.
    expect(result.index.runs[1]).toBe(before.runs[1])
    expect(result.reconcile).toBe(false)
  })

  it('update with a deep-equal row keeps the same index object', () => {
    const before = projectA()
    expect(applyIndexChange(before, runChange('a', summary('a4', '2026-01-04'))).index).toBe(before)
  })

  it('keys rows by project and id: the same id in another project is another row', () => {
    const before = index([row('a', 'x', '2026-01-02'), row('b', 'x', '2026-01-01')])
    const result = applyIndexChange(before, runChange('b', summary('x', '2026-01-01', { title: 'b-side' })))
    expect(result.index.runs[0]).toBe(before.runs[0])
    expect(result.index.runs[1]?.title).toBe('b-side')
  })

  it('archive in a complete project: exact patch, no reconciliation', () => {
    const before = projectA({ perProjectLimit: 3 })
    const result = applyIndexChange(before, runChange('a', summary('a4', '2026-01-04', { archived: true })))
    expect(result.index.runs[0]?.archived).toBe(true)
    expect(result.reconcile).toBe(false)
  })

  it('archive that overflows a complete project\'s window: patch, then reconcile', () => {
    const result = applyIndexChange(projectA(), runChange('a', summary('a4', '2026-01-04', { archived: true })))
    expect(result.index.runs[0]?.archived).toBe(true)
    expect(result.reconcile).toBe(true)
  })

  it('archive in a truncated project moves the window boundary: patch, then reconcile', () => {
    const result = applyIndexChange(projectA({ truncated: ['a'] }), runChange('a', summary('a4', '2026-01-04', { archived: true })))
    expect(result.index.runs[0]?.archived).toBe(true)
    expect(result.reconcile).toBe(true)
  })

  it('unarchive in a complete project: exact patch', () => {
    const result = applyIndexChange(projectA(), runChange('a', summary('a2', '2026-01-02')))
    expect(result.index.runs[2]?.archived).toBe(false)
    expect(result.reconcile).toBe(false)
  })

  it('unarchive of a held row in a truncated project: patch, then reconcile (the next archived row enters)', () => {
    const result = applyIndexChange(projectA({ truncated: ['a'] }), runChange('a', summary('a2', '2026-01-02')))
    expect(result.index.runs[2]?.archived).toBe(false)
    expect(result.reconcile).toBe(true)
  })

  it('unarchive of a row past a truncated window: inserted exactly, the window is unchanged', () => {
    const result = applyIndexChange(projectA({ truncated: ['a'] }), runChange('a', summary('a0', '2025-12-31')))
    expect(ids(result.index)).toEqual(['a/a4', 'b/b3', 'a/a2', 'a/a1', 'a/a0'])
    expect(result.reconcile).toBe(false)
  })

  it('an archived row past a truncated window stays out', () => {
    const before = projectA({ truncated: ['a'] })
    const result = applyIndexChange(before, runChange('a', summary('a0', '2025-12-31', { archived: true, title: 'old' })))
    expect(result.index).toBe(before)
    expect(result.reconcile).toBe(false)
  })

  it('delete: removes the row', () => {
    const result = applyIndexChange(projectA(), deleted('b', 'b3'))
    expect(ids(result.index)).toEqual(['a/a4', 'a/a2', 'a/a1'])
    expect(result.reconcile).toBe(false)
  })

  it('delete of an archived row in a truncated project: removed, then reconcile', () => {
    const result = applyIndexChange(projectA({ truncated: ['a'] }), deleted('a', 'a1'))
    expect(ids(result.index)).toEqual(['a/a4', 'b/b3', 'a/a2'])
    expect(result.reconcile).toBe(true)
  })

  it('delete of a row the index does not hold: the same object back', () => {
    const before = projectA()
    expect(applyIndexChange(before, deleted('a', 'nope'))).toEqual({ index: before, reconcile: false })
  })

  it('parent-worker update: a worker row never enters', () => {
    const before = projectA()
    const worker = summary('w1', '2026-01-05', { delegation: { role: 'worker', parentRunId: 'a4' } as RunSummary['delegation'] })
    expect(applyIndexChange(before, runChange('a', worker))).toEqual({ index: before, reconcile: false })
  })

  it('a held row that turns into a worker leaves the index', () => {
    const worker = summary('a4', '2026-01-04', { delegation: { role: 'worker', parentRunId: 'b3' } as RunSummary['delegation'] })
    expect(ids(applyIndexChange(projectA(), runChange('a', worker)).index)).toEqual(['b/b3', 'a/a2', 'a/a1'])
  })

  it('unknown project: not applied, asks for a reconciliation', () => {
    const before = projectA()
    const registry = new Set(['a', 'b'])
    expect(applyIndexChange(before, runChange('c', summary('c1', '2026-01-09')), registry)).toEqual({ index: before, reconcile: true })
    // Without the registry, a project is known by its rows.
    expect(applyIndexChange(before, runChange('c', summary('c1', '2026-01-09'))).reconcile).toBe(true)
    // A registered project with no rows yet takes its first row exactly.
    const known = applyIndexChange(before, runChange('c', summary('c1', '2026-01-09')), new Set(['a', 'b', 'c']))
    expect(ids(known.index)[0]).toBe('c/c1')
    expect(known.reconcile).toBe(false)
  })

  it('never touches referenceStatuses, perProjectLimit, truncated or the fence fields', () => {
    const referenceStatuses = { a: { prs: { 7: 'open' }, issues: {} } } as unknown as RunsIndexResponse['referenceStatuses']
    const before = projectA({ referenceStatuses, truncated: ['a'] })
    const result = applyIndexChange(before, runChange('a', summary('a4', '2026-01-04', { prNumber: 9 })))
    expect(result.index.referenceStatuses).toBe(referenceStatuses)
    expect(result.index.truncated).toBe(before.truncated)
    expect(result.index.perProjectLimit).toBe(2)
    expect([result.index.generation, result.index.eventSeq]).toEqual(['g1', 10])
  })
})

describe('applyIndexUsage', () => {
  it('replaces usage on that project\'s rows only', () => {
    const before = index([row('a', 'a1', '2026-01-02'), row('b', 'b1', '2026-01-01', { usage: SAMPLE })])
    const after = applyIndexUsage(before, 'a', { a1: SAMPLE })
    expect(after.runs[0]?.usage).toEqual(SAMPLE)
    expect(after.runs[1]).toBe(before.runs[1])
  })

  it('an empty tick clears the project\'s samples', () => {
    const before = index([row('a', 'a1', '2026-01-02', { usage: SAMPLE }), row('b', 'b1', '2026-01-01', { usage: SAMPLE })])
    const after = applyIndexUsage(before, 'a', {})
    expect(after.runs[0]).not.toHaveProperty('usage')
    expect(after.runs[1]?.usage).toEqual(SAMPLE)
  })

  it('a tick with the same samples keeps the same index object', () => {
    const before = index([row('a', 'a1', '2026-01-02', { usage: SAMPLE }), row('a', 'a0', '2026-01-01')])
    expect(applyIndexUsage(before, 'a', { a1: { ...SAMPLE } })).toBe(before)
  })
})

describe('dropIndexProject', () => {
  it('drops the project\'s rows, its truncated entry and its reference statuses', () => {
    const referenceStatuses = { a: { prs: {}, issues: { 3: 'open' } }, b: { prs: {}, issues: {} } } as unknown as RunsIndexResponse['referenceStatuses']
    const after = dropIndexProject(projectA({ truncated: ['a', 'b'], referenceStatuses }), 'a')
    expect(ids(after)).toEqual(['b/b3'])
    expect(after.truncated).toEqual(['b'])
    expect(Object.keys(after.referenceStatuses)).toEqual(['b'])
  })

  it('a project the index does not hold: the same object back', () => {
    const before = projectA()
    expect(dropIndexProject(before, 'zzz')).toBe(before)
  })
})

describe('mergeIndexSnapshot: the fence', () => {
  it('a frame above eventSeq wins over a late snapshot', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04', { title: 'newer' }), 12))
    const result = mergeIndexSnapshot(overlay, projectA({ eventSeq: 11 }))
    expect(result.index.runs[0]?.title).toBe('newer')
    expect(result.reconcile).toBe(false)
    expect(overlay.changes.size).toBe(1)
  })

  it('frames at or below eventSeq are in the snapshot and leave the overlay', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04', { title: 'older' }), 11))
    overlayRecord(overlay, runChange('b', summary('b3', '2026-01-03', { title: 'at' }), 12))
    const snapshot = projectA({ eventSeq: 12 })
    const result = mergeIndexSnapshot(overlay, snapshot)
    expect(result.index).toBe(snapshot)
    expect(overlay.changes.size).toBe(0)
    expect(overlay.floor).toBe(12)
  })

  it('a tombstone above eventSeq removes the row the snapshot still has', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, deleted('b', 'b3', 11))
    expect(ids(mergeIndexSnapshot(overlay, projectA({ eventSeq: 10 })).index)).toEqual(['a/a4', 'a/a2', 'a/a1'])
  })

  it('applies newer frames in seq order, keeping the newest per row', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, runChange('a', summary('a9', '2026-01-09'), 11))
    overlayRecord(overlay, deleted('a', 'a9', 12))
    overlayRecord(overlay, runChange('a', summary('a9', '2026-01-09', { title: 'stale' }), 11))
    expect(ids(mergeIndexSnapshot(overlay, projectA()).index)).not.toContain('a/a9')
  })

  it('a stream ready with a new generation resets the overlay', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04', { title: 'g1' }), 11))
    overlayReady(overlay, 'g2', 0)
    expect(overlay.changes.size).toBe(0)
    expect(overlay.floor).toBe(0)
  })

  it('a snapshot of another generation than the stream\'s stays unpatched and asks for a reconciliation', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g2', 0)
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04', { title: 'g2' }), 1))
    const stale = projectA({ generation: 'g1', eventSeq: 40 })
    const result = mergeIndexSnapshot(overlay, stale)
    expect(result).toEqual({ index: stale, reconcile: true })
    expect(overlay.changes.size).toBe(1)
  })

  it('without a stream generation, a snapshot of another generation resets the overlay', () => {
    const overlay = createIndexOverlay()
    // A document that joined the shared feed after its `ready`: the first snapshot names it.
    mergeIndexSnapshot(overlay, projectA({ generation: 'g1', eventSeq: 5 }))
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04', { title: 'g1' }), 6))
    const next = projectA({ generation: 'g2', eventSeq: 0 })
    expect(mergeIndexSnapshot(overlay, next)).toEqual({ index: next, reconcile: false })
    expect(overlay.changes.size).toBe(0)
    expect(overlay.generation).toBe('g2')
  })

  it('a snapshot older than the overlay\'s floor misses frames: one more reconciliation', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    mergeIndexSnapshot(overlay, projectA({ eventSeq: 20 }))
    // An older read that finished late cannot be completed from the overlay any more.
    expect(mergeIndexSnapshot(overlay, projectA({ eventSeq: 15 })).reconcile).toBe(true)
    // A current one can.
    expect(mergeIndexSnapshot(overlay, projectA({ eventSeq: 20 })).reconcile).toBe(false)
  })

  it('lost frames move the floor: a snapshot from before the gap asks for a reconciliation', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04'), 11))
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04', { title: 'after gap' }), 15), true)
    expect(overlay.floor).toBe(14)
    const result = mergeIndexSnapshot(overlay, projectA({ eventSeq: 12 }))
    expect(result.reconcile).toBe(true)
    expect(result.index.runs[0]?.title).toBe('after gap')
  })

  it('the first frame without a ready sets the baseline', () => {
    const overlay = createIndexOverlay()
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04'), 30))
    expect(overlay.floor).toBe(29)
  })

  it('a boundary move above eventSeq asks for a reconciliation', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, deleted('a', 'a1', 11))
    expect(mergeIndexSnapshot(overlay, projectA({ truncated: ['a'] })).reconcile).toBe(true)
  })

  it('a removed project\'s frames do not bring its rows back', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, runChange('c', summary('c1', '2026-01-09'), 11))
    overlayDropProject(overlay, 'c')
    expect(ids(mergeIndexSnapshot(overlay, projectA()).index)).not.toContain('c/c1')
  })

  it('reconciliation refreshes referenceStatuses and truncated from the snapshot', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, runChange('a', summary('a4', '2026-01-04', { title: 'patched' }), 11))
    const referenceStatuses = { a: { prs: { 4: 'merged' }, issues: {} } } as unknown as RunsIndexResponse['referenceStatuses']
    const merged = mergeIndexSnapshot(overlay, projectA({ referenceStatuses, truncated: ['a'] })).index
    expect(merged.referenceStatuses).toBe(referenceStatuses)
    expect(merged.truncated).toEqual(['a'])
    expect(merged.runs[0]?.title).toBe('patched')
  })

  it('a snapshot without fence fields passes unchanged', () => {
    const overlay = createIndexOverlay()
    overlayReady(overlay, 'g1', 10)
    overlayRecord(overlay, deleted('b', 'b3', 11))
    const { generation: _g, eventSeq: _s, ...rest } = projectA()
    const legacy = rest as RunsIndexResponse
    expect(mergeIndexSnapshot(overlay, legacy)).toEqual({ index: legacy, reconcile: false })
  })
})
