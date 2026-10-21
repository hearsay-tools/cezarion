import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunEvent, StepState, WorkerInspection } from '@open-mercato/cezar-api-client'

import { RunActivityDock, resetActivityDisclosureForTests } from './run-activity-dock'
import { reduceThread } from './thread-state'

/**
 * The unified Session activity accordion (#402, mockups `pasted-1..3.png`): ONE card above the
 * composer whose rows are the sections — workflow, subagents, workers, plan — each an
 * icon + bold title + muted meta + chevron, with the section's own list nested under it.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetActivityDisclosureForTests()
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

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function renderDock(
  record: ApiRun,
  events: RunEvent[] = EVENTS,
  linked: WorkerInspection[] = workers,
  relationships: 'ok' | 'error' = 'ok',
  overrides: Record<string, () => Response> = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace('?archived=recent', '')
      const override = overrides[path]
      if (override) return override()
      if (path.endsWith('/relationships')) {
        return relationships === 'error' ? json({ error: 'offline' }, 503) : json({ workers: linked })
      }
      if (path.endsWith('/run-summaries')) {
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
    expect(metaOf('workflow')).toBe('Do the task · Step 1 of 2')
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

  it('shows an unsettled subagent as stalled during a usage-limit hold, which has no session', () => {
    // hearsay-tools/cezarion#1236: a hold is `waiting` with no live session, so nothing will settle
    // the row until the resume; it must not pulse as live.
    renderDock(run({ status: 'waiting', autoResumeAt: '2099-01-01T00:00:00.000Z' }))
    fireEvent.click(sectionHead('subagents'))
    expect(document.querySelectorAll('[data-slot="agent-item"] [data-stalled="true"]')).toHaveLength(1)
  })

  it('keeps an unsettled subagent live while a waiting run holds its session', () => {
    renderDock(run({ status: 'waiting' }))
    fireEvent.click(sectionHead('subagents'))
    expect(document.querySelectorAll('[data-slot="agent-item"] [data-stalled="true"]')).toHaveLength(0)
  })

  it('keeps every row a 44px touch target', () => {
    renderDock(run())
    for (const key of ['workflow', 'subagents', 'plan']) {
      expect(sectionHead(key).className).toContain('min-h-11')
    }
  })

  it('omits a section with nothing to show, but keeps the card for the status and metadata', () => {
    renderDock(run({ steps: [] }), [EVENTS[0]!])
    expect(metaOf('workflow')).toBeUndefined()
    expect(section('subagents')).toBeNull()
    expect(section('plan')).toBeNull()
    expect(section('workspace')).toBeNull()
    expect(document.querySelector('[data-slot="run-activity-dock"]')).not.toBeNull()
  })
})

// The card remembers per run id which rows a reader opened, in module-level Maps that outlive a
// test (hearsay-tools/cezarion#1358). Vitest runs these two cases in order on the shared fixture
// id: without the reset in this file's afterEach, the first one's clicks set the second one's
// starting state.
describe('RunActivityDock — open rows never leak into the next test', () => {
  const dockState = () => document.querySelector('[data-slot="run-activity-dock"]')?.getAttribute('data-state')

  it('opens the workflow row, then closes the card', () => {
    renderDock(run())
    fireEvent.click(sectionHead('workflow'))
    expect(sectionHead('workflow').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /^Session activity/ }))
    expect(dockState()).toBe('collapsed')
  })

  it('starts the next test with the card open and the workflow row closed', () => {
    renderDock(run())
    expect(dockState()).toBe('open')
    expect(sectionHead('workflow').getAttribute('aria-expanded')).toBe('false')
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

  it.each([
    ['ordinary', undefined],
    ['invalid delegation', { role: 'invalid' }],
  ] as const)('never mounts or fetches workers for an %s run', async (_label, delegation) => {
    await act(async () => { renderDock(run({ delegation })) })
    expect(section('workers')).toBeNull()
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).replace('?archived=recent', '').endsWith('/relationships'))).toEqual([])
  })
})

describe('RunActivityDock — narrow viewports', () => {
  const narrow = () =>
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))

  it('collapses to the single status row the phone mockup shows', () => {
    narrow()
    renderDock(run())
    expect(document.querySelector('[data-slot="run-activity-dock"]')?.getAttribute('data-state')).toBe('collapsed')
    expect(document.querySelector('[data-slot="run-activity-status"]')?.textContent).toBe('Running')
    expect(section('workflow')).toBeNull()
  })

  it('shortens each row meta to the odometer once expanded', () => {
    narrow()
    renderDock(run())
    fireEvent.click(screen.getByRole('button', { name: /^Session activity/ }))
    expect(metaOf('workflow')).toBe('Do the task · 1 / 2')
    expect(metaOf('subagents')).toBe('1 / 2')
    expect(metaOf('plan')).toBe('1 / 3')
  })

  it('keeps the step meter whole and lets the step name drop when the row runs out of room', () => {
    narrow()
    renderDock(run())
    fireEvent.click(screen.getByRole('button', { name: /^Session activity/ }))
    const meta = section('workflow')!.querySelector('[data-slot="run-activity-meta"]')!
    expect(meta.querySelector('[data-slot="run-activity-meta-keep"]')?.textContent).toBe('1 / 2')
    expect(meta.querySelector('[data-slot="run-activity-meta-drop"]')?.textContent).toBe('Do the task ·')
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
  const root = (extra: Partial<ApiRun> = {}) =>
    run({ status: 'done', steps: settled, delegation: { role: 'root', permissions: [], receipts: [] }, ...extra } as Partial<ApiRun>)
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
    expect(statusText()).not.toContain('Workers unavailable')
  })

  // A lookup that FAILED is not a lookup still running: nothing further arrives on its own,
  // so "In progress" outlives the run. The header says what it cannot see instead of
  // inventing either verdict — `Incomplete` would blame the run for a fetch that fell over.
  it('names a finished run whose worker lookup failed, rather than claiming progress', async () => {
    renderDock(root(), [], allDone, 'error')
    await waitFor(() => expect(statusText()).toContain('Workers unavailable'))
    expect(statusText()).not.toContain('In progress')
    expect(statusText()).not.toContain('All complete')
  })

  it('keeps the progress wording when the failed lookup belongs to a live run', async () => {
    renderDock(root({ status: 'running' } as Partial<ApiRun>), [], allDone, 'error')
    await waitFor(() => expect(document.querySelector('[data-slot="run-activity-workers"]')).not.toBeNull())
    expect(statusText()).toContain('Running')
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

describe('Session activity — status, usage and workspace (#1333)', () => {
  type CiEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'ci' }>
  type TimerEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'timer' }>
  const ciEntry: CiEntry = {
    id: '00000000-0000-4000-8000-000000000474', kind: 'ci', source: 'agent', via: 'cezar_wait',
    generation: 'session-1', turnId: 'turn-1', timeoutSeconds: 1800,
    prUrl: 'https://github.com/owner/repo/pull/474', repository: 'owner/repo', prNumber: 474,
    headSha: '123456789abcdef', registeredAt: at, deadline: '2026-09-06T00:30:00.000Z', phase: 'open',
  }
  const timerEntry: TimerEntry = {
    id: '00000000-0000-4000-8000-000000000005', kind: 'timer', source: 'agent', via: 'cezar_wait',
    turnId: 'turn-1', seconds: 300, registeredAt: at, deadline: '2026-09-06T00:05:00.000Z', phase: 'open',
  }
  // Module-level disclosure memory is keyed by run id, so every case gets its own run.
  let seq = 0
  const fresh = (extra: Partial<ApiRun> = {}) => run({ id: `10000000-0000-4000-8000-1333${String(++seq).padStart(8, '0')}`, ...extra })
  const waiting = (extra: Partial<ApiRun> = {}) =>
    fresh({ status: 'waiting', costUsd: 1.26, waits: [ciEntry, timerEntry], steps: [{ ...steps[0]!, status: 'done' }], ...extra })
  const summary = () => screen.getByRole('button', { name: /^Session activity/ })
  const ensureOpen = () => {
    if (summary().getAttribute('aria-expanded') !== 'true') fireEvent.click(summary())
  }

  it('folds to label, status and cost in one disclosure', () => {
    renderDock(waiting(), [])
    if (summary().getAttribute('aria-expanded') === 'true') fireEvent.click(summary())
    expect(summary().textContent).toContain('Session activity')
    expect(summary().textContent).toContain('Waiting for CI')
    expect(summary().textContent).toContain('$1.26')
    expect(summary().textContent).not.toContain('Next check')
    expect(summary().getAttribute('aria-label')).toContain('Session activity: Waiting for CI; cost $1.26')
  })

  it('shows the status and next check first when expanded, with wait details behind it', () => {
    renderDock(waiting(), [])
    ensureOpen()
    const rows = [...document.querySelectorAll('[data-slot="run-activity-dock"] [data-slot^="run-activity-"][data-state]')]
    expect(rows[0]?.getAttribute('data-slot')).toBe('run-activity-status-row')
    expect(rows[0]?.textContent).toContain('Waiting for CI')
    expect(rows[0]?.textContent).toContain('Next check')
    expect(document.querySelector('[data-slot="ci-wait-status"]')).toBeNull()
    fireEvent.click(sectionHead('status-row'))
    expect(document.querySelectorAll('[data-slot="ci-wait-status"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="monitoring-schedule"]')).toHaveLength(1)
    // The folded summary's status moves into the first row once the card is open.
    expect(summary().textContent).not.toContain('Waiting for CI')
    expect(document.querySelectorAll('[data-slot="run-activity-status"]')).toHaveLength(1)
  })

  it('gives the next check its own wrapping line, outside the truncating meter', () => {
    renderDock(waiting(), [])
    ensureOpen()
    const next = section('status-row')!.querySelector<HTMLElement>('[data-slot="run-activity-next-check"]')
    expect(next?.textContent).toMatch(/^Next check /)
    // A meter truncates to one line; the appointment must be readable at 320px without opening details.
    expect(next?.closest('[data-slot="run-activity-meta"]')).toBeNull()
    expect(next?.className).toContain('whitespace-normal')
    expect(metaOf('status-row')).toBeUndefined()
  })

  it('renders for a run with no workflow, agents, workers or plan', () => {
    renderDock(fresh({ steps: [], status: 'queued' }), [])
    ensureOpen()
    expect(section('status-row')).not.toBeNull()
    expect(section('usage')).not.toBeNull()
    expect(section('workspace')).toBeNull()
    expect(section('workflow')).not.toBeNull() // the workflow name still has a home
  })

  it('keeps terminal summaries truthful', async () => {
    renderDock(fresh({ status: 'failed' }), [])
    expect(document.querySelector('[data-slot="run-activity-status"]')?.textContent ?? summary().textContent).toContain('Failed')
    expect(summary().textContent).not.toContain('All complete')
  })

  it('names the workflow and links its automation', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })))
    renderDock(fresh({ automation: { automationId: 'nightly', receiptId: 'nightly:schedule:x' } as ApiRun['automation'] }), [], workers, 'ok', {
      '/api/v1/health': () => json({ capabilities: { automations: true } }),
    })
    ensureOpen()
    expect(sectionHead('workflow').textContent).toContain('quick-task')
    fireEvent.click(sectionHead('workflow'))
    return waitFor(() => expect(screen.getByRole('link', { name: 'Automation' }).getAttribute('href')).toContain('/automations/nightly/log'))
  })

  it('lists runner, account, model and effort under Usage & agent', () => {
    renderDock(fresh({ runner: 'codex', model: 'gpt-6', effort: 'high', inputTokens: 1200, outputTokens: 300 }), [])
    ensureOpen()
    fireEvent.click(sectionHead('usage'))
    const body = section('usage')!.textContent
    expect(body).toContain('Runner')
    expect(body).toContain('codex')
    expect(body).toContain('gpt-6')
    expect(body).toContain('high')
  })

  it('shows agent identity in both folded summaries', () => {
    renderDock(fresh({ runner: 'codex', model: 'gpt-6', modelIdentity: 'openai/gpt-6', effort: 'high', costUsd: 1.26 }), [])
    ensureOpen()
    const usage = sectionHead('usage').textContent
    expect(usage).toContain('openai')
    expect(usage).toContain('gpt-6')
    expect(usage).toContain('high')
    fireEvent.click(summary())
    expect(summary().textContent).toContain('codex')
    expect(summary().textContent).toContain('gpt-6')
    expect(summary().textContent).toContain('high')
    expect(summary().getAttribute('aria-label')).toContain('runner codex; model gpt-6; effort high')
  })

  it('reads the saved provider even when the model already includes it', () => {
    renderDock(fresh({ runner: 'claude', model: 'anthropic/opus', modelIdentity: 'anthropic/opus' }), [])
    ensureOpen()
    expect(section('usage')?.querySelector('[data-summary-item="provider"]')?.textContent).toBe('anthropic')
  })

  it('omits the provider when no canonical identity was saved', () => {
    renderDock(fresh({ runner: 'codex', model: 'gpt-6' }), [])
    ensureOpen()
    expect(section('usage')?.querySelector('[data-summary-item="provider"]')).toBeNull()
  })

  it('surfaces the waiting PR in the folded status and card', () => {
    renderDock(waiting({ waits: [ciEntry] }), [])
    ensureOpen()
    expect(section('status-row')?.querySelector('[data-slot="pr-chip"]')?.textContent).toContain('474')
    fireEvent.click(summary())
    expect(summary().querySelector('[data-slot="pr-chip"]')?.textContent).toContain('474')
    expect(summary().getAttribute('aria-label')).toContain('PR #474')
  })

  it('surfaces Issue and PR chips in the folded Workspace row and card', () => {
    renderDock(fresh({ referencedIssueUrl: 'https://github.com/owner/repo/issues/15', referencedPullRequestUrl: 'https://github.com/owner/repo/pull/42' }), [])
    ensureOpen()
    expect(sectionHead('workspace').querySelector('[data-slot="issue-chip"]')?.textContent).toContain('15')
    expect(sectionHead('workspace').querySelector('[data-slot="pr-chip"]')?.textContent).toContain('42')
    fireEvent.click(summary())
    expect(summary().querySelector('[data-slot="issue-chip"]')?.textContent).toContain('15')
    expect(summary().querySelector('[data-slot="pr-chip"]')?.textContent).toContain('42')
    expect(summary().getAttribute('aria-label')).toContain('Issue #15')
    expect(summary().getAttribute('aria-label')).toContain('PR #42')
  })

  it('groups expanded Workspace references into labeled rows and keeps standard chip styles in summaries', () => {
    renderDock(fresh({ referencedIssueUrl: 'https://github.com/owner/repo/issues/15', referencedPullRequestUrl: 'https://github.com/owner/repo/pull/42' }), [])
    ensureOpen()
    const foldedChip = sectionHead('workspace').querySelector<HTMLElement>('[data-slot="pr-chip"]')!
    expect(foldedChip.className).toContain('border-accent-strong/35')
    expect(foldedChip.tagName).toBe('SPAN')
    expect(foldedChip.hasAttribute('tabindex')).toBe(false)
    fireEvent.click(sectionHead('workspace'))
    const linked = section('workspace')!.querySelector('[data-slot="linked-references"]')!
    expect(linked.querySelector('[data-reference-kind="PR"]')?.textContent).toContain('PRs')
    expect(linked.querySelector('[data-reference-kind="PR"] [data-slot="pr-chip"]')).not.toBeNull()
    expect(linked.querySelector('[data-reference-kind="PR"] [data-slot="issue-chip"]')).toBeNull()
    expect(linked.querySelector('[data-reference-kind="Issue"]')?.textContent).toContain('Issues')
    expect(linked.querySelector('[data-reference-kind="Issue"] [data-slot="issue-chip"]')).not.toBeNull()
  })

  it('keeps capacity in the Workers header when the list is folded', async () => {
    const record = fresh({ delegation: { role: 'root', permissions: [], receipts: [] } })
    renderDock(record, [], workers, 'ok', {
      [`/api/v1/p/sample/runs/${record.id}/relationships`]: () => json({ workers, capacity: { outstanding: 2, limit: 32, created: 2, creationLimit: 1024 } }),
    })
    ensureOpen()
    await waitFor(() => expect(document.querySelector('[data-slot="worker-capacity"]')?.textContent).toContain('2 of 32'))
    fireEvent.click(sectionHead('workers'))
    expect(document.querySelector('[data-slot="worker-capacity"]')?.textContent).toContain('2 of 32')
    expect(sectionHead('workers').contains(document.querySelector('[data-slot="worker-capacity"]'))).toBe(true)
  })

  it('offers branch copy, worktree copy and the resume command under Workspace', () => {
    renderDock(fresh({ branch: 'cez/parent', worktreePath: '/repo/.ai/cezar/worktrees/parent' }), [])
    ensureOpen()
    expect(metaOf('workspace')).toBe('cez/parent')
    fireEvent.click(sectionHead('workspace'))
    expect(screen.getByRole('button', { name: 'Copy branch name' })).not.toBeNull()
    expect(section('workspace')!.textContent).toContain('/repo/.ai/cezar/worktrees/parent')
  })

  it('rolls a PR conflict up to the Workspace row and the folded summary', async () => {
    const overrides = {
      '/api/v1/projects': () => json({
        projects: [{ id: 'sample', name: 'sample', root: '/sample', addedAt: at, lastOpenedAt: at, source: 'local', status: 'ok', repoUrl: 'https://github.com/owner/repo' }],
      }),
      '/api/v1/p/sample/github/ref-status?prs=42': () =>
        json({ available: true, prs: { 42: 'ready' }, issues: {}, conflicts: [42], recheckAfterMs: null }),
    }
    renderDock(fresh({ branch: 'cez/parent', referencedPullRequestUrl: 'https://github.com/owner/repo/pull/42' }), [], workers, 'ok', overrides)
    if (summary().getAttribute('aria-expanded') === 'true') fireEvent.click(summary())
    await waitFor(() => expect(document.querySelector('[data-slot="run-activity-conflict"]')?.textContent).toContain('Conflicts'))
    expect(summary().getAttribute('aria-label')).toContain('pull request conflicts')
    fireEvent.click(summary())
    expect(metaOf('workspace')).toContain('PR #42 conflicts')
    fireEvent.click(sectionHead('workspace'))
    const chip = document.querySelector<HTMLElement>('[data-slot="run-activity-workspace"] [data-slot="pr-chip"][data-conflicting="true"]')
    expect(chip).not.toBeNull()
  })

  it("does not carry one run's open rows into another", () => {
    const first = renderDock(fresh({ id: 'run-a', branch: 'cez/a' }), [])
    ensureOpen()
    fireEvent.click(sectionHead('workspace'))
    expect(section('workspace')?.getAttribute('data-state')).toBe('open')
    first.unmount()
    renderDock(fresh({ id: 'run-b', branch: 'cez/b' }), [])
    ensureOpen()
    expect(section('workspace')?.getAttribute('data-state')).toBe('collapsed')
  })
})
