import { cleanup, render, within } from '@testing-library/react'
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
    expect(pill.className).toContain('border-pending')
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
  })
})
