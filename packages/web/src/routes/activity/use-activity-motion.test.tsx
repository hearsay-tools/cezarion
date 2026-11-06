import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityProject, ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'

import { RUN_STATUS, iso, project, request, run } from './activity.testkit'
import { MOTION_MS } from './activity-motion'
import { useActivityMotion } from './use-activity-motion'
import { REDUCED_MOTION_QUERY } from './use-reduced-motion'

const at = (offsetMs: number, value: Partial<ActivityProject>): ActivitySnapshot => ({ generatedAt: iso(offsetMs), projects: [project(value)] })

const A = run({ runId: 'a', title: 'Porting upstream SSE' })
const B = run({ runId: 'b', title: 'Fixing flaky shard 3' })
const NEEDS_YOU = { ...A, status: RUN_STATUS.waiting, rung: 'needs-you' as const }
const PEER = request({ senderRunId: 'a', recipientRunId: 'b' })

let reduced = false
function setVisible(visible: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === REDUCED_MOTION_QUERY && reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  setVisible(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mount(first: ActivitySnapshot | undefined, scope = 'cezarion') {
  return renderHook(({ snapshot, key }) => useActivityMotion(snapshot, key), { initialProps: { snapshot: first, key: scope } })
}

describe('useActivityMotion', () => {
  it('never animates the first snapshot', () => {
    const hook = mount(at(0, { tasks: [A, B], requests: [PEER] }))
    expect(hook.result.current.motion.flash).toEqual({})
    expect(hook.result.current.motion.comets).toEqual({})
    expect(hook.result.current.feed).toEqual([])
  })

  it('plays the triggers of each later snapshot, lists them in the feed, and lets them end', () => {
    const hook = mount(at(0, { tasks: [A, B] }))
    hook.rerender({ snapshot: at(1_000, { tasks: [NEEDS_YOU, B], requests: [PEER] }), key: 'cezarion' })
    const { motion, feed } = hook.result.current
    expect(motion.flash.a?.tone).toBe('pending')
    expect(Object.values(motion.comets).map((comet) => comet.requestId)).toEqual([PEER.requestId])
    expect(feed.map((entry) => entry.text)).toEqual(['Porting upstream SSE: Needs you', 'Porting upstream SSE asked Fixing flaky shard 3'])
    expect(feed.every((entry) => entry.at === Date.parse(iso(1_000)))).toBe(true)
    act(() => { vi.advanceTimersByTime(MOTION_MS.flash) })
    expect(hook.result.current.motion.flash).toEqual({})
    expect(hook.result.current.motion.comets).toEqual({})
  })

  it('applies every change at once with reduced motion, and still lists it in the feed', () => {
    reduced = true
    const hook = mount(at(0, { tasks: [A, B], requests: [PEER] }))
    hook.rerender({ snapshot: at(1_000, { tasks: [NEEDS_YOU] }), key: 'cezarion' })
    const { motion, feed, reduced: isReduced } = hook.result.current
    expect(isReduced).toBe(true)
    expect(Object.values(motion).every((field) => Object.keys(field).length === 0)).toBe(true)
    expect(feed.map((entry) => entry.text)).toContain('Fixing flaky shard 3 left active work')
  })

  it('stops the motion on a hidden tab and reconciles the first snapshot after the return at once', () => {
    const hook = mount(at(0, { tasks: [A, B] }))
    hook.rerender({ snapshot: at(1_000, { tasks: [NEEDS_YOU, B] }), key: 'cezarion' })
    expect(hook.result.current.motion.flash.a).toBeDefined()
    act(() => { setVisible(false) })
    expect(hook.result.current.paused).toBe(true)
    expect(hook.result.current.motion.flash).toEqual({})
    act(() => { setVisible(true) })
    // The topic sends a fresh snapshot on the return: it applies at once.
    hook.rerender({ snapshot: at(60_000, { tasks: [A] }), key: 'cezarion' })
    expect(hook.result.current.motion.leaving).toEqual({})
    expect(hook.result.current.motion.flash).toEqual({})
    // Later changes animate again.
    hook.rerender({ snapshot: at(61_000, { tasks: [A, B] }), key: 'cezarion' })
    expect(hook.result.current.motion.entering.b).toBeDefined()
  })

  it('starts over on a new scope: its first snapshot never animates', () => {
    const hook = mount(at(0, { tasks: [A] }))
    hook.rerender({ snapshot: at(1_000, { projectId: 'shop', tasks: [B] }), key: 'shop' })
    expect(hook.result.current.motion.entering).toEqual({})
    expect(hook.result.current.feed).toEqual([])
  })
})
