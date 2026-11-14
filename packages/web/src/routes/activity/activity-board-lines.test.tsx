import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityProject } from '@open-mercato/cezar-api-client/contract/activity'

import { NOW, iso, project, request, run } from './activity.testkit'
import { ActivityBoard } from './activity-board'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import type { Box } from './line-geometry'
import { PEER_LABEL } from './line-measure'
import { labelBox, overlaps, placeBoxes, samplePath } from './line-layout.testkit'

/**
 * The "Many lines" rule and the label fit (spec 2026-11-05-live-activity-view, "Size, motion and
 * access"). jsdom's window is 1024 × 768 and nothing scrolls, so the window is the viewport; the
 * graph is three 300 px columns with 96 px gaps.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const WIDTH = 1092
const col = (i: number) => i * 396

function renderBoard(value: ActivityProject, boxes: Record<string, Box>, motion: MotionState = EMPTY_MOTION) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
  placeBoxes('data-activity-card', boxes)
  return render(
    <MemoryRouter initialEntries={['/p/cezarion/activity']}>
      <ActivityBoard project={value} now={NOW} watchingSince={iso(-60_000)} motion={motion} />
    </MemoryRouter>,
  )
}

const A = run({ runId: 'a', title: 'Porting upstream SSE' })
const B = run({ runId: 'b', title: 'Fixing flaky shard 3' })
const C = run({ runId: 'c', title: 'Update waits docs' })
const D = run({ runId: 'd', title: 'Coordinating digest' })
const path = (requestId: string) => document.querySelector(`path[data-request="${requestId}"]`)?.getAttribute('d') ?? undefined
const label = (requestId: string) => document.querySelector(`[data-slot="activity-line-label"][data-request="${requestId}"]`) as HTMLElement | null

describe('the Many lines rule', () => {
  it('ends a line whose other end is below the screen at the bottom edge, with that card’s name', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), { a: { x: col(0), y: 0, w: 300, h: 120 }, b: { x: col(1), y: 2_000, w: 300, h: 120 } })
    const points = samplePath(path(peer.requestId) ?? '')
    const end = points[points.length - 1]!
    // The free end sits in the gap, its label just inside the viewport's bottom edge.
    expect(end.x).toBe(300 + 48)
    expect(end.y).toBe(768 - PEER_LABEL.h / 2 - 4)
    expect(Math.max(...points.map((p) => p.y))).toBeLessThan(768)
    expect(label(peer.requestId)?.textContent).toContain('Fixing flaky shard 3')
  })

  it('runs a stub from the top edge into a recipient whose sender is above the screen', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), { a: { x: col(0), y: -900, w: 300, h: 120 }, b: { x: col(1), y: 200, w: 300, h: 120 } })
    const points = samplePath(path(peer.requestId) ?? '')
    expect(points[0]).toEqual({ x: 348, y: PEER_LABEL.h / 2 + 4 })
    expect(points[points.length - 1]).toEqual({ x: col(1) - 2, y: 222 })
    expect(label(peer.requestId)?.textContent).toContain('Porting upstream SSE')
  })

  it('draws no line when neither end is on screen', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), { a: { x: col(0), y: -900, w: 300, h: 120 }, b: { x: col(1), y: 2_000, w: 300, h: 120 } })
    expect(path(peer.requestId)).toBeUndefined()
    expect(label(peer.requestId)).toBeNull()
    // The rail still lists the request: the rule only decides what is drawn.
    expect(document.querySelectorAll('[data-slot="activity-request"]')).toHaveLength(1)
  })

  it('draws again when a scroll brings the card on screen', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    const boxes = { a: { x: col(0), y: 0, w: 300, h: 120 }, b: { x: col(1), y: 2_000, w: 300, h: 120 } }
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), boxes)
    expect(label(peer.requestId)?.textContent).toContain('Fixing flaky shard 3')
    boxes.b.y = 300
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(frame).toHaveBeenCalled()
    const points = samplePath(path(peer.requestId) ?? '')
    expect(points[points.length - 1]).toEqual({ x: col(1) - 2, y: 322 })
    expect(label(peer.requestId)?.textContent).not.toContain('Fixing flaky shard 3')
  })
})

describe('a stub near the viewport edge', () => {
  it.each([550, 580])('keeps its end and its label inside a 600 px viewport for a card at y %i', (top) => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600)
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), { a: { x: col(0), y: top, w: 300, h: 120 }, b: { x: col(1), y: 2_000, w: 300, h: 120 } })
    const points = samplePath(path(peer.requestId) ?? '')
    const end = points[points.length - 1]!
    expect(end.y).toBeLessThanOrEqual(600 - PEER_LABEL.h / 2 - 4)
    const box = labelBox(label(peer.requestId)!, PEER_LABEL)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.h).toBeLessThanOrEqual(600)
  })
})

describe('labels of several stubs at the bottom edge', () => {
  it.each([2, 3])('stay inside a 600 px viewport and apart, with %i stubs in one gap', (count) => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600)
    const senders = Array.from({ length: count }, (_, i) => run({ runId: `s${i}`, title: `Sender ${i}` }))
    const away = Array.from({ length: count }, (_, i) => run({ runId: `r${i}`, title: `Far task ${i}` }))
    const requests = senders.map((sender, i) => request({ senderRunId: sender.runId, recipientRunId: `r${i}` }))
    const boxes: Record<string, Box> = {}
    senders.forEach((sender, i) => { boxes[sender.runId] = { x: col(0), y: 560 - i * 130, w: 300, h: 120 } })
    away.forEach((task, i) => { boxes[task.runId] = { x: col(1), y: 2_000 + i * 200, w: 300, h: 120 } })
    renderBoard(project({ tasks: [...senders, ...away], requests }), boxes)
    const placed = requests.map((peer) => labelBox(label(peer.requestId)!, PEER_LABEL))
    expect(placed).toHaveLength(count)
    for (const box of placed) {
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.h).toBeLessThanOrEqual(600)
    }
    for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
  })
})

describe('peer labels', () => {
  const boxes = { a: { x: col(0), y: 0, w: 300, h: 160 }, b: { x: col(1), y: 0, w: 300, h: 160 } }

  it('shows the question, age and deadline progress on an open request', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b', text: 'Review the API?', createdAt: iso(-25_000), deadline: iso(75_000) })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), boxes)
    const el = label(peer.requestId)!
    expect(el.textContent).toBe('Request0:25Review the API?')
    expect(el.querySelector<HTMLElement>('span[style]')?.style.width).toBe('25%')
    expect(el.classList.contains('activity-line-out')).toBe(false)
    const line = document.querySelector(`path[data-request="${peer.requestId}"]`)!
    expect(line.getAttribute('data-phase')).toBe('open')
    expect(line.getAttribute('stroke-dasharray')).toBe('6 5')
  })

  it('omits the progress bar for a request with no deadline', () => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b', deadline: undefined })
    renderBoard(project({ tasks: [A, B], requests: [peer] }), boxes)
    expect(label(peer.requestId)?.querySelector('span[style]')).toBeNull()
  })

  // Rule: docs/areas/web-ui.md § Activity view (reduced motion, motion cost).
  it.each([
    { phase: 'reply', replied: true, title: 'Request', bar: true, dashed: true, fading: false },
    { phase: 'replied', replied: true, title: 'Replied', bar: false, dashed: false, fading: false },
    { phase: 'fade', replied: true, title: 'Replied', bar: false, dashed: true, fading: true },
    { phase: 'fade', replied: false, title: 'Request', bar: true, dashed: true, fading: true },
  ] as const)('draws phase $phase with replied=$replied', ({ phase, replied, title, bar, dashed, fading }) => {
    const peer = request({ senderRunId: 'a', recipientRunId: 'b', text: 'Review the API?' })
    const motion: MotionState = { ...EMPTY_MOTION, closing: { [peer.requestId]: { key: 1, projectId: 'cezarion', request: peer, phase, replied } } }
    renderBoard(project({ tasks: [A, B] }), boxes, motion)
    const el = label(peer.requestId)!
    expect(el.textContent).toBe(`${title}4:10Review the API?`)
    expect(el.querySelector('span[style]') !== null).toBe(bar)
    expect(el.classList.contains('activity-line-out')).toBe(fading)
    const line = document.querySelector(`path[data-request="${peer.requestId}"]`)!
    expect(line.getAttribute('data-phase')).toBe(phase)
    expect(line.getAttribute('stroke-dasharray')).toBe(dashed ? '6 5' : null)
    expect(line.classList.contains('activity-line-out')).toBe(fading)
    expect(line.classList.contains('activity-march')).toBe(phase === 'reply')
  })

  it('fit the 96 px column gap and never cover a card', () => {
    const boxes: Record<string, Box> = {
      a: { x: col(0), y: 0, w: 300, h: 160 },
      b: { x: col(1), y: 0, w: 300, h: 160 },
      c: { x: col(0), y: 220, w: 300, h: 160 },
      d: { x: col(2), y: 0, w: 300, h: 160 },
      e: { x: col(2), y: 220, w: 300, h: 160 },
    }
    const E = run({ runId: 'e', title: 'Draft report' })
    const requests = [
      request({ senderRunId: 'a', recipientRunId: 'b' }), // adjacent columns
      request({ senderRunId: 'b', recipientRunId: 'a' }), // the same pair, back
      request({ senderRunId: 'a', recipientRunId: 'c' }), // one column: bows right
      request({ senderRunId: 'd', recipientRunId: 'e' }), // the last column: bows left
      request({ senderRunId: 'e', recipientRunId: 'gone', recipientTitle: 'Old task' }), // not on the view
      request({ senderRunId: 'a', recipientRunId: 'd' }), // across the middle column
    ]
    renderBoard(project({ tasks: [A, B, C, D, E], requests }), boxes)
    const labels = Array.from(document.querySelectorAll('[data-slot="activity-line-label"]')) as HTMLElement[]
    expect(labels).toHaveLength(requests.length)
    for (const el of labels) {
      expect(el.style.width).toBe(`${PEER_LABEL.w}px`)
      const box = labelBox(el, PEER_LABEL)
      for (const [id, card] of Object.entries(boxes)) expect({ label: el.dataset.request, card: id, overlaps: overlaps(box, card) }).toEqual({ label: el.dataset.request, card: id, overlaps: false })
    }
    expect(PEER_LABEL.w).toBeLessThanOrEqual(96 - 8)
  })
})
