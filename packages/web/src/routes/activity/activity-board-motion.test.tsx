import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityProject } from '@open-mercato/cezar-api-client/contract/activity'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, iso, project, request, run, worker } from './activity.testkit'
import { ActivityBoard } from './activity-board'
import type { ActivityTrigger } from './activity-diff'
import { EMPTY_MOTION, applyMotion, planMotion, type MotionState } from './activity-motion'
import { SummaryChips } from './activity-header'
import { summarize } from './activity-model'

/** The motion state drawn on the board: each trigger's mark on the cards, the lines and the rail. */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const motionOf = (...triggers: ActivityTrigger[]): MotionState => applyMotion(EMPTY_MOTION, planMotion(triggers, 1, false).changes)

function renderBoard(value: ActivityProject, motion: MotionState, feed = [] as { id: number; at: number; tone: 'success'; text: string }[]) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1092)
  return render(
    <MemoryRouter initialEntries={['/p/cezarion/activity']}>
      <ActivityBoard project={value} now={NOW} watchingSince={iso(-60_000)} motion={motion} feed={feed} />
    </MemoryRouter>,
  )
}

const A = run({ runId: 'a', title: 'Porting upstream SSE' })
const B = run({ runId: 'b', title: 'Fixing flaky shard 3' })
const projectId = 'cezarion'

