import {
  RUN_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
} from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
// @vitest-environment node
import { expect, it } from 'vitest'
import { openHumanWait, summaryOf } from '@/test/run-summary-fixture'
import { runDelegationSummarySchema } from '@open-mercato/cezar-api-client/contract/delegation'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { deriveAttention, wantsAttention } from './attention'
import { bucketOf, listCounts } from './task-groups'
import { diffRunTransitions } from './notifications'

const requestId = '10000000-0000-4000-8000-000000000001'
/** A request wait is a worker entry in the wait list naming the requests (hearsay-tools/cezarion#1301). */
const requestWait = (over: Record<string, unknown> = {}) => ({
  kind: WAIT_KIND.worker, id: requestId, source: WAIT_SOURCE.agent, via: WAIT_VIA['cez-worker-wait'],
  registeredAt: '2026-09-16T00:00:00.000Z', deadline: '2026-09-17T00:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1',
  timeoutSeconds: 600, workerIds: [], requestIds: [requestId], revisions: [], outcomes: [],
  ...over,
})
function waiting(role: 'root' | 'worker', wait: Record<string, unknown> = {}): RunRecord {
  return {
    id: 'run', title: 'Verify integration', task: 'Verify integration', workflow: 'quick-task', status: RUN_STATUS.waiting,
    createdAt: '2026-09-16T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [],
    waits: [requestWait(wait)],
    delegation: role === 'root' ? { role, permissions: [], receipts: [] } : {
      role, permissions: [], parentRunId: requestId,
      workspace: { kind: 'owned-isolated', ownerRunId: requestId, resourceId: requestId, path: '/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40) },
    },
  } as RunRecord
}

it.each([
  ['root', 'waiting on worker replies'],
  ['worker', 'waiting on parent reply'],
] as const)('keeps %s request waits out of human attention on full and projected records', (role, label) => {
  const record = summaryOf(waiting(role))
  const projected = { ...record, delegation: runDelegationSummarySchema.parse(record.delegation) }
  for (const input of [record, projected]) {
    // Violet family (#617): a root waits on its own workers (robot); a worker on its parent (ring).
    expect(deriveAttention(input)).toEqual({ rung: 'waiting-on-workers', bucket: 'none', tone: 'running', shape: role === 'root' ? 'workers' : 'ring', pulse: false, label })
  }
  expect(wantsAttention(record)).toBe(false)
  expect(bucketOf(record, 'active')).toBe('Working')
  expect(listCounts([record])).toEqual(
    role === 'worker' ? { active: 0, archived: 0, waiting: 0 } : { active: 1, archived: 0, waiting: 0 },
  )
  const previous = diffRunTransitions(new Map(), [{ ...record, status: RUN_STATUS.running }]).statuses
  const parked = diffRunTransitions(previous, [record])
  expect(parked.entering).toEqual([])
  const asking = summaryOf({ ...waiting(role), waits: [...(waiting(role).waits ?? []), openHumanWait()] })
  expect(deriveAttention(asking).label).toBe('needs you')
  expect(bucketOf(asking, 'active')).toBe('Needs you')
  expect(listCounts([asking]).waiting).toBe(role === 'worker' ? 0 : 1)
  expect(diffRunTransitions(parked.statuses, [asking]).entering).toEqual([asking])
  expect(deriveAttention({ ...record, status: RUN_STATUS.review }).label).toBe('needs review')
})

it.each(['root', 'worker'] as const)('follows %s lifecycle after reply, timeout, and cancellation', role => {
  const record = waiting(role)
  const resumed = summaryOf(waiting(role, { phase: WAIT_PHASE.resolved, resolvedAt: '2026-09-16T00:05:00.000Z' }))
  expect(deriveAttention(resumed).label).toBe('waiting for capacity')
  expect(wantsAttention(resumed)).toBe(false)
  expect(deriveAttention({ ...resumed, status: RUN_STATUS.running }).label).toBe('running')
  expect(deriveAttention({ ...record, status: RUN_STATUS.done }).label).toBe('done')
  expect(deriveAttention({ ...record, status: RUN_STATUS.cancelled }).label).toBe('cancelled')
  expect(deriveAttention({ ...record, waits: undefined }).label).toBe('needs you')
})

it('keeps a resolved parent wait with a pending human ask as Needs you', () => {
  const resolved = waiting('root', { phase: WAIT_PHASE.resolved, resolvedAt: '2026-09-16T00:05:00.000Z' })
  const asking = summaryOf({ ...resolved, waits: [...(resolved.waits ?? []), openHumanWait()] })
  expect(deriveAttention(asking).label).toBe('needs you')
  expect(wantsAttention(asking)).toBe(true)
  expect(bucketOf(asking, 'active')).toBe('Needs you')
})

// The wait lives in the list, not the delegation: an unreadable delegation hides no wait, and
// a run without one is a human gate again.
it('keeps a waiting run without a request wait visible to humans', () => {
  const record = waiting('worker')
  expect(deriveAttention({ ...record, delegation: { role: 'invalid' } }).label).not.toBe('needs you')
  expect(deriveAttention({ ...record, waits: undefined }).label).toBe('needs you')
  expect(deriveAttention({ ...record, waits: undefined, delegation: { role: 'invalid' } }).label).toBe('needs you')
})

// The monitoring activity is no longer a park (hearsay-tools/cezarion#1301): a timer wait is.
it('keeps monitoring quiet and notifies for later human and completion gates (fork #772)', () => {
  const base = summaryOf({ ...waiting('root'), waits: undefined, delegation: undefined, status: RUN_STATUS.running })
  const previous = diffRunTransitions(new Map(), [base]).statuses
  const timer = {
    kind: WAIT_KIND.timer, id: '00000000-0000-4000-8000-0000000000d1', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait,
    registeredAt: '2026-10-17T15:00:00.000Z', deadline: '2026-10-17T15:05:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1', seconds: 300,
  }
  const monitor = { ...base, status: RUN_STATUS.waiting, waits: [timer] } as typeof base
  const monitoring = diffRunTransitions(previous, [monitor])
  expect(deriveAttention(monitor).label).toBe('monitoring')
  expect(bucketOf(monitor, 'active')).toBe('Working')
  expect(wantsAttention(monitor)).toBe(false)
  expect(monitoring.entering).toEqual([])
  for (const gate of [
    { ...monitor, waits: undefined }, // explicit prose gate, no ASK
    { ...monitor, waits: [openHumanWait()] },
    { ...monitor, status: RUN_STATUS.review, waits: undefined },
    { ...monitor, status: RUN_STATUS.failed, waits: undefined },
  ]) {
    expect(wantsAttention(gate)).toBe(true)
    expect(diffRunTransitions(monitoring.statuses, [gate]).entering).toEqual([gate])
  }
})
