import { describe, expect, it } from 'vitest'
import { RUN_STATUS } from './test-factories.testkit.ts'
import { toRunSummary, type RunRecord } from './runs.ts'
import {
  workspaceEventsQuerySchema,
  workspaceReadyEventSchema,
  workspaceRunDeletedEventSchema,
  workspaceRunSummaryEventSchema,
  workspaceUsageEventSchema,
  runsIndexResponseSchema,
} from './workspace-events.ts'

const record = {
  id: 'r1', title: 'Fix it', workflow: 'quick-task', task: 'the whole prompt', status: RUN_STATUS.running,
  createdAt: '2026-11-06T10:00:00.000Z', tokensUsed: 3, archived: false, steps: [],
} as RunRecord

describe('workspace summary events (hearsay-tools/cezarion#2730)', () => {
  it('accepts only the summary mode, and no mode at all', () => {
    expect(workspaceEventsQuerySchema.parse({})).toEqual({})
    expect(workspaceEventsQuerySchema.parse({ runs: 'summary' })).toEqual({ runs: 'summary' })
    expect(workspaceEventsQuerySchema.safeParse({ runs: 'full' }).success).toBe(false)
  })

  it('carries the list row, never the full record', () => {
    const frame = { project: 'shop', seq: 1, run: toRunSummary(record), relationships: 'digest' }
    expect(workspaceRunSummaryEventSchema.parse(frame)).toEqual(frame)
    const parsed = workspaceRunSummaryEventSchema.parse({ ...frame, run: { ...record, ...toRunSummary(record), usage: { cpuPct: 1, rssBytes: 2, procCount: 3 } } })
    expect(parsed.run).not.toHaveProperty('task')
    expect(parsed.run).not.toHaveProperty('steps')
    expect(parsed.run.usage).toEqual({ cpuPct: 1, rssBytes: 2, procCount: 3 })
  })

  it.each([
    ['no project', { seq: 1, run: toRunSummary(record), relationships: 'd' }],
    ['an empty project', { project: '', seq: 1, run: toRunSummary(record), relationships: 'd' }],
    ['no seq', { project: 'shop', run: toRunSummary(record), relationships: 'd' }],
    ['seq 0', { project: 'shop', seq: 0, run: toRunSummary(record), relationships: 'd' }],
    ['a fractional seq', { project: 'shop', seq: 1.5, run: toRunSummary(record), relationships: 'd' }],
    ['no digest', { project: 'shop', seq: 1, run: toRunSummary(record) }],
    ['a row without its id', { project: 'shop', seq: 1, run: { ...toRunSummary(record), id: undefined }, relationships: 'd' }],
  ])('refuses a run-summary with %s', (_, frame) => {
    expect(workspaceRunSummaryEventSchema.safeParse(frame).success).toBe(false)
  })

  it('numbers deletions and stamps their project', () => {
    expect(workspaceRunDeletedEventSchema.parse({ project: 'shop', seq: 2, id: 'r1' })).toEqual({ project: 'shop', seq: 2, id: 'r1' })
    // The legacy stream's deletion has no seq: the summary reader refuses it instead of guessing.
    expect(workspaceRunDeletedEventSchema.safeParse({ id: 'r1', project: 'shop' }).success).toBe(false)
  })

  it('starts a connection at any seq, including 0 before the first frame', () => {
    expect(workspaceReadyEventSchema.parse({ generation: 'g', seq: 0 })).toEqual({ generation: 'g', seq: 0 })
    expect(workspaceReadyEventSchema.safeParse({ generation: 'g' }).success).toBe(false)
  })

  it('accepts the empty usage that clears a stopped project', () => {
    expect(workspaceUsageEventSchema.parse({ project: 'shop', usage: {} })).toEqual({ project: 'shop', usage: {} })
  })

  it('requires the index to say which generation and frame it includes', () => {
    const body = { runs: [], referenceStatuses: {}, perProjectLimit: 200, truncated: [] }
    expect(runsIndexResponseSchema.safeParse(body).success).toBe(false)
    expect(runsIndexResponseSchema.parse({ ...body, generation: 'g', eventSeq: 0 })).toEqual({ ...body, generation: 'g', eventSeq: 0 })
  })
})
