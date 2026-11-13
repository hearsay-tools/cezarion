import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityProject } from '@open-mercato/cezar-api-client/contract/activity'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, TOOL_STATUS, iso, project, request, run, worker } from './activity.testkit'
import { ActivityBoard } from './activity-board'
import { PEER_LABEL } from './line-measure'
import { inside, labelBox, overlaps, placeBoxes, samplePath } from './line-layout.testkit'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The graph's width decides the columns; jsdom lays nothing out, so a test sets it. */
function setGraphWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
}

function renderBoard(value: ActivityProject) {
  return render(
    <MemoryRouter initialEntries={['/p/cezarion/activity']}>
      <ActivityBoard project={value} now={NOW} watchingSince={iso(-60_000)} />
    </MemoryRouter>,
  )
}

const card = (runId: string) => document.querySelector(`[data-activity-card="${runId}"]`) as HTMLElement
const lineText = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-slot="activity-line-text"] li')).map((li) => li.textContent)

const A = run({ runId: 'task-a', title: 'Porting upstream SSE' })
const B = run({ runId: 'task-b', title: 'Implementing worker spawn' })
const W = worker({ runId: 'worker-w', title: 'Draft top-5 report', status: RUN_STATUS.waiting, rung: 'waiting-on-workers' })
const PARENT = run({ runId: 'task-p', title: 'Coordinating friction digest', status: RUN_STATUS.waiting, rung: 'waiting-on-workers', workers: [W] })
const PEER = request({ senderRunId: 'task-a', recipientRunId: 'task-b' })
const FAMILY = request({ relationship: 'family', senderRunId: 'worker-w', recipientRunId: 'task-p', text: 'Keep 5 cards or show 7?', deadline: undefined, createdAt: iso(-130_000) })

