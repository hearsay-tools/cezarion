import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunEvent, StepState, WorkerInspection } from '@open-mercato/cezar-api-client'

import { RunActivityDock } from './run-activity-dock'
import { reduceThread } from './thread-state'

/**
 * The unified Run activity accordion (#402, mockups `pasted-1..3.png`): ONE card above the
 * composer whose rows are the sections — workflow, subagents, workers, plan — each an
 * icon + bold title + muted meta + chevron, with the section's own list nested under it.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const at = '2026-09-06T00:00:00.000Z'
const parentId = '10000000-0000-4000-8000-000000000001'
const doneWorkerId = '10000000-0000-4000-8000-000000000002'
const cancelledWorkerId = '10000000-0000-4000-8000-000000000003'
const workspace = {
  ownerRunId: doneWorkerId,
  resourceId: doneWorkerId,
  kind: 'owned-isolated' as const,
  path: '/managed/worker',
  branch: 'cez/worker',
  baselineSha: 'a'.repeat(40),
}
const workers: WorkerInspection[] = [
  { workerId: doneWorkerId, parentRunId: parentId, status: 'done', workspace },
  { workerId: cancelledWorkerId, parentRunId: parentId, status: 'cancelled', workspace },
]

const steps: StepState[] = [
  { id: 'task', name: 'Do the task', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 },
  { id: 'verify', name: 'Verify', kind: 'check', status: 'pending', iterations: 1, tokensUsed: 0 },
]

const run = (extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: parentId,
    title: 'Parent',
    task: 'Do task',
    workflow: 'quick-task',
    status: 'running',
    createdAt: at,
    tokensUsed: 0,
    archived: false,
    steps,
    ...extra,
  }) as ApiRun

const line = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: at, type, ...rest }) as RunEvent

/** One completed sub-agent, one still running, and a three-item plan. */
const EVENTS: RunEvent[] = [
  line(1, 'turn.started', { turnId: 'turn_1' }),
  line(2, 'item.completed', {
    item: { kind: 'tool', id: 'task_1', name: 'Task', toolKind: 'task', title: 'Audit the auth flow', status: 'completed' },
  }),
  line(3, 'item.completed', {
    item: { kind: 'tool', id: 'task_2', name: 'Task', toolKind: 'task', title: 'Review the store layer', status: 'running' },
  }),
  line(4, 'plan.updated', {
    entries: [
      { content: 'Read the docs', status: 'completed' },
      { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
      { content: 'Reply', status: 'pending' },
    ],
  }),
]

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

function renderDock(record: ApiRun, events: RunEvent[] = EVENTS, linked: WorkerInspection[] = workers) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/relationships')) return json({ workers: linked })
      if (path.endsWith('/runs')) {
        return json([
          { ...run({ id: doneWorkerId, title: 'auditing stale roles', status: 'done' }) },
          { ...run({ id: cancelledWorkerId, title: 'lightweight VM preset', status: 'cancelled' }) },
        ])
      }
      return json({})
    }),
  )
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(
    <QueryClientProvider client={client}>
      <ProjectScopeProvider projectId="sample">
        <MemoryRouter initialEntries={[`/p/sample/tasks/${record.id}`]}>
          <RunActivityDock run={record} currentThread={reduceThread(events)} />
        </MemoryRouter>
      </ProjectScopeProvider>
    </QueryClientProvider>,
  )
}

