import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityProject, ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'

import { NOW, iso, project, request, run } from './activity.testkit'
import { ActivityBoard } from './activity-board'
import { EMPTY_MOTION, MOTION_MS } from './activity-motion'
import type { Box } from './line-geometry'
import { placeBoxes, samplePath } from './line-layout.testkit'
import { useActivityMotion } from './use-activity-motion'
import { REDUCED_MOTION_QUERY } from './use-reduced-motion'

/**
 * The board driven by the real motion hook, snapshot after snapshot: the transitions the pure
 * tests cannot see (a ghost's place, FLIP and the lines, a motion preference that changes while
 * motion runs).
 */

/** A FLIP animation the test finishes or that the view cancels. */
class FakeAnimation extends EventTarget {
  cancel = vi.fn(() => this.dispatchEvent(new Event('cancel')))
  finish() {
    this.dispatchEvent(new Event('finish'))
  }
}

let animations: FakeAnimation[] = []
let reduced = false
const mediaListeners = new Set<() => void>()
const frames = { request: vi.fn((_callback: FrameRequestCallback) => 7), cancel: vi.fn() }

beforeEach(() => {
  animations = []
  reduced = false
  mediaListeners.clear()
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: vi.fn(() => {
      const animation = new FakeAnimation()
      animations.push(animation)
      return animation
    }),
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === REDUCED_MOTION_QUERY && reduced,
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }))
  frames.request.mockClear()
  frames.cancel.mockClear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as { animate?: unknown }).animate
})

const at = (offsetMs: number, value: Partial<ActivityProject>): ActivitySnapshot => ({ generatedAt: iso(offsetMs), projects: [project(value)] })

function LiveBoard({ snapshot }: { snapshot: ActivitySnapshot }) {
  const { motion, feed, reduced: still, paused } = useActivityMotion(snapshot, 'cezarion')
  return <ActivityBoard project={snapshot.projects[0]!} now={NOW} watchingSince={iso(-60_000)} motion={motion} feed={feed} still={still} paused={paused} />
}

function renderLive(first: ActivitySnapshot, width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  const view = render(<MemoryRouter><LiveBoard snapshot={first} /></MemoryRouter>)
  return { rerender: (next: ActivitySnapshot) => view.rerender(<MemoryRouter><LiveBoard snapshot={next} /></MemoryRouter>) }
}

const A = run({ runId: 'a', title: 'Porting upstream SSE' })
const B = run({ runId: 'b', title: 'Fixing flaky shard 3' })
const C = run({ runId: 'c', title: 'Update waits docs' })
const D = run({ runId: 'd', title: 'Coordinating digest' })
const column = () => Array.from(document.querySelectorAll('[data-slot="activity-column"]')[0]?.children ?? []).map((el) => el.getAttribute('data-activity-card') ?? `ghost:${el.getAttribute('data-activity-ghost')}`)

describe('the live board', () => {
  it('collapses a card that left in its own slot, never at the end of its column', () => {
    const live = renderLive(at(0, { tasks: [A, B, C] }), 500)
    expect(column()).toEqual(['a', 'b', 'c'])
    live.rerender(at(1_000, { tasks: [A, C] }))
    expect(column()).toEqual(['a', 'ghost:b', 'c'])
  })
})
