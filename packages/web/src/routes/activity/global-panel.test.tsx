import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityProject } from '@open-mercato/cezar-api-client/contract/activity'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, TOOL_STATUS, iso, project, request, run, worker } from './activity.testkit'
import { ARC_LABEL } from './global-arcs'
import { ProjectPanel } from './global-panel'
import { gridBoxes, inside, labelBox, overlaps, placeBoxes, samplePath } from './line-layout.testkit'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPanel(value: ActivityProject) {
  return render(
    <MemoryRouter initialEntries={['/activity']}>
      <ProjectPanel project={value} now={NOW} />
    </MemoryRouter>,
  )
}

/** Focusable in tab order: a link with a target and no negative tabindex. */
const tabbable = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('a[href], button')).filter((el) => el.getAttribute('tabindex') !== '-1')

describe('ProjectPanel', () => {
  it('keeps one compact pill per card with many cards: one line each, every pill a link in tab order', () => {
    const tasks = Array.from({ length: 40 }, (_, i) => run({
      runId: `t${i}`,
      title: `Task ${i}`,
      tool: { title: `Read file-${i}.ts`, toolKind: 'read', status: TOOL_STATUS.running, startedAt: iso(-2_000) },
      workers: [worker({ runId: `t${i}-w` })],
    }))
    const { container } = renderPanel(project({ projectId: 'busy', name: 'busy', tasks }))
    const pills = Array.from(container.querySelectorAll<HTMLElement>('[data-activity-pill]'))
    expect(pills).toHaveLength(40)
    for (const [i, pill] of pills.entries()) {
      expect(pill.querySelectorAll('[data-slot="activity-pill-line"]')).toHaveLength(1)
      expect(pill.querySelector('[data-slot="activity-pill-line"]')?.textContent).toBe(`Doing · Read file-${i}.ts`)
      expect(pill.querySelector('[data-slot="activity-detail"]')).toBeNull()
      expect(within(pill).getByRole('link', { name: `Task ${i}` }).getAttribute('href')).toBe(`/p/busy/tasks/t${i}`)
    }
    // The header link, then one link per pill, in pill order.
    const links = tabbable(container).map((el) => el.getAttribute('href'))
    expect(links).toEqual(['/p/busy/activity', ...tasks.map((task) => `/p/busy/tasks/${task.runId}`)])
  })

  it('reserves room above the pills only when the panel has an arc', () => {
    const a = run({ runId: 'a', title: 'A' })
    const b = run({ runId: 'b', title: 'B' })
    const { container, rerender } = renderPanel(project({ tasks: [a, b] }))
    expect(container.querySelector('[data-slot="activity-arcs"]')).toBeNull()
    const peer = request({ senderRunId: 'a', recipientRunId: 'b' })
    rerender(
      <MemoryRouter initialEntries={['/activity']}>
        <ProjectPanel project={project({ tasks: [a, b], requests: [peer] })} now={NOW} />
      </MemoryRouter>,
    )
    expect(container.querySelector(`path[data-request="${peer.requestId}"]`)?.getAttribute('data-kind')).toBe('peer')
    expect(container.querySelector('[data-slot="activity-arcs"]')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('marks a pill that needs the user, like its card', () => {
    const asks = run({ runId: 'asks', status: RUN_STATUS.waiting, rung: 'needs-you', wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-1_000), detail: { reason: 'turn-end' } } })
    const { container } = renderPanel(project({ tasks: [asks] }))
    const pill = container.querySelector('[data-activity-pill="asks"]') as HTMLElement
    expect(pill.getAttribute('data-action')).toBe('open')
    expect(pill.querySelector('[data-slot="activity-pill-line"]')?.textContent).toBe('Needs you · Your turn')
  })

  describe('arc routing', () => {
    const GRID = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]
    const boxes = gridBoxes(GRID)
    const tasks = GRID.flat().map((id) => run({ runId: id, title: `Task ${id}` }))
    const arcOf = (requestId: string) => document.querySelector(`path[data-request="${requestId}"]`)?.getAttribute('d') ?? ''
    const labelOf = (requestId: string) => document.querySelector(`[data-slot="activity-arc-label"][data-request="${requestId}"]`) as HTMLElement

    it('routes an arc between the first and third rows of one column around the pill between them, label in a gap', () => {
      placeBoxes('data-activity-pill', boxes)
      const down = request({ senderRunId: 'a', recipientRunId: 'g' })
      renderPanel(project({ tasks, requests: [down] }))
      const others = Object.entries(boxes).filter(([id]) => id !== 'a' && id !== 'g').map(([, box]) => box)
      const crossed = samplePath(arcOf(down.requestId)).filter((p) => others.some((box) => inside(p, box)))
      expect(crossed).toEqual([])
      const label = labelBox(labelOf(down.requestId), ARC_LABEL)
      expect(Object.values(boxes).filter((box) => overlaps(label, box))).toEqual([])
    })

    it('gives reciprocal requests their own lane, with labels that do not overlap', () => {
      placeBoxes('data-activity-pill', boxes)
      const there = request({ senderRunId: 'a', recipientRunId: 'b' })
      const back = request({ senderRunId: 'b', recipientRunId: 'a' })
      renderPanel(project({ tasks, requests: [there, back] }))
      expect(arcOf(there.requestId)).not.toBe('')
      expect(arcOf(back.requestId)).not.toBe('')
      expect(arcOf(there.requestId)).not.toBe(arcOf(back.requestId))
      expect(overlaps(labelBox(labelOf(there.requestId), ARC_LABEL), labelBox(labelOf(back.requestId), ARC_LABEL))).toBe(false)
    })

    it('nudges apart the labels of two arcs that land on the same spot', () => {
      const row = gridBoxes([['p', 'q', 'r', 's', 't']])
      placeBoxes('data-activity-pill', row)
      const wide = request({ senderRunId: 'p', recipientRunId: 't' })
      const narrow = request({ senderRunId: 'q', recipientRunId: 's' })
      renderPanel(project({ tasks: ['p', 'q', 'r', 's', 't'].map((id) => run({ runId: id })), requests: [wide, narrow] }))
      expect(overlaps(labelBox(labelOf(wide.requestId), ARC_LABEL), labelBox(labelOf(narrow.requestId), ARC_LABEL))).toBe(false)
    })
  })

  describe('peer waits', () => {
    const waiter = run({
      runId: 'waiter',
      title: 'Schema migration',
      status: RUN_STATUS.waiting,
      rung: 'waiting-on-workers',
      wait: { kind: ACTIVITY_WAIT_KIND.peers, since: iso(-192_000), deadline: iso(408_000), detail: { peerRunIds: ['peer'] } },
    })
    const peer = run({ runId: 'peer', title: 'API contract review' })
    const other = run({ runId: 'other', title: 'Release notes' })
    const pill = (runId: string) => document.querySelector(`[data-activity-pill="${runId}"]`) as HTMLElement
    const waitArc = () => document.querySelector('path[data-wait="wait:waiter:peer"]')

    it('draws a dotted arc from the peer pill to the waiter pill, with its label and room above the pills', () => {
      placeBoxes('data-activity-pill', gridBoxes([['waiter', 'peer', 'other']]))
      renderPanel(project({ tasks: [waiter, peer, other] }))
      expect(waitArc()?.getAttribute('data-kind')).toBe('wait')
      expect(waitArc()?.getAttribute('stroke-dasharray')).toBe('0 8')
      const points = samplePath(waitArc()?.getAttribute('d') ?? '')
      // From the top middle of the peer pill to the top middle of the waiter pill.
      expect(points[0]?.x).toBe(234 + 110)
      expect(points[points.length - 1]?.x).toBe(110)
      expect(document.querySelector('[data-slot="activity-arc-label"][data-wait="wait:waiter:peer"]')?.textContent).toBe('Waiting · 3:12')
    })

    it('gives both pills the text form, and the waiter pill a link for the narrow layout', () => {
      renderPanel(project({ tasks: [waiter, peer] }))
      const text = (runId: string) => Array.from(pill(runId).querySelectorAll('[data-slot="activity-line-text"] li')).map((li) => li.textContent)
      expect(text('waiter')).toEqual(['Waiting for a message from API contract review'])
      expect(text('peer')).toEqual(['Schema migration waits for you to write'])
      expect(within(pill('waiter')).getByRole('link', { name: '⋯ waits on API contract review' }).getAttribute('href')).toBe('/p/cezarion/tasks/peer')
    })

    it('outlines the linked pill while the pointer is on the other one', () => {
      renderPanel(project({ tasks: [waiter, peer, other] }))
      fireEvent.pointerEnter(pill('waiter'))
      expect(pill('peer').getAttribute('data-linked')).toBe('true')
      expect(pill('other').getAttribute('data-linked')).toBeNull()
      expect(waitArc()?.getAttribute('data-active')).toBe('true')
      fireEvent.pointerLeave(pill('waiter'))
      expect(pill('peer').getAttribute('data-linked')).toBeNull()
    })
  })
})