const section = (key: string) => document.querySelector<HTMLElement>(`[data-slot="run-activity-${key}"]`)
const sectionHead = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-slot="run-activity-${key}"] > button`)!
const metaOf = (key: string) =>
  document.querySelector(`[data-slot="run-activity-${key}"] [data-slot="run-activity-meta"]`)?.textContent

describe('RunActivityDock — one card, one row per section', () => {
  it('titles each row and meters it, workflow by its current step name', () => {
    renderDock(run())

    expect(sectionHead('workflow').textContent).toContain('Do the task')
    expect(metaOf('workflow')).toBe('Step 1 of 2')
    expect(sectionHead('subagents').textContent).toContain('Subagents')
    expect(metaOf('subagents')).toBe('1 of 2 complete')
    expect(sectionHead('plan').textContent).toContain('Plan')
    expect(metaOf('plan')).toBe('1 of 3 complete')
  })

  it('nests the workflow, subagent and plan rows closed, and opening one leaves its siblings closed', () => {
    renderDock(run())
    expect(document.querySelectorAll('[data-slot="agent-item"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-slot="plan-item"]')).toHaveLength(0)

    fireEvent.click(sectionHead('subagents'))

    expect(sectionHead('subagents').getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelectorAll('[data-slot="agent-item"]')).toHaveLength(2)
    expect(sectionHead('plan').getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelectorAll('[data-slot="plan-item"]')).toHaveLength(0)
  })

  it('keeps every row a 44px touch target', () => {
    renderDock(run())
    for (const key of ['workflow', 'subagents', 'plan']) {
      expect(sectionHead(key).className).toContain('min-h-11')
    }
  })

  it('omits a section with nothing to show', () => {
    renderDock(run({ steps: [] }), [EVENTS[0]!])
    expect(section('workflow')).toBeNull()
    expect(section('subagents')).toBeNull()
    expect(section('plan')).toBeNull()
    expect(document.querySelector('[data-slot="run-activity-dock"]')).toBeNull()
  })
})

describe('RunActivityDock — the workers section', () => {
  const root = run({ delegation: { role: 'root', permissions: [], receipts: [] } } as Partial<ApiRun>)

  // Open by default, unlike its sibling sections: the header panel it replaced listed the
  // worker links without a click on desktop, and losing that would make a parked parent's
  // workers reachable only by guessing which row hides them.
  it('meters the linked workers and lists each with its status and a jump link', async () => {
    renderDock(root)

    await waitFor(() => expect(metaOf('workers')).toBe('2 linked · 1 done · 1 cancelled'))
    expect(sectionHead('workers').textContent).toContain('Workers')
    expect(sectionHead('workers').getAttribute('aria-expanded')).toBe('true')

    const rows = Array.from(document.querySelectorAll('[data-slot="worker-item"]'))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('auditing stale roles')
    expect(rows[0]!.textContent?.toLowerCase()).toContain('done')
    expect(rows[1]!.textContent?.toLowerCase()).toContain('cancelled')
    expect(screen.getByRole('link', { name: `Worker task ${doneWorkerId}` }).getAttribute('href')).toBe(
      `/p/sample/tasks/${doneWorkerId}`,
    )
  })

  it('keeps the parent link for a worker-role run', async () => {
    renderDock(
      run({
        id: doneWorkerId,
        delegation: { role: 'worker', permissions: [], parentRunId: parentId, workspace },
      } as Partial<ApiRun>),
    )
    expect(await screen.findByRole('link', { name: `Parent task ${parentId}` })).toBeTruthy()
  })

  it('closes on a click, like every other section', async () => {
    renderDock(root)
    await waitFor(() => expect(document.querySelectorAll('[data-slot="worker-item"]')).toHaveLength(2))
    fireEvent.click(sectionHead('workers'))
    expect(document.querySelectorAll('[data-slot="worker-item"]')).toHaveLength(0)
  })

  it('never mounts a workers section for an ordinary run', () => {
    renderDock(run())
    expect(section('workers')).toBeNull()
  })
})

describe('RunActivityDock — narrow viewports', () => {
  const narrow = () =>
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))

  it('collapses to the single status row the phone mockup shows', () => {
    narrow()
    renderDock(run())
    expect(document.querySelector('[data-slot="run-activity-dock"]')?.getAttribute('data-state')).toBe('collapsed')
    expect(document.querySelector('[data-slot="run-activity-count"]')?.textContent).toContain('3 sections')
    expect(section('workflow')).toBeNull()
  })

  it('shortens each row meta to the odometer once expanded', () => {
    narrow()
    renderDock(run())
    fireEvent.click(screen.getByRole('button', { name: /Run activity/ }))
    expect(metaOf('workflow')).toBe('1 / 2')
    expect(metaOf('subagents')).toBe('1 / 2')
    expect(metaOf('plan')).toBe('1 / 3')
  })
})

describe('RunActivityDock — the workflow glyph', () => {
  const step = (status: StepState['status']): StepState[] => [
    { id: 'task', name: 'Do the task', kind: 'agent', status, iterations: 1, tokensUsed: 0 },
  ]
  const glyph = () =>
    document
      .querySelector('[data-slot="run-activity-workflow"] > button [data-slot="workflow-glyph"]')
      ?.getAttribute('data-visual')

  // The row's glyph and the rail it opens speak for the same step, so they must never
  // disagree: a check mark on an unstarted or failed workflow reads as "this went fine".
  it.each([
    ['done', 'done'],
    ['running', 'active'],
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
  ] as const)('renders the rail visual for a %s step, not a check mark', (status, visual) => {
    renderDock(run({ status: 'done', steps: step(status) }))
    expect(glyph()).toBe(visual)
  })
})


describe('RunActivityDock — workers and the All complete claim', () => {
  const settled: StepState[] = [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }]
  // Its own run id: the dock's collapse memory is module-level and per run, so sharing `parentId`
  // with the test that clicks the Workers section shut would render this block's rows closed.
  const rootId = '10000000-0000-4000-8000-000000000004'
  const root = (extra: Partial<ApiRun> = {}) =>
    run({ id: rootId, status: 'done', steps: settled, delegation: { role: 'root', permissions: [], receipts: [] }, ...extra } as Partial<ApiRun>)
  const statusText = () => document.querySelector('[data-slot="run-activity-status"]')?.textContent
  const allDone: WorkerInspection[] = [{ workerId: doneWorkerId, parentRunId: parentId, status: 'done', workspace }]
  /** A spawn receipt outlives a failed lookup, so the dock must judge its worker too. */
  const receipt = (workerId: string) => ({
    requestId: '20000000-0000-4000-8000-000000000001',
    workerId,
    requestHash: 'b'.repeat(64),
  })

  // The header speaks for every section it counts, Workers included: a finished parent whose
  // worker failed or is still going has not "all completed".
  it.each(['running', 'waiting', 'review', 'failed'] as const)(
    'never claims completion while a linked worker is %s',
    async (status) => {
      renderDock(root(), [], [{ workerId: doneWorkerId, parentRunId: parentId, status, workspace }])
      await waitFor(() => expect(document.querySelectorAll('[data-slot="worker-item"]')).toHaveLength(1))
      expect(statusText()).not.toContain('All complete')
    },
  )

  // A cancelled worker is a decision, not an unfinished job: someone stopped it and the run
  // went on to finish. `planCounts` already leaves cancelled entries out of its total for the
  // same reason, and a done parent whose only oddity was a cancelled worker used to sit on
  // "In progress" forever (#402 feedback).
  it('counts a cancelled worker as complete', async () => {
    renderDock(root(), [], [
      { workerId: doneWorkerId, parentRunId: parentId, status: 'done', workspace },
      { workerId: cancelledWorkerId, parentRunId: parentId, status: 'cancelled', workspace },
    ])
    await waitFor(() => expect(statusText()).toContain('All complete'))
  })

  // The other half of the same defect: when the run is over, the header reports an OUTCOME.
  // Withholding the green line is right; calling a finished run "In progress" is not.
  it('names a finished run with a failed worker as finished, not in progress', async () => {
    renderDock(root(), [], [{ workerId: doneWorkerId, parentRunId: parentId, status: 'failed', workspace }])
    await waitFor(() => expect(statusText()).toContain('Incomplete'))
    expect(statusText()).not.toContain('In progress')
    expect(statusText()).not.toContain('All complete')
  })

  // ...and a worker that really is still going keeps the progress wording, because it is true.
  it('still says in progress while a linked worker runs on', async () => {
    renderDock(root(), [], [{ workerId: doneWorkerId, parentRunId: parentId, status: 'running', workspace }])
    await waitFor(() => expect(document.querySelectorAll('[data-slot="worker-item"]')).toHaveLength(1))
    expect(statusText()).toContain('In progress')
  })

  // An unresolved lookup is not an issue with the run: until it lands the dock knows nothing
  // about the workers, so it may claim neither completion nor a bad outcome.
  it('does not call a pending lookup an issue', () => {
    renderDock(root(), [], allDone)
    expect(statusText()).toContain('In progress')
    expect(statusText()).not.toContain('Incomplete')
  })

  it('drops the cleanup line from a worker whose teardown left nothing behind', async () => {
    renderDock(root(), [], [
      { workerId: doneWorkerId, parentRunId: parentId, status: 'done', workspace, destroy: { requestedAt: at, phase: 'complete', remaining: [] } },
    ])
    await waitFor(() => expect(document.querySelectorAll('[data-slot="worker-item"]')).toHaveLength(1))
    expect(document.querySelector('[data-slot="run-activity-workers"]')?.textContent).not.toContain('Cleanup')
  })

  it('claims completion once every linked worker is done', async () => {
    renderDock(root(), [], allDone)
    await waitFor(() => expect(statusText()).toContain('All complete'))
  })

  // Unknown is not complete: saying so before the lookup lands makes the line flip under the
  // reader, and a receipt whose inspection never arrives is a worker we cannot vouch for.
  it('waits for the relationships lookup rather than guessing', () => {
    renderDock(root(), [], allDone)
    expect(statusText()).not.toContain('All complete')
  })

  it('never claims completion for a receipt with no inspection behind it', async () => {
    renderDock(root({ delegation: { role: 'root', permissions: [], receipts: [receipt(cancelledWorkerId)] } } as Partial<ApiRun>), [], allDone)
    await waitFor(() => expect(document.querySelectorAll('[data-slot="worker-item"]')).toHaveLength(2))
    expect(statusText()).not.toContain('All complete')
  })

  it('leaves an ordinary run without delegation alone', () => {
    renderDock(run({ status: 'done', steps: settled }), [])
    expect(statusText()).toContain('All complete')
  })
})
