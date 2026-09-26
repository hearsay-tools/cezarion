import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveRefetchInterval } from './live-refetch'

const isCockpitE2e = vi.hoisted(() => vi.fn(() => false))
vi.mock('./e2e-mode', () => ({ isCockpitE2e: () => isCockpitE2e() }))

afterEach(() => {
  isCockpitE2e.mockReturnValue(false)
})

describe('liveRefetchInterval (#415)', () => {
  it('passes production intervals through', () => {
    expect(liveRefetchInterval(4000)).toBe(4000)
    expect(liveRefetchInterval(false)).toBe(false)
  })

  it('disables every interval in e2e mode', () => {
    isCockpitE2e.mockReturnValue(true)
    expect(liveRefetchInterval(4000)).toBe(false)
    expect(liveRefetchInterval(() => 60_000)).toBe(false)
  })
})
