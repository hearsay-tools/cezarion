import { describe, expect, it } from 'vitest'
import { liveDemandSchema, ownerInputSchema } from './live-coordination.ts'

const read = (intervalMs: number) => ({ kind: 'read', path: '/api/v1/p/boot/github/ref-status?prs=1', intervalMs })

describe('recurring read cadence', () => {
  it.each([600_000, 86_400_000, 2_147_483_647])('accepts timer-safe long intervals (%i ms) across the worker boundary', intervalMs => {
    const message = { version: 1, documentId: 'tab', epoch: 1, type: 'sync', entries: [{ id: 'status', demand: read(intervalMs) }] }
    expect(ownerInputSchema.parse(message)).toEqual(message)
  })

  it.each([999, 1_000.5, 2_147_483_648, Infinity, NaN])('rejects intervals that hammer or overflow timers (%s)', intervalMs => {
    expect(liveDemandSchema.safeParse(read(intervalMs)).success).toBe(false)
  })
})
