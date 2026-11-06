import { describe, expect, it } from 'vitest'
import { LIVE_PROTOCOL, LIVE_WORKER_NAME, allowedLiveRead, liveDemandSchema, ownerInputSchema, ownerOutputSchema } from './live-coordination.ts'

const read = (intervalMs: number) => ({ kind: 'read', path: '/api/v1/p/boot/github/ref-status?prs=1', intervalMs })

describe('recurring read cadence', () => {
  it.each([600_000, 86_400_000, 2_147_483_647])('accepts timer-safe long intervals (%i ms) across the worker boundary', intervalMs => {
    const message = { version: LIVE_PROTOCOL, documentId: 'tab', epoch: 1, type: 'sync', entries: [{ id: 'status', demand: read(intervalMs) }] }
    expect(ownerInputSchema.parse(message)).toEqual(message)
  })

  it.each([999, 1_000.5, 2_147_483_648, Infinity, NaN])('rejects intervals that hammer or overflow timers (%s)', intervalMs => {
    expect(liveDemandSchema.safeParse(read(intervalMs)).success).toBe(false)
  })
})

describe('protocol version (hearsay-tools/cezarion#2729)', () => {
  it('is 3 with a matching worker name, and a version-2 worker message does not parse', () => {
    expect([LIVE_PROTOCOL, LIVE_WORKER_NAME]).toEqual([3, 'cezar-live-v3'])
    expect(ownerOutputSchema.safeParse({ type: 'hello', version: 2 }).success).toBe(false)
    expect(ownerOutputSchema.safeParse({ type: 'hello', version: 3 }).success).toBe(true)
    expect(ownerInputSchema.safeParse({ version: 2, documentId: 'tab', epoch: 1, type: 'sync', entries: [] }).success).toBe(false)
    // A document that lost the workspace ready asks for it on its sync.
    expect(ownerInputSchema.safeParse({ version: 3, documentId: 'tab', epoch: 1, type: 'sync', entries: [], workspaceReady: true }).success).toBe(true)
    expect(ownerInputSchema.safeParse({ version: 3, documentId: 'tab', epoch: 1, type: 'sync', entries: [], workspaceReady: false }).success).toBe(false)
  })
})

describe('the shared-read allowlist', () => {
  it.each(['/api/v1/workspace/activity', '/api/v1/workspace/activity?project=shop'])('shares the activity snapshot read %s', path => {
    expect(allowedLiveRead(path)).toBe(true)
  })

  it.each(['/api/v1/workspace/activity/extra', '/api/v1/workspace/activityx', '/api/workspace/activity'])('refuses %s', path => {
    expect(allowedLiveRead(path)).toBe(false)
  })
})

it('allows finite report state reads without allowing the report list as recurring work', () => {
  expect(allowedLiveRead('/api/v1/p/shop/reports/state')).toBe(true)
  expect(liveDemandSchema.safeParse({ kind: 'read', path: '/api/v1/p/shop/reports/state', intervalMs: 5_000 }).success).toBe(true)
  expect(allowedLiveRead('/api/v1/p/shop/reports')).toBe(false)
  expect(allowedLiveRead('/api/v1/p/shop/reports/state/extra')).toBe(false)
})
