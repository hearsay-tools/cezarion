// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import { voiceRun } from './fixture.testkit'
import { resolveOpenTarget } from './resolve-open'

const failed = (over: Partial<RunRecord> = {}) => voiceRun({ status: 'failed', ...over })

describe('resolveOpenTarget', () => {
  it('next from inside the list', () => {
    // Newest first inside a rank: c, b, a.
    const a = failed({ id: 'a', createdAt: '2026-07-14T10:00:00.000Z' })
    const b = failed({ id: 'b', createdAt: '2026-07-14T11:00:00.000Z' })
    const c = failed({ id: 'c', createdAt: '2026-07-14T12:00:00.000Z' })
    const args = { runs: [a, b, c], sidebarView: 'active' as const, status: 'failed' as const }
    expect(resolveOpenTarget({ ...args, openRunId: 'c', position: 'next' })).toEqual({ kind: 'run', runId: 'b' })
    expect(resolveOpenTarget({ ...args, openRunId: 'b', position: 'previous' })).toEqual({ kind: 'run', runId: 'c' })
  })

  it('next when the open task is not in the list is the first', () => {
    const a = failed({ id: 'a' })
    const other = voiceRun({ id: 'other', status: 'running' })
    const args = { runs: [a, other], sidebarView: 'active' as const, status: 'failed' as const }
    expect(resolveOpenTarget({ ...args, openRunId: 'other', position: 'next' })).toEqual({ kind: 'run', runId: 'a' })
    expect(resolveOpenTarget({ ...args, openRunId: null, position: 'next' })).toEqual({ kind: 'run', runId: 'a' })
    expect(resolveOpenTarget({ ...args, openRunId: 'other', position: 'previous' })).toEqual({ kind: 'run', runId: 'a' })
  })

  it('previous without a current row is the last', () => {
    const a = failed({ id: 'a', createdAt: '2026-07-14T10:00:00.000Z' })
    const b = failed({ id: 'b', createdAt: '2026-07-14T11:00:00.000Z' })
    const args = { runs: [a, b], sidebarView: 'active' as const, status: 'failed' as const, openRunId: null }
    expect(resolveOpenTarget({ ...args, position: 'previous' })).toEqual({ kind: 'run', runId: 'a' })
  })

  it('next after the last is past-end, previous before the first is past-end', () => {
    const a = failed({ id: 'a', createdAt: '2026-07-14T10:00:00.000Z' })
    const b = failed({ id: 'b', createdAt: '2026-07-14T11:00:00.000Z' })
    const args = { runs: [a, b], sidebarView: 'active' as const, status: 'failed' as const }
    expect(resolveOpenTarget({ ...args, openRunId: 'a', position: 'next' })).toEqual({ kind: 'past-end' })
    expect(resolveOpenTarget({ ...args, openRunId: 'b', position: 'previous' })).toEqual({ kind: 'past-end' })
  })

  it('the third', () => {
    const runs = ['a', 'b', 'c', 'd'].map((id, i) => failed({ id, createdAt: `2026-07-14T1${i}:00:00.000Z` }))
    // Sidebar order is d, c, b, a.
    const args = { runs, sidebarView: 'active' as const, status: 'failed' as const, openRunId: null }
    expect(resolveOpenTarget({ ...args, position: 3 })).toEqual({ kind: 'run', runId: 'b' })
    expect(resolveOpenTarget({ ...args, position: 5 })).toEqual({ kind: 'past-end' })
    expect(resolveOpenTarget({ ...args, position: 'last' })).toEqual({ kind: 'run', runId: 'a' })
  })

  it('last reaches rows the sidebar cap hides', () => {
    const runs = Array.from({ length: 12 }, (_, i) =>
      voiceRun({ id: `f${i + 1}`, status: 'done', createdAt: `2026-07-14T${String(20 - i).padStart(2, '0')}:00:00.000Z` }),
    )
    // f1 is the newest, f12 the oldest and the last row; the sidebar's cap of ten hides it.
    expect(
      resolveOpenTarget({ runs, sidebarView: 'active', openRunId: null, status: 'finished', position: 'last' }),
    ).toEqual({ kind: 'run', runId: 'f12' })
    expect(
      resolveOpenTarget({ runs, sidebarView: 'active', openRunId: null, status: 'finished', position: 12 }),
    ).toEqual({ kind: 'run', runId: 'f12' })
  })

  it('owned workers are skipped and a worker counts from its parent', () => {
    const parent = failed({ id: 'parent', createdAt: '2026-07-14T12:00:00.000Z' })
    const worker = failed({
      id: 'worker',
      createdAt: '2026-07-14T11:30:00.000Z',
      delegation: { role: 'worker', parentRunId: 'parent', permissions: [], receipts: [] },
    } as unknown as Partial<RunRecord>)
    const next = failed({ id: 'next', createdAt: '2026-07-14T11:00:00.000Z' })
    const args = { runs: [parent, worker, next], sidebarView: 'active' as const, status: 'failed' as const }
    expect(resolveOpenTarget({ ...args, openRunId: 'worker', position: 'next' })).toEqual({ kind: 'run', runId: 'next' })
    expect(resolveOpenTarget({ ...args, openRunId: null, position: 'last' })).toEqual({ kind: 'run', runId: 'next' })
    expect(resolveOpenTarget({ ...args, openRunId: 'parent', position: 2 })).toEqual({ kind: 'run', runId: 'next' })
  })

  it('a historical variant run opens as its own task (hearsay-tools/cezarion#1760)', () => {
    const a = failed({ id: 'ga', groupId: 'g1', variant: 'A', createdAt: '2026-07-14T12:00:00.000Z' })
    const b = voiceRun({ id: 'gb', groupId: 'g1', variant: 'B', status: 'done', createdAt: '2026-07-14T12:01:00.000Z' })
    const solo = failed({ id: 'solo', createdAt: '2026-07-14T09:00:00.000Z' })
    const args = { runs: [a, b, solo], sidebarView: 'active' as const, status: 'failed' as const, openRunId: null }
    expect(resolveOpenTarget({ ...args, position: 'next' })).toEqual({ kind: 'run', runId: 'ga' })
    // A done sibling neither matches `failed` nor stands in for the failed run.
    expect(resolveOpenTarget({ ...args, openRunId: 'ga', position: 'next' })).toEqual({ kind: 'run', runId: 'solo' })
    expect(resolveOpenTarget({ ...args, openRunId: 'gb', position: 'next' })).toEqual({ kind: 'run', runId: 'ga' })
  })

  it('archived walks the archived order', () => {
    const a = voiceRun({ id: 'a', archived: true, createdAt: '2026-07-14T10:00:00.000Z' })
    const b = voiceRun({ id: 'b', archived: true, createdAt: '2026-07-14T11:00:00.000Z' })
    const live = voiceRun({ id: 'live', status: 'done' })
    const args = { runs: [a, b, live], sidebarView: 'active' as const, status: 'archived' as const }
    expect(resolveOpenTarget({ ...args, openRunId: null, position: 'next' })).toEqual({ kind: 'run', runId: 'b' })
    expect(resolveOpenTarget({ ...args, openRunId: 'b', position: 'next' })).toEqual({ kind: 'run', runId: 'a' })
    expect(resolveOpenTarget({ ...args, openRunId: 'a', position: 'next' })).toEqual({ kind: 'past-end' })
  })

  it('archived stops at the archived window', () => {
    const runs = Array.from({ length: 205 }, (_, i) =>
      voiceRun({ id: `x${i}`, archived: true, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1000 - i)).toISOString() }),
    )
    const args = { runs, sidebarView: 'active' as const, openRunId: null, status: 'archived' as const }
    expect(resolveOpenTarget({ ...args, position: 'last' })).toEqual({ kind: 'run', runId: 'x199' })
    expect(resolveOpenTarget({ ...args, openRunId: 'x199', position: 'next' })).toEqual({ kind: 'past-end' })
  })

  it('automations tab walks only automation tasks', () => {
    const auto = failed({ id: 'auto', automationId: 'au1' } as Partial<RunRecord>)
    const manual = failed({ id: 'manual' })
    const args = { runs: [auto, manual], sidebarView: 'automations' as const, openRunId: null, status: 'failed' as const }
    expect(resolveOpenTarget({ ...args, position: 'next' })).toEqual({ kind: 'run', runId: 'auto' })
    expect(resolveOpenTarget({ ...args, position: 'last' })).toEqual({ kind: 'run', runId: 'auto' })
    expect(resolveOpenTarget({ ...args, sidebarView: 'active', position: 'last' })).toEqual({ kind: 'run', runId: 'manual' })
  })

  it('no rows is empty', () => {
    const args = { runs: [voiceRun({ status: 'done' })], sidebarView: 'active' as const, openRunId: null }
    expect(resolveOpenTarget({ ...args, status: 'failed', position: 'next' })).toEqual({ kind: 'empty' })
    expect(resolveOpenTarget({ ...args, status: 'archived', position: 'last' })).toEqual({ kind: 'empty' })
    expect(resolveOpenTarget({ runs: [], sidebarView: 'active', openRunId: null, status: 'unread', position: 1 })).toEqual({
      kind: 'empty',
    })
  })
})
