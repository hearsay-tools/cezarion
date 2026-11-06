import { describe, expect, it } from 'vitest'

import { project, request, run, RUN_STATUS, worker } from './activity.testkit'
import { groupProjects, idleLead, inRailOrder, panelArcs, panelCounts } from './global-model'
import { ARC_MAX_LIFT, arcPath } from './line-geometry'

const ids = (projects: readonly { projectId: string }[]) => projects.map((p) => p.projectId)

describe('inRailOrder', () => {
  const a = project({ projectId: 'a' })
  const b = project({ projectId: 'b' })
  const c = project({ projectId: 'c' })

  it('orders the snapshot as the rail lists the projects', () => {
    expect(ids(inRailOrder([a, b, c], ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('keeps a project the rail does not list after the others, in snapshot order', () => {
    expect(ids(inRailOrder([a, b, c], ['b']))).toEqual(['b', 'a', 'c'])
  })

  it('keeps the snapshot order until the registry answers', () => {
    expect(ids(inRailOrder([c, a, b], undefined))).toEqual(['c', 'a', 'b'])
  })
})

describe('groupProjects', () => {
  it('gives a panel to each project with active work and collapses loaded idle projects into one line', () => {
    const busy = project({ projectId: 'busy', tasks: [run()] })
    const idle = project({ projectId: 'idle', inReview: 4 })
    const quiet = project({ projectId: 'quiet' })
    const groups = groupProjects([idle, busy, quiet])
    expect(ids(groups.panels)).toEqual(['busy'])
    expect(ids(groups.idle)).toEqual(['idle', 'quiet'])
  })

  it('never puts an unloaded or unavailable project in the idle line: it keeps its notice panel', () => {
    const unloaded = project({ projectId: 'unloaded', loaded: false })
    const broken = project({ projectId: 'broken', unavailable: { status: 503, error: 'The run store is locked.' } })
    const idle = project({ projectId: 'idle' })
    const groups = groupProjects([unloaded, idle, broken])
    expect(ids(groups.panels)).toEqual(['unloaded', 'broken'])
    expect(ids(groups.idle)).toEqual(['idle'])
  })
})

describe('panelArcs', () => {
  it('keeps only peer requests between two pills of the panel', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    const family = request({ relationship: 'family', senderRunId: 'w', recipientRunId: 'a' })
    const away = request({ senderRunId: 'a', recipientRunId: 'not-a-pill' })
    const toward = request({ senderRunId: 'gone', recipientRunId: 'b' })
    const tasks = [run({ runId: 'a', workers: [worker({ runId: 'w' })] }), run({ runId: 'b' })]
    expect(panelArcs({ tasks, requests: [peer, family, away, toward] }).map((r) => r.requestId)).toEqual([peer.requestId])
  })
})

describe('panelCounts and idleLead', () => {
  it('counts pills and live workers', () => {
    const tasks = [run({ workers: [worker(), worker({ status: RUN_STATUS.done, rung: 'done' })] }), run()]
    expect(panelCounts({ tasks })).toBe('2 active tasks · 1 worker')
    expect(panelCounts({ tasks: [run()] })).toBe('1 active task')
  })

  it('says "more" only below panels', () => {
    expect(idleLead(2, true)).toBe('2 more projects have no active work:')
    expect(idleLead(1, false)).toBe('1 project has no active work:')
  })
})

describe('arcPath', () => {
  it('runs through the gap between two rows, from the facing edges, never across a pill', () => {
    const upper = { x: 0, y: 40, w: 220, h: 60 }
    const lower = { x: 0, y: 144, w: 220, h: 60 }
    expect(arcPath(upper, lower)).toEqual({ d: 'M110 101 C 110 121, 110 121, 110 141', label: { x: 110, y: 121 } })
    expect(arcPath(lower, upper)).toEqual({ d: 'M110 143 C 110 123, 110 123, 110 103', label: { x: 110, y: 123 } })
  })

  it('rises above both pills, no higher than the strip reserves, and ends at the recipient', () => {
    const from = { x: 0, y: 40, w: 220, h: 60 }
    const to = { x: 2000, y: 40, w: 220, h: 60 }
    const arc = arcPath(from, to)
    expect(arc.d.startsWith('M110 39 ')).toBe(true)
    expect(arc.d.endsWith('2110 36')).toBe(true)
    expect(arc.d).toContain(`110 ${39 - ARC_MAX_LIFT}`)
    expect(arc.label).toEqual({ x: 1110, y: 39 - ARC_MAX_LIFT * 0.75 })
  })
})