describe('the board in motion', () => {
  // Rule: docs/areas/web-ui.md § Activity view (reduced motion, motion cost).
  it('pulses a running dot, breathes a waiting shape and sweeps the running now box', () => {
    const waiting = run({ runId: 'w', status: RUN_STATUS.waiting, rung: 'waiting-for-merge', wait: { kind: ACTIVITY_WAIT_KIND.pr, since: iso(-1_000), deadline: iso(60_000), detail: { number: 3, target: 'merge' } } })
    renderBoard(project({ tasks: [A, waiting] }), EMPTY_MOTION)
    expect(document.querySelector('[data-activity-anchor="a"]')?.classList.contains('activity-pulse')).toBe(true)
    expect(document.querySelector('[data-activity-anchor="w"]')?.classList.contains('activity-breathe')).toBe(true)
    expect(document.querySelector('[data-activity-card="a"] [data-slot="activity-sweep"]')).not.toBeNull()
    expect(document.querySelector('[data-activity-card="w"] [data-slot="activity-sweep"]')).toBeNull()
  })

  it('keeps a card that left as a ghost no line ends at, out of the keyboard and the accessibility tree', () => {
    renderBoard(project({ tasks: [A] }), motionOf({ kind: 'card-left', projectId, task: B }))
    const ghost = document.querySelector('[data-activity-ghost="b"]') as HTMLElement
    expect(ghost.classList.contains('activity-card-leave')).toBe(true)
    expect(ghost.hasAttribute('inert')).toBe(true)
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelectorAll('[data-activity-card]')).toHaveLength(1)
  })

  // Rule: docs/areas/web-ui.md § Activity view (reduced motion, motion cost).
  it('flashes a card in its new tone and slides its main line in', () => {
    renderBoard(project({ tasks: [A] }), motionOf({ kind: 'rung-changed', projectId, task: A, from: 'queued' }, { kind: 'tool-started', projectId, runId: 'a' }))
    expect(document.querySelector('[data-activity-card="a"] [data-slot="activity-flash"]')?.getAttribute('data-tone')).toBe('running')
    expect(document.querySelector('[data-activity-card="a"] [data-slot="activity-main"]')?.classList.contains('activity-slide')).toBe(true)
  })

  it('keeps a settled worker as a row while it flashes, out of the finished count', () => {
    const done = worker({ runId: 'w', status: RUN_STATUS.done, rung: 'done' })
    renderBoard(project({ tasks: [{ ...A, workers: [done] }] }), motionOf({ kind: 'worker-settled', projectId, parentId: 'a', worker: done }))
    expect(document.querySelector('[data-slot="activity-worker"][data-run="w"]')?.getAttribute('data-hold')).toBe('flash')
    expect(document.querySelector('[data-slot="activity-finished"]')).toBeNull()
  })

  // Rule: docs/areas/web-ui.md § Activity view (reduced motion, motion cost).
  it('flashes a check that just passed', () => {
    const ci = run({ runId: 'c', status: RUN_STATUS.waiting, rung: 'waiting-for-ci', wait: { kind: ACTIVITY_WAIT_KIND.pr, since: iso(-1_000), deadline: iso(60_000), detail: { number: 7, target: 'checks', checks: [{ name: 'lint', bucket: 'pass' }, { name: 'test', bucket: 'pending' }], counts: { pass: 1, fail: 0, pending: 1, skipping: 0, cancel: 0 } } } })
    renderBoard(project({ tasks: [ci] }), motionOf({ kind: 'check-passed', projectId, runId: 'c', pr: 7, name: 'lint' }))
    expect(document.querySelector('[data-bucket="pass"]')?.classList.contains('activity-check-pass')).toBe(true)
    expect(document.querySelector('[data-bucket="pending"]')?.classList.contains('activity-breathe-fast')).toBe(true)
  })

  // Rule: docs/areas/web-ui.md § Activity view (reduced motion, motion cost).
  it('folds the rail entry of a closed request while the reply comet travels back', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    renderBoard(project({ tasks: [A, B] }), motionOf({ kind: 'request-closed', projectId, request: peer, status: 'replied' }))
    expect(document.querySelector(`path[data-request="${peer.requestId}"]`)?.getAttribute('data-phase')).toBe('reply')
    expect(document.querySelector('[data-slot="activity-request-closing"]')?.classList.contains('activity-row-fold')).toBe(true)
    expect(document.querySelectorAll('[data-slot="activity-request"]')).toHaveLength(0)
  })

  it('then draws the line solid with "Replied", and the rail has let the entry go', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    let motion = motionOf({ kind: 'request-closed', projectId, request: peer, status: 'replied' })
    motion = { ...motion, closing: { [peer.requestId]: { ...motion.closing[peer.requestId]!, phase: 'replied' } } }
    renderBoard(project({ tasks: [A, B] }), motion)
    const path = document.querySelector(`path[data-request="${peer.requestId}"]`)
    expect(path?.getAttribute('data-phase')).toBe('replied')
    expect(path?.hasAttribute('stroke-dasharray')).toBe(false)
    expect(document.querySelector('[data-slot="activity-line-label"]')?.textContent).toMatch(/^Replied/)
    expect(document.querySelector('[data-slot="activity-request-closing"]')).toBeNull()
    expect(screen.getByText('No task waits for a reply.')).toBeTruthy()
  })

  // Rule: docs/areas/web-ui.md § Activity view (reduced motion, motion cost).
  it('marches open lines and fades a new one in behind its comet', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), motionOf({ kind: 'request-opened', projectId, request: peer }))
    const path = document.querySelector(`path[data-request="${peer.requestId}"]`)
    expect(path?.classList.contains('activity-march')).toBe(true)
    expect(path?.classList.contains('activity-line-in')).toBe(true)
    expect(document.querySelector('[data-slot="activity-request"]')?.classList.contains('activity-row-enter')).toBe(true)
  })

  it('lists the feed in the rail, newest first, with ages', () => {
    renderBoard(project({ tasks: [A] }), EMPTY_MOTION, [{ id: 2, at: NOW - 12_000, tone: 'success', text: 'Review branch finished' }, { id: 1, at: NOW - 90_000, tone: 'success', text: 'PR 7: check “lint” passed' }])
    const feed = screen.getByRole('complementary', { name: 'Activity details' }).querySelector('[data-slot="activity-just-now"]') as HTMLElement
    expect(Array.from(within(feed).getAllByRole('listitem')).map((li) => li.textContent)).toEqual(['Review branch finished12 s', 'PR 7: check “lint” passed1 min'])
    expect(feed.textContent).toMatch(/Watching since \d{2}:\d{2}/)
  })

  // Rule: docs/areas/web-ui.md § Activity view (reduced motion, motion cost).
  it('bumps a chip whose count changed', () => {
    const motion = motionOf({ kind: 'chip-changed', chip: 'working', from: 0, to: 1 })
    render(<MemoryRouter><SummaryChips summary={summarize([project({ tasks: [A] })])} tasksTo="/" bumps={motion.bumps} /></MemoryRouter>)
    expect(document.querySelector('[data-chip="working"] strong')?.classList.contains('activity-bump')).toBe(true)
    expect(document.querySelector('[data-chip="queued"] strong')?.classList.contains('activity-bump')).toBe(false)
  })
})
