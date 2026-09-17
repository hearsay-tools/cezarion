// @vitest-environment node
import { expect, it } from 'vitest'
import { runDelegationSummarySchema, type RunRecord } from '@open-mercato/cezar-api-client'
import { deriveAttention, wantsAttention } from './attention'
import { bucketOf, listCounts } from './task-groups'
import { diffRunTransitions } from './notifications'

const requestId = '10000000-0000-4000-8000-000000000001'
function waiting(role: 'root' | 'worker'): RunRecord {
  const wait = { id: requestId, workerIds: [], requestIds: [requestId], deadline: '2026-09-17T00:00:00.000Z', phase: 'parked' as const, outcomes: [] }
  return {
    id: 'run', title: 'Verify integration', task: 'Verify integration', workflow: 'quick-task', status: 'waiting',
    createdAt: '2026-09-16T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [],
    delegation: role === 'root' ? { role, permissions: [], receipts: [], wait } : {
      role, permissions: [], parentRunId: requestId, wait,
      workspace: { kind: 'owned-isolated', ownerRunId: requestId, resourceId: requestId, path: '/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40) },
    },
  }
}

it.each([
  ['root', 'waiting on worker replies'],
  ['worker', 'waiting on parent reply'],
] as const)('keeps %s request waits out of human attention on full and projected records', (role, label) => {
  const record = waiting(role)
  const projected = { ...record, delegation: runDelegationSummarySchema.parse(record.delegation) }
  for (const input of [record, projected]) {
    expect(deriveAttention(input)).toEqual({ bucket: 'none', tone: 'accent', pulse: false, label })
  }
  expect(wantsAttention(record)).toBe(false)
  expect(bucketOf(record, 'active')).toBe('Working')
  expect(listCounts([record])).toEqual({ active: 1, archived: 0, waiting: 0 })
  const previous = diffRunTransitions(new Map(), [{ ...record, status: 'running' }]).statuses
  const parked = diffRunTransitions(previous, [record])
  expect(parked.entering).toEqual([])
  const asking = { ...record, hasPendingHumanAsk: true }
  expect(deriveAttention(asking).label).toBe('needs you')
  expect(deriveAttention(record, true).label).toBe('needs you')
  expect(bucketOf(asking, 'active')).toBe('Needs you')
  expect(listCounts([asking]).waiting).toBe(1)
  expect(diffRunTransitions(parked.statuses, [asking]).entering).toEqual([asking])
  expect(deriveAttention({ ...record, status: 'review' }).label).toBe('needs review')
})

it.each(['root', 'worker'] as const)('follows %s lifecycle after reply, timeout, and cancellation', role => {
  const record = waiting(role)
  if (!record.delegation || record.delegation.role === 'invalid' || !record.delegation.wait) throw Error('fixture')
  for (const reason of ['outcome', 'timeout', 'cancelled'] as const) {
    const resumed = { ...record, delegation: { ...record.delegation, wait: { ...record.delegation.wait, phase: 'wake-pending' as const, reason } } }
    expect(deriveAttention(resumed).label).toBe('needs you')
    expect(deriveAttention({ ...resumed, status: 'running' }).label).toBe('running')
  }
  expect(deriveAttention({ ...record, status: 'done' }).label).toBe('done')
  expect(deriveAttention({ ...record, status: 'cancelled' }).label).toBe('cancelled')
  expect(deriveAttention({ ...record, delegation: undefined }).label).toBe('needs you')
})


it('keeps absent or invalid delegation and workers without a request wait visible to humans', () => {
  const record = waiting('worker')
  if (record.delegation?.role !== 'worker' || !record.delegation.wait) throw Error('fixture')
  expect(deriveAttention({ ...record, delegation: { role: 'invalid' } }).label).toBe('needs you')
  expect(deriveAttention({ ...record, delegation: { ...record.delegation, wait: { ...record.delegation.wait, requestIds: undefined } } }).label).toBe('needs you')
})
