import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityProject, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, iso, project, request, run } from './activity.testkit'
import { ActivityBoard } from './activity-board'
import { EMPTY_MOTION, applyMotion, planMotion, type MotionState } from './activity-motion'
import type { Box } from './line-geometry'
import { PEER_LABEL } from './line-measure'
import { placeBoxes, samplePath } from './line-layout.testkit'

/**
 * Peer-wait lines on the project view (spec 2026-11-05-live-activity-view, "Lines between
 * tasks"): a root that waits on a peer (`cez message wait --peer`) is linked to that peer by a
 * dotted line from the peer to the waiter, and pointing at or focusing either card outlines the
 * other. jsdom's window is 1024 × 768; the graph is three 300 px columns with 96 px gaps.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const col = (i: number) => i * 396

const waiting = (runId: string, title: string, peerRunIds: string[]): ActivityRun => run({
  runId,
  title,
  status: RUN_STATUS.waiting,
  rung: 'waiting-on-workers',
  wait: { kind: ACTIVITY_WAIT_KIND.peers, since: iso(-192_000), deadline: iso(408_000), detail: { peerRunIds } },
})

const WAITER = waiting('waiter', 'Schema migration', ['peer'])
const PEER = run({ runId: 'peer', title: 'API contract review' })
const OTHER = run({ runId: 'other', title: 'Release notes' })
const WAIT_ID = 'wait:waiter:peer'

function renderBoard(value: ActivityProject, boxes: Record<string, Box>, width = 1092, motion: MotionState = EMPTY_MOTION) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  placeBoxes('data-activity-card', boxes)
  return render(
    <MemoryRouter initialEntries={['/p/cezarion/activity']}>
      <ActivityBoard project={value} now={NOW} watchingSince={iso(-60_000)} motion={motion} />
    </MemoryRouter>,
  )
}

const BOXES = { waiter: { x: col(0), y: 0, w: 300, h: 120 }, peer: { x: col(1), y: 200, w: 300, h: 120 }, other: { x: col(2), y: 0, w: 300, h: 120 } }
const card = (runId: string) => document.querySelector(`[data-activity-card="${runId}"]`) as HTMLElement
const waitPath = (id = WAIT_ID) => document.querySelector(`path[data-wait="${id}"]`)
const waitLabel = (id = WAIT_ID) => document.querySelector(`[data-slot="activity-line-label"][data-wait="${id}"]`)
const lineText = (el: HTMLElement) => Array.from(el.querySelectorAll(':scope > [data-slot="activity-line-text"] li')).map((li) => li.textContent)

describe('peer-wait lines', () => {
  it('draws a dotted line from the peer card to the waiter card, ending in a ring, with its label', () => {
    renderBoard(project({ tasks: [WAITER, PEER] }), BOXES)
    const path = waitPath()
    expect(path?.getAttribute('data-kind')).toBe('wait')
    expect(path?.getAttribute('stroke-dasharray')).toBe('0 8')
    expect(path?.classList.contains('activity-drift')).toBe(true)
    const points = samplePath(path?.getAttribute('d') ?? '')
    // From the peer's facing edge (left, at title height) to the waiter's right edge.
    expect(points[0]).toEqual({ x: col(1), y: 222 })
    expect(points[points.length - 1]).toEqual({ x: 302, y: 22 })
    expect(waitLabel()?.textContent).toBe('Waiting3:12')
    expect(waitLabel()?.querySelector('[data-slot="activity-wait-bar"] span')?.getAttribute('style')).toContain('width: 32%')
  })

  it('gives both cards the text form of the wait', () => {
    renderBoard(project({ tasks: [WAITER, PEER] }), BOXES)
    expect(lineText(card('waiter'))).toEqual(['Waiting for a message from API contract review'])
    expect(lineText(card('peer'))).toEqual(['Schema migration waits for you to write'])
  })

  it('ends a stub in the waiter when the peer is below the screen, naming the peer', () => {
    renderBoard(project({ tasks: [WAITER, PEER] }), { ...BOXES, peer: { x: col(1), y: 2_000, w: 300, h: 120 } })
    const points = samplePath(waitPath()?.getAttribute('d') ?? '')
    expect(points[0]).toEqual({ x: 348, y: 768 - PEER_LABEL.h / 2 - 4 })
    expect(points[points.length - 1]).toEqual({ x: 302, y: 22 })
    expect(waitLabel()?.textContent).toContain('API contract review')
  })

  it('keeps a wait and a request between the same two cards apart', () => {
    const asks = request({ senderRunId: 'waiter', recipientRunId: 'peer' })
    renderBoard(project({ tasks: [WAITER, PEER], requests: [asks] }), BOXES)
    const wait = samplePath(waitPath()?.getAttribute('d') ?? '')
    const req = samplePath(document.querySelector(`path[data-request="${asks.requestId}"]`)?.getAttribute('d') ?? '')
    expect(wait[wait.length - 1]?.y).not.toBe(req[0]?.y)
  })

  it('swaps the line for a link on the waiter card in one column', () => {
    renderBoard(project({ tasks: [WAITER, PEER] }), BOXES, 320)
    expect(waitPath()).toBeNull()
    const link = within(card('waiter')).getByRole('link', { name: '⋯ waits on API contract review' })
    expect(link.getAttribute('href')).toBe('/p/cezarion/tasks/peer')
    expect(within(card('peer')).queryByRole('link', { name: /^⋯/ })).toBeNull()
  })
})

describe('peer-wait motion', () => {
  const wait = { id: WAIT_ID, waiterRunId: 'waiter', peerRunId: 'peer', since: iso(-192_000), deadline: iso(408_000) }
  const motionOf = (kind: 'wait-opened' | 'wait-closed') => applyMotion(EMPTY_MOTION, planMotion([{ kind, projectId: 'cezarion', wait }], 1, false).changes)

  it('fades a new wait line in', () => {
    renderBoard(project({ tasks: [WAITER, PEER] }), BOXES, 1092, motionOf('wait-opened'))
    expect(waitPath()?.classList.contains('activity-line-in')).toBe(true)
  })

  it('keeps an ended wait drawn while it fades out, with its label', () => {
    const stopped = run({ ...WAITER, status: RUN_STATUS.running, rung: 'running', wait: undefined })
    renderBoard(project({ tasks: [stopped, PEER] }), BOXES, 1092, motionOf('wait-closed'))
    expect(waitPath()?.classList.contains('activity-line-out')).toBe(true)
    expect(waitPath()?.classList.contains('activity-drift')).toBe(false)
    expect(waitLabel()?.classList.contains('activity-line-out')).toBe(true)
    // The text form lists only open waits.
    expect(lineText(card('waiter'))).toEqual([])
  })
})

describe('the hover highlight', () => {
  it('outlines the linked card and stresses the line while the pointer is on either card', () => {
    renderBoard(project({ tasks: [WAITER, PEER, OTHER] }), BOXES)
    expect(card('peer').getAttribute('data-linked')).toBeNull()
    fireEvent.pointerEnter(card('waiter'))
    expect(card('peer').getAttribute('data-linked')).toBe('true')
    expect(card('other').getAttribute('data-linked')).toBeNull()
    expect(card('waiter').getAttribute('data-linked')).toBeNull()
    expect(waitPath()?.getAttribute('data-active')).toBe('true')
    fireEvent.pointerLeave(card('waiter'))
    expect(card('peer').getAttribute('data-linked')).toBeNull()
    expect(waitPath()?.getAttribute('data-active')).toBeNull()
    fireEvent.pointerEnter(card('peer'))
    expect(card('waiter').getAttribute('data-linked')).toBe('true')
  })

  it('follows keyboard focus inside a card', () => {
    renderBoard(project({ tasks: [WAITER, PEER, OTHER] }), BOXES)
    const link = within(card('peer')).getByRole('link', { name: 'API contract review' })
    fireEvent.focus(link)
    expect(card('waiter').getAttribute('data-linked')).toBe('true')
    fireEvent.blur(link)
    expect(card('waiter').getAttribute('data-linked')).toBeNull()
  })

  it('keeps the highlight of a focused card when the pointer leaves it, and moves it with the pointer', () => {
    renderBoard(project({ tasks: [WAITER, PEER, OTHER] }), BOXES)
    const link = within(card('peer')).getByRole('link', { name: 'API contract review' })
    fireEvent.pointerEnter(card('peer'))
    fireEvent.focus(link)
    fireEvent.pointerLeave(card('peer'))
    expect(card('waiter').getAttribute('data-linked')).toBe('true')
    // The pointer wins while it is on a card; the focus returns when it leaves.
    fireEvent.pointerEnter(card('waiter'))
    expect(card('peer').getAttribute('data-linked')).toBe('true')
    fireEvent.pointerLeave(card('waiter'))
    expect(card('waiter').getAttribute('data-linked')).toBe('true')
    fireEvent.blur(link)
    expect(document.querySelectorAll('[data-linked]')).toHaveLength(0)
  })

  it('does nothing for a card no wait links', () => {
    renderBoard(project({ tasks: [WAITER, PEER, OTHER] }), BOXES)
    fireEvent.pointerEnter(card('other'))
    expect(document.querySelectorAll('[data-linked]')).toHaveLength(0)
    expect(waitPath()?.getAttribute('data-active')).toBeNull()
  })
})