describe('ActivityBoard', () => {
  it('makes each card a link to its task', () => {
    renderBoard(project({ tasks: [A, B] }))
    expect(within(card('task-a')).getByRole('link', { name: 'Porting upstream SSE' }).getAttribute('href')).toBe('/p/cezarion/tasks/task-a')
  })

  it('gives each card the text form of its lines, in both directions', () => {
    renderBoard(project({ tasks: [A, B, PARENT], requests: [PEER, FAMILY] }))
    expect(lineText(card('task-a'))).toEqual(['Waiting for a reply from Implementing worker spawn'])
    expect(lineText(card('task-b'))).toEqual(['Porting upstream SSE waits for your reply'])
    const row = card('task-p').querySelector('[data-run="worker-w"]') as HTMLElement
    expect(lineText(row)).toEqual(['Waiting for a reply from Coordinating friction digest'])
    // The parent's own text names the worker; the worker row's text is not counted twice.
    expect(Array.from(card('task-p').querySelectorAll(':scope > [data-slot="activity-line-text"] li')).map((li) => li.textContent))
      .toEqual(['Draft top-5 report waits for your reply'])
  })

  it('names a task the snapshot cannot read by the request title, else as unreadable', () => {
    renderBoard(project({ tasks: [A], requests: [request({ senderRunId: 'task-a', recipientRunId: 'gone', recipientTitle: 'Old task' }), request({ senderRunId: 'gone-2', recipientRunId: 'task-a' })] }))
    expect(lineText(card('task-a'))).toEqual(['Waiting for a reply from Old task', 'Unreadable task waits for your reply'])
  })

  it('tints a worker that asks its parent, and draws the family line in the card margin', () => {
    setGraphWidth(1200)
    renderBoard(project({ tasks: [PARENT], requests: [FAMILY] }))
    const row = card('task-p').querySelector('[data-run="worker-w"]') as HTMLElement
    expect(row.getAttribute('data-asks')).toBe('true')
    expect(row.textContent).toContain('Asks parent')
    expect(document.querySelector(`path[data-request="${FAMILY.requestId}"]`)?.getAttribute('data-kind')).toBe('family')
  })

  it('draws a peer line with its label when the graph has several columns', () => {
    setGraphWidth(1200)
    renderBoard(project({ tasks: [A, B], requests: [PEER] }))
    expect(document.querySelector('[data-slot="activity-graph"]')?.getAttribute('data-columns')).toBe('3')
    expect(document.querySelector(`path[data-request="${PEER.requestId}"]`)?.getAttribute('data-kind')).toBe('peer')
    const label = document.querySelector(`[data-slot="activity-line-label"][data-request="${PEER.requestId}"]`)
    expect(label?.textContent).toMatch(/^Request4:10/)
    expect(label?.textContent).toContain('Does spawn.ts still own the…')
    expect(within(card('task-a')).queryByRole('link', { name: /^→/ })).toBeNull()
  })

  it('ends a line at the card that remains, named after the task that left the view', () => {
    setGraphWidth(1200)
    renderBoard(project({ tasks: [A], requests: [request({ senderRunId: 'task-a', recipientRunId: 'gone', recipientTitle: 'Old task' })] }))
    expect(document.querySelector('[data-slot="activity-line-label"]')?.textContent).toContain('Old task')
  })

  it('routes a peer line between non-adjacent columns around the cards of the column between them', () => {
    setGraphWidth(1200)
    const M = run({ runId: 'task-m', title: 'Middle' })
    const middle = { x: 396, y: 0, w: 300, h: 300 }
    placeBoxes('data-activity-card', { 'task-a': { x: 0, y: 0, w: 300, h: 120 }, 'task-m': middle, 'task-b': { x: 792, y: 0, w: 300, h: 120 } })
    renderBoard(project({ tasks: [A, M, B], requests: [PEER] }))
    expect(Array.from(document.querySelectorAll('[data-slot="activity-column"]')).map((column) => column.querySelector('[data-activity-card]')?.getAttribute('data-activity-card'))).toEqual(['task-a', 'task-m', 'task-b'])
    const d = document.querySelector(`path[data-request="${PEER.requestId}"]`)?.getAttribute('d') ?? ''
    expect(samplePath(d).filter((p) => inside(p, middle))).toEqual([])
    // The channel runs below the middle card, never above the graph's top edge.
    expect(Math.min(...samplePath(d).map((p) => p.y))).toBeGreaterThanOrEqual(0)
  })

  it('gives reciprocal peer requests their own lane, with labels that do not overlap', () => {
    setGraphWidth(1200)
    placeBoxes('data-activity-card', { 'task-a': { x: 0, y: 0, w: 300, h: 160 }, 'task-b': { x: 396, y: 0, w: 300, h: 160 } })
    const BACK = request({ senderRunId: 'task-b', recipientRunId: 'task-a' })
    renderBoard(project({ tasks: [A, B], requests: [PEER, BACK] }))
    const path = (id: string) => document.querySelector(`path[data-request="${id}"]`)?.getAttribute('d')
    expect(path(PEER.requestId)).not.toBe(path(BACK.requestId))
    const label = (id: string) => labelBox(document.querySelector(`[data-slot="activity-line-label"][data-request="${id}"]`) as Element, PEER_LABEL)
    expect(overlaps(label(PEER.requestId), label(BACK.requestId))).toBe(false)
  })

  it('turns peer lines into "→ <task>" links on the sender card in one column', () => {
    setGraphWidth(500)
    renderBoard(project({ tasks: [A, B], requests: [PEER] }))
    expect(document.querySelector('[data-slot="activity-graph"]')?.getAttribute('data-columns')).toBe('1')
    expect(document.querySelector('path[data-kind="peer"]')).toBeNull()
    expect(within(card('task-a')).getByRole('link', { name: '→ Implementing worker spawn' }).getAttribute('href')).toBe('/p/cezarion/tasks/task-b')
    expect(within(card('task-b')).queryByRole('link', { name: /^→/ })).toBeNull()
  })

  it('keeps the family line inside a card in one column', () => {
    setGraphWidth(500)
    renderBoard(project({ tasks: [PARENT], requests: [FAMILY] }))
    expect(document.querySelector('[data-slot="activity-graph"]')?.getAttribute('data-columns')).toBe('1')
    expect(document.querySelector(`path[data-request="${FAMILY.requestId}"]`)?.getAttribute('data-kind')).toBe('family')
  })

  it('folds settled workers into the finished count and keeps a review worker as a row', () => {
    const root = run({ runId: 'root', workers: [
      worker({ runId: 'w-live' }),
      worker({ runId: 'w-review', status: RUN_STATUS.review, rung: 'needs-review' }),
      worker({ runId: 'w-done', status: RUN_STATUS.done, rung: 'done' }),
      worker({ runId: 'w-failed', status: RUN_STATUS.failed, rung: 'failed', error: 'boom' }),
    ] })
    renderBoard(project({ tasks: [root] }))
    const rows = Array.from(card('root').querySelectorAll('[data-slot="activity-worker"]')).map((row) => row.getAttribute('data-run'))
    expect(rows).toEqual(['w-live', 'w-review'])
    expect(card('root').querySelector('[data-slot="activity-finished"]')?.textContent).toBe('✓ 2 finished · 1 failed')
  })

  it('shows the Answer button for a question and Open task for a plain turn end', () => {
    const asks = run({ runId: 'asks', status: RUN_STATUS.waiting, rung: 'needs-you', wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-60_000), detail: { reason: 'question', question: 'Ship it?' } } })
    const turn = run({ runId: 'turn', status: RUN_STATUS.waiting, rung: 'needs-you', wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-60_000), detail: { reason: 'turn-end' } } })
    renderBoard(project({ tasks: [asks, turn] }))
    expect(within(card('asks')).getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe('/p/cezarion/tasks/asks')
    expect(within(card('turn')).getByRole('link', { name: 'Open task' })).toBeTruthy()
  })

  it('reads the check segments out as a summary of passed, failed and pending checks', () => {
    const ci = run({ runId: 'ci', status: RUN_STATUS.waiting, rung: 'waiting-for-ci', wait: { kind: ACTIVITY_WAIT_KIND.pr, since: iso(-1_000), deadline: iso(900_000), detail: {
      number: 7, target: 'checks', checks: [{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'fail' }, { name: 'c', bucket: 'pending' }], counts: { pass: 1, fail: 1, pending: 1, skipping: 0, cancel: 0 },
    } } })
    renderBoard(project({ tasks: [ci] }))
    expect(card('ci').querySelector('[data-slot="activity-checks"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(card('ci').querySelector('[data-slot="activity-checks-summary"]')?.textContent).toBe('1 passed, 1 failed, 1 pending')
  })

  describe('dense mode', () => {
    const cards = (n: number) => Array.from({ length: n }, (_, i) => run({
      runId: `t${i}`,
      title: `Task ${i}`,
      tool: { title: 'Read file.ts', toolKind: 'read', status: TOOL_STATUS.running, startedAt: iso(-2_000) },
      workers: [worker({ runId: `t${i}-w` })],
    }))

    it('keeps the detail line and worker rows at 12 cards', () => {
      renderBoard(project({ tasks: cards(12) }))
      expect(document.querySelector('[data-slot="activity-graph"]')?.hasAttribute('data-dense')).toBe(false)
      expect(document.querySelectorAll('[data-slot="activity-detail"]')).toHaveLength(12)
      expect(document.querySelectorAll('[data-slot="activity-worker"]')).toHaveLength(12)
    })

    it('drops the detail line and folds workers into dots at 13 cards; the heartbeat stays', () => {
      renderBoard(project({ tasks: cards(13) }))
      expect(document.querySelector('[data-slot="activity-graph"]')?.getAttribute('data-dense')).toBe('true')
      expect(document.querySelectorAll('[data-slot="activity-detail"]')).toHaveLength(0)
      expect(document.querySelectorAll('[data-slot="activity-worker"]')).toHaveLength(0)
      expect(document.querySelectorAll('[data-slot="activity-worker-dots"]')).toHaveLength(13)
      expect(document.querySelectorAll('[data-slot="activity-heartbeat"]').length).toBeGreaterThanOrEqual(13)
    })
  })

  describe('the rail', () => {
    it('says no task waits for a reply, and watches from the time the view opened', () => {
      renderBoard(project({ tasks: [A] }))
      const rail = screen.getByRole('complementary', { name: 'Activity details' })
      expect(within(rail).getByText('No task waits for a reply.')).toBeTruthy()
      expect(rail.querySelector('[data-slot="activity-just-now"]')?.textContent).toMatch(/Watching since \d{2}:\d{2}/)
    })

    it('says a request is overdue once its reply deadline passes', () => {
      const late = request({ senderRunId: 'task-a', recipientRunId: 'task-b', createdAt: iso(-700_000), deadline: iso(-100_000) })
      renderBoard(project({ tasks: [A, B], requests: [late] }))
      const entry = document.querySelector('[data-slot="activity-request"]')?.textContent ?? ''
      expect(entry).toContain('reply overdue')
      expect(entry).not.toContain('reply due in')
    })

    it('lists each open request with its age and, when it has one, its reply deadline', () => {
      renderBoard(project({ tasks: [A, B, PARENT], requests: [PEER, FAMILY] }))
      const entries = Array.from(document.querySelectorAll('[data-slot="activity-request"]')) as HTMLElement[]
      expect(entries.map((entry) => entry.textContent)).toEqual([
        expect.stringMatching(/^Porting upstream SSE.*Implementing worker spawnRequest.*Peer · open 4:10reply due in 5:50$/),
        expect.stringMatching(/^Draft top-5 report.*Coordinating friction digestQuestion“Keep 5 cards or show 7\?”Worker → parent · open 2:10$/),
      ])
    })
  })
})
