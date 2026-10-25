// @vitest-environment node

import { openHumanWait, summaryOf } from '@/test/run-summary-fixture'
import { timerWait } from '@/test/wait-fixtures'
import { describe, expect, it } from 'vitest'

import type { RunIndexEntry, RunRecord, RunSummary } from '@open-mercato/cezar-api-client'
import { groupRuns } from '@/lib/task-groups'
import {
  groupIndexedTasks,
  groupMembers,
  groupProjectRuns,
  groupTone,
  matchesOrigin,
  originAutomationFlag,
  originCounts,
  parseOrigin,
  type TaskStatusGroup,
} from '@/lib/task-origin'

let seq = 0

function run(over: Partial<RunRecord> & { automationId?: string } = {}): RunSummary {
  seq += 1
  return summaryOf({
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'done',
    createdAt: `2026-10-24T10:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  } as RunRecord)
}

const indexed = (projectId: string, summary: RunSummary): RunIndexEntry => ({ ...summary, projectId })
const task = (entry: RunIndexEntry) => ({ run: entry })

function shape<R>(groups: TaskStatusGroup<R>[], name: (row: R) => string): string[] {
  return groups.map((group) => `${group.label}: ${group.rows
    .map((row) => name(row.run))
    .join(', ')}`)
}

describe('origin filter', () => {
  it('reads only the two named origins from the URL', () => {
    expect(parseOrigin('direct')).toBe('direct')
    expect(parseOrigin('automations')).toBe('automations')
    expect(parseOrigin(null)).toBe('all')
    expect(parseOrigin('everything')).toBe('all')
  })

  it('classifies by recorded provenance, never by the autonomous flag', () => {
    const automated = run({ automationId: 'nightly' })
    const autonomous = run({ autonomous: true })
    expect(matchesOrigin(automated, 'automations')).toBe(true)
    expect(matchesOrigin(autonomous, 'automations')).toBe(false)
    expect(matchesOrigin(autonomous, 'direct')).toBe(true)
    expect(matchesOrigin(automated, 'all')).toBe(true)
  })

  it('maps the origin onto the bulk routes’ automation flag', () => {
    expect(originAutomationFlag('all')).toBeUndefined()
    expect(originAutomationFlag('direct')).toBe(false)
    expect(originAutomationFlag('automations')).toBe(true)
  })

  it('counts the archive view in front of the reader and skips owned workers', () => {
    const parent = run({ status: 'running' })
    const runs = [
      parent,
      run({ automationId: 'a1' }),
      run({ automationId: 'a1', archived: true }),
      run({ archived: true }),
      run({ status: 'running', delegation: { role: 'worker', parentRunId: parent.id } } as Partial<RunRecord>),
    ]
    expect(originCounts(runs, 'active')).toEqual({ all: 2, direct: 1, automations: 1 })
    expect(originCounts(runs, 'archived')).toEqual({ all: 2, direct: 1, automations: 1 })
  })
})

describe('groupTone', () => {
  it('colours each group, and turns Finished red for a failed member', () => {
    const done = run()
    const failed = run({ status: 'failed' })
    expect(groupTone('Needs you', [])).toBe('pending')
    expect(groupTone('Working', [])).toBe('running')
    expect(groupTone('Archived', [failed])).toBe('neutral')
    expect(groupTone('Finished', [done])).toBe('success')

    const groups = groupRuns([done, run(), failed], 'active')
    const finished = groups.find((group) => group.label === 'Finished')!
    expect(groupTone('Finished', groupMembers(finished))).toBe('danger')
  })
})

describe('groupProjectRuns', () => {
  it('keeps the sidebar grouping, with queue numbers from the unfiltered list', () => {
    const first = run({ status: 'queued', createdAt: '2026-10-24T09:00:00.000Z' })
    const second = run({ status: 'queued', createdAt: '2026-10-24T09:01:00.000Z', automationId: 'a' })
    const review = run({ status: 'review' })
    const all = [first, second, review]
    const visible = all.filter((entry) => matchesOrigin(entry, 'automations'))

    const groups = groupProjectRuns(visible, 'active', all)
    expect(groups).toEqual([{ label: 'Working', rows: [{ kind: 'run', run: second, queuePosition: 2 }] }])
    // Unfiltered, it is exactly the sidebar's answer.
    expect(groupProjectRuns(all, 'active', all)).toEqual(groupRuns(all, 'active'))
  })
})

describe('groupIndexedTasks', () => {
  it('matches the sidebar for one project: review, failures, human and non-human waits, pins', () => {
    const runs = [
      run({ status: 'review' }),
      run({ status: 'failed' }),
      run({ status: 'waiting', waits: [openHumanWait()] }),
      run({ status: 'waiting', waits: [timerWait()] }),
      run({ status: 'running', pinned: true }),
      run({ status: 'queued' }),
    ]
    const tasks = runs.map((summary) => task(indexed('p1', summary)))
    const groups = groupIndexedTasks(tasks, 'active', tasks.map(({ run }) => run))
    expect(shape(groups, ({ run }) => run.id)).toEqual(shape(groupRuns(runs, 'active'), (summary) => summary.id))
    const queued = groups.flatMap((group) => group.rows).find((row) => row.kind === 'run' && row.run.run.status === 'queued')
    expect(queued).toMatchObject({ queuePosition: 1 })
  })

  it('never merges equal task or parent ids from two projects', () => {
    const a = indexed('alpha', run({ id: 'same', status: 'done' }))
    const b = indexed('beta', run({ id: 'same', status: 'done' }))
    const parent = indexed('beta', run({ id: 'parent', status: 'running' }))
    // A worker whose parent id exists in ANOTHER project: it is still an owned worker, so not a row.
    const worker = indexed('alpha', run({ id: 'w', status: 'running', delegation: { role: 'worker', parentRunId: 'parent' } } as Partial<RunRecord>))
    const tasks = [a, b, parent, worker].map(task)
    const groups = groupIndexedTasks(tasks, 'active', tasks.map(({ run }) => run))
    const name = ({ run }: { run: RunIndexEntry }) => `${run.projectId}/${run.id}`
    expect(shape(groups, name)).toEqual(['Finished: beta/same, alpha/same', 'Working: beta/parent'])
    // The rows are the caller's own objects, not namespaced copies.
    expect(groups[0]!.rows[1]).toMatchObject({ kind: 'run', run: tasks[0] })
  })

  it('numbers each project’s queue separately, from the full index', () => {
    const entries = [
      indexed('alpha', run({ id: 'q', status: 'queued', createdAt: '2026-10-24T08:00:00.000Z' })),
      indexed('beta', run({ id: 'q', status: 'queued', createdAt: '2026-10-24T08:01:00.000Z' })),
      indexed('beta', run({ id: 'q2', status: 'queued', createdAt: '2026-10-24T08:02:00.000Z', automationId: 'a' })),
    ]
    const visible = entries.filter((entry) => matchesOrigin(entry, 'automations')).map(task)
    const groups = groupIndexedTasks(visible, 'active', entries)
    expect(groups[0]!.rows).toEqual([{ kind: 'run', run: visible[0], queuePosition: 2 }])
  })

  it('collapses archived history into one Archived group', () => {
    const tasks = [run({ archived: true, status: 'failed' }), run({ archived: true })].map((summary) => task(indexed('p', summary)))
    expect(groupIndexedTasks(tasks, 'archived', []).map((group) => group.label)).toEqual(['Archived'])
  })
})
