import { QueryClientProvider } from '@tanstack/react-query'
import { openHumanWait } from '@/test/run-summary-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RunHeader, visibleItemTabs, type RunTab } from './run-header'
import { PreviewPaneContext, type PreviewPane } from './preview/preview-state'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status,
  createdAt: '2026-07-14T12:00:00.000Z',
  tokensUsed: 27_000,
  inputTokens: 24_600,
  outputTokens: 2_400,
  archived: false,
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Stubs fetch, records every request, and lets a test override specific paths. Defaults:
 *  the runs list is empty, every mutation succeeds with `{}`. */
function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).replace('?archived=recent', '')
      const method = init.method ?? 'GET'
      sent.push({
        path,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const override = overrides[path]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/run-summaries') return jsonResponse([])
      if (method === 'GET' && path === '/api/v1/providers/status') {
        return jsonResponse({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'not-installed', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function renderHeader(
  record: ApiRun,
  onMarkedUnread?: () => void,
  tab: RunTab = 'session',
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
        <Routes>
          <Route
            path="/tasks/:id"
            element={<RunHeader run={record} tab={tab} onMarkedUnread={onMarkedUnread} />}
          />
          <Route path="/" element={<div data-slot="home-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const actionBar = () => {
  if (!document.querySelector('[data-slot="run-actions-menu"]')) {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
  }
  return within(document.querySelector('[data-slot="run-actions-menu"]') as HTMLElement)
}

it.each([true, false])('shows the automatic reason only for its matching archive event: %s', automatic => {
  stubFetch()
  const receiptAt = '2026-01-02T00:00:00.000Z'
  renderHeader(run('done', {
    archived: true,
    archivedAt: automatic ? receiptAt : '2026-01-03T00:00:00.000Z',
    autoArchive: { reason: 'pull-requests-merged', archivedAt: receiptAt, fingerprint: 'a'.repeat(64), pullRequests: [{ owner: 'o', repo: 'r', number: 42, mergedAt: receiptAt }] },
  }))
  expect(document.querySelector('[data-slot="auto-archive-reason"]') !== null).toBe(automatic)
})

describe('simplified header (hearsay-tools/cezarion#1333)', () => {
  type TimerEntry = Extract<NonNullable<ApiRun['waits']>[number], { kind: 'timer' }>
  const timer: TimerEntry = {
    id: '00000000-0000-4000-8000-000000000005', kind: 'timer', source: 'agent', via: 'cezar_wait',
    turnId: 'turn-1', seconds: 300, registeredAt: '2026-09-22T12:00:00.000Z',
    deadline: '2026-09-22T12:05:00.000Z', phase: 'open',
  }

  it('keeps one status pill with the next check on desktop', () => {
    stubFetch()
    renderHeader(run('waiting', { waits: [timer] }))
    const pill = document.querySelector('[data-slot="run-header"] [data-slot="pill"]') as HTMLElement
    expect(pill.textContent).toMatch(/^Monitoring · Next check /)
    expect(pill.className).toContain('max-md:hidden')
  })

  it('shows no metadata row, wait list or details toggle', () => {
    stubFetch()
    renderHeader(run('waiting', { waits: [timer], branch: 'cez/r1', costUsd: 1.2, prNumber: 9 }))
    expect(document.querySelector('[data-slot="run-meta"]')).toBeNull()
    expect(document.querySelector('[data-slot="open-waits"]')).toBeNull()
    expect(document.querySelector('[data-slot="run-details"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /run details/ })).toBeNull()
    expect(document.querySelector('[data-slot="agent-badge"]')).toBeNull()
  })

  it('counts changed files on the Changes tab at every width', () => {
    stubFetch()
    renderHeader(run('done', { diffStat: { adds: 3, dels: 1, files: 4 } }))
    const changes = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement).getByRole('link', { name: /Changes/ })
    expect(changes.querySelector('[data-slot="tab-count"]')?.textContent).toBe('4')
  })
})

describe('Session-only activity controls (#751)', () => {
  const tabs: RunTab[] = ['changes', 'commits', 'files', { kind: 'issue', number: 751 }, { kind: 'pr', number: 752 }]

  it.each(tabs)('omits workers and workflow controls on %j', async (tab) => {
    stubFetch({ '/api/v1/runs/r1/relationships': () => jsonResponse({ workers: [] }) })
    renderHeader(run('running', {
      delegation: { role: 'root', permissions: [], receipts: [] },
      steps: [step({ status: 'running' })],
    }), undefined, tab)

    await act(async () => {})
    expect.soft(screen.queryByRole('region', { name: 'Task relationships' })).toBeNull()
    expect.soft(screen.queryByText('No workers')).toBeNull()
    expect.soft(screen.queryByRole('button', { name: /Workflow: Do the task/ })).toBeNull()
    expect.soft(document.querySelector('[data-slot="workflow-steps"]')).toBeNull()
  })
})

describe('editable title (#389)', () => {
  it('pencil flips the h1 into an input; Enter PATCHes the trimmed title exactly once', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))

    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    const input = screen.getByLabelText('Task title') as HTMLInputElement
    expect(input.value).toBe('Do the thing') // seeded with the displayed title, not the raw one

    fireEvent.change(input, { target: { value: '  New name  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Enter is typically followed by the blur of the unmounting input — one PATCH, not two.
    fireEvent.blur(input)

    await waitFor(() => {
      expect(sent.filter((r) => r.method === 'PATCH')).toHaveLength(1)
    })
    expect(sent.find((r) => r.method === 'PATCH')).toMatchObject({
      path: '/api/v1/runs/r1',
      body: { title: 'New name' },
    })
    // Back to the heading immediately — the edit UI does not wait for the server.
    expect(screen.getByRole('heading', { level: 1 })).not.toBeNull()
  })

  it('blur commits like Enter', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    const input = screen.getByLabelText('Task title')
    fireEvent.change(input, { target: { value: 'Renamed on blur' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ title: 'Renamed on blur' })
    })
  })

  it('Escape abandons the draft — no PATCH, the old title stays', () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    const input = screen.getByLabelText('Task title')
    fireEvent.change(input, { target: { value: 'Never sent' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('an unchanged or emptied draft is not worth a request', () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    for (const value of ['Do the thing', '   ']) {
      fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
      const input = screen.getByLabelText('Task title')
      fireEvent.change(input, { target: { value } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })
})

describe('action bar visibility per status (the legacy rules, rendered)', () => {
  // Pin (#935) is in every row: unlike every other action here it asks nothing of the engine,
  // so it is offered whatever the run is doing — only archiving takes it away.
  // Finish belongs only to the composer; Archive stays outside this menu on every tab.
  const matrix: Array<{ status: RunStatus; visible: string[] }> = [
    { status: 'queued', visible: ['Notes / handoff', 'Pin task'] },
    { status: 'running', visible: ['Notes / handoff', 'Pin task'] },
    { status: 'waiting', visible: ['Notes / handoff', 'Pin task'] },
    // Terminal folded into the Open in… menu — it shows whenever the session can be resumed.
    { status: 'review', visible: ['Notes / handoff', 'Open in…', 'Copy resume command', 'Pin task', 'Delete task…'] },
    { status: 'done', visible: ['Notes / handoff', 'Open in…', 'Copy resume command', 'Pin task', 'Delete task…'] },
    { status: 'failed', visible: ['Notes / handoff', 'Open in…', 'Copy resume command', 'Pin task', 'Delete task…'] },
    { status: 'cancelled', visible: ['Notes / handoff', 'Open in…', 'Copy resume command', 'Pin task', 'Delete task…'] },
  ]

  it.each(matrix)('$status → $visible', ({ status, visible }) => {
    stubFetch()
    renderHeader(run(status))
    actionBar()
    const names = [...document.querySelectorAll('[data-slot="run-actions-menu"] [role^="menuitem"]')].map(el => el.textContent?.trim())
    expect(names).toEqual(visible)
  })

  it('the menu offers neither Archive nor Unarchive — both moved to a control (#281)', () => {
    stubFetch()
    renderHeader(run('done', { archived: true }))
    expect(actionBar().queryByRole('menuitem', { name: 'Archive task' })).toBeNull()
    expect(actionBar().queryByRole('menuitem', { name: 'Unarchive' })).toBeNull()
  })

  it('VS Code is absent everywhere — the open-in-editor endpoint does not exist yet (R5)', () => {
    stubFetch()
    renderHeader(run('done'))
    expect(screen.queryByRole('button', { name: /vs code/i })).toBeNull()
  })

  it('the mobile kebab is there for every status, holding the same actions', () => {
    stubFetch()
    renderHeader(run('running'))
    expect(screen.getByRole('button', { name: 'Run actions' })).not.toBeNull()
  })
})

describe('Mark unread (#775)', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const SEEN_AT = '2026-07-14T13:05:00.000Z'
  /** A finished run that has already been read — the one state the action is offered in. */
  const readDone = (extra: Partial<ApiRun> = {}) =>
    run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT, ...extra })

  it('offers the control for a read, finished run — between Open in… and Pin', () => {
    stubFetch()
    renderHeader(readDone())
    actionBar()
    const names = [...document.querySelectorAll('[data-slot="run-actions-menu"] [role^="menuitem"]')].map(el => el.textContent?.trim())
    expect(names).toEqual(['Notes / handoff', 'Open in…', 'Copy resume command', 'Mark unread', 'Pin task', 'Delete task…'])
  })

  it.each([
    ['an already-unread run', run('done', { finishedAt: FINISHED_AT })],
    ['an archived run', readDone({ archived: true })],
    ['a cancelled run', run('cancelled', { finishedAt: FINISHED_AT, seenAt: SEEN_AT })],
    ['a still-running run', run('running', { seenAt: SEEN_AT })],
    ['a done run caught with no finishedAt', run('done', { seenAt: SEEN_AT })],
  ] as Array<[string, ApiRun]>)('hides the control for %s', (_name, record) => {
    stubFetch()
    renderHeader(record)
    expect(actionBar().queryByRole('menuitem', { name: 'Mark unread' })).toBeNull()
  })

  it('Mark unread → POST /unread, bodyless like its read twin', async () => {
    const sent = stubFetch()
    renderHeader(readDone())
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Mark unread' }))
    await waitFor(() => {
      const request = sent.find((r) => r.path === '/api/v1/runs/r1/unread')
      expect(request?.method).toBe('POST')
      expect(request?.body).toBeUndefined()
    })
  })

  it('notifies the host BEFORE the request goes out, so the thread can suppress its auto-read', async () => {
    // Ordering is the whole contract: the optimistic cache write re-renders the open thread and
    // re-runs its auto-mark-read effect, which would re-stamp the receipt if it were not already
    // suppressed by the time that happens.
    const sent = stubFetch()
    const onMarkedUnread = vi.fn(() => {
      expect(sent.some((r) => r.path === '/api/v1/runs/r1/unread')).toBe(false)
    })
    renderHeader(readDone(), onMarkedUnread)
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Mark unread' }))
    expect(onMarkedUnread).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/runs/r1/unread')).toBe(true))
  })

  it('surfaces a server refusal as a danger toast and leaves the run read', async () => {
    // The mixed-version failure mode (#769): an older server has no such route. The guarded
    // rollback in `useMarkRunUnseen` means the cockpit says so rather than showing a marker
    // the server does not agree with.
    stubFetch({
      '/api/v1/runs/r1/unread': () => jsonResponse({ error: 'not found' }, 404),
    })
    renderHeader(readDone())
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Mark unread' }))
    await waitFor(() => expect(screen.getByText('not found')).not.toBeNull())
  })

  it('is in the mobile kebab too, under the same rule', async () => {
    stubFetch()
    renderHeader(readDone())
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
    const menu = within(await screen.findByRole('menu'))
    expect(menu.getByRole('menuitem', { name: 'Mark unread' })).not.toBeNull()
  })
})

describe('actions hit their endpoints', () => {
  it.each(['done', 'running'] as const)('does not duplicate composer execution actions on desktop or mobile (%s)', async (status) => {
    const sent = stubFetch()
    renderHeader(run(status))
    expect(actionBar().queryByRole('menuitem', { name: /^(Continue|Cancel|Stop)$/ })).toBeNull()
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: /^(Continue|Cancel|Stop)$/ })).toBeNull()
    expect(sent.some((request) => /\/(continue|cancel)$/.test(request.path))).toBe(false)
  })

  it('Archive → POST /archive with the flipped flag', async () => {
    const sent = stubFetch()
    renderHeader(run('done', { archived: true }), undefined, 'changes')
    fireEvent.click(document.querySelector('[data-slot="archive-action"]') as HTMLElement)
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/archive')?.body).toEqual({ archived: false })
    })
  })

  it('Pin → POST /pin with the flipped flag, and reads Unpin once pinned (#935)', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click(actionBar().getByRole('menuitemcheckbox', { name: 'Pin task' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: true })
    })

    cleanup()
    const unpinning = stubFetch()
    renderHeader(run('done', { pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z' }))
    fireEvent.click(actionBar().getByRole('menuitemcheckbox', { name: 'Unpin task' }))
    await waitFor(() => {
      expect(unpinning.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: false })
    })
  })

  it('an archived run offers no pin at all — archiving retires it (#935)', () => {
    stubFetch()
    renderHeader(run('done', { archived: true }))
    expect(actionBar().queryByRole('menuitemcheckbox', { name: 'Pin task' })).toBeNull()
    expect(actionBar().queryByRole('menuitemcheckbox', { name: 'Unpin task' })).toBeNull()
  })

  it('a worker header offers neither Pin task nor Unpin task', () => {
    stubFetch()
    renderHeader(
      run('running', {
        delegation: {
          role: 'worker',
          permissions: [],
          parentRunId: '10000000-0000-4000-8000-000000000001',
          workspace: {
            ownerRunId: 'r1',
            resourceId: 'r1',
            kind: 'owned-isolated',
            path: '/worker',
            branch: 'cez/worker',
            baselineSha: 'a'.repeat(40),
          },
        },
      }),
    )
    expect(actionBar().queryByRole('menuitemcheckbox', { name: 'Pin task' })).toBeNull()
    expect(actionBar().queryByRole('menuitemcheckbox', { name: 'Unpin task' })).toBeNull()
  })

  it('Pin is in the mobile kebab too', async () => {
    stubFetch()
    renderHeader(run('running'))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
    const menu = within(await screen.findByRole('menu'))
    expect(menu.getByRole('menuitemcheckbox', { name: 'Pin task', checked: false })).not.toBeNull()
  })

  it('Delete confirms, DELETEs, and navigates home', async () => {
    const sent = stubFetch()
    renderHeader(run('failed'))
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Delete task…' }))

    expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete task' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'DELETE' && r.path === '/api/v1/runs/r1')).toBe(true)
    })
    // The run is gone — the header sent us home rather than leaving a dead page up.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="home-probe"]')).not.toBeNull()
    })
  })

  it('the delete confirm button stays "Delete task" even for a long task name, which appears in the description instead (#403)', async () => {
    const longTitle = 'create a github issue for saving unsuccessfully finished tasks automatically'
    renderHeader(run('failed', { titleSummary: longTitle }))
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Delete task…' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Delete task' })).not.toBeNull()
    expect(within(dialog).getByText(longTitle)).not.toBeNull()
  })

  it('dismissing the confirm keeps the run', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Delete task…' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
  })

  it('a mutation failure surfaces the server message as a danger toast', async () => {
    stubFetch({
      '/api/v1/runs/r1/archive': () => jsonResponse({ error: 'run is still active' }, 409),
    })
    renderHeader(run('done'), undefined, 'changes')
    fireEvent.click(document.querySelector('[data-slot="archive-action"]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Archive task' }))
    const item = await screen.findByRole('status')
    expect(item.textContent).toBe('run is still active')
    expect(item.getAttribute('data-tone')).toBe('danger')
  })
})

/** Terminal now lives inside the Open in… menu: open it (Radix opens on pointerdown) and click
 *  the resume item. */
async function clickTerminalResume(): Promise<void> {
  fireEvent.click(actionBar().getByRole('menuitem', { name: 'Open in…' }))
  const menu = await screen.findByRole('region', { name: 'Open task worktree in…' })
  fireEvent.click(within(menu).getByRole('button', { name: /Terminal \(resume session\)/ }))
}

describe('Terminal — the copy-command 409 fallback', () => {
  it('copies the server-sent command to the clipboard and says so', async () => {
    const command = "cd '/tmp/wt' && claude --resume sess-1"
    stubFetch({
      '/api/v1/runs/r1/open-in-cli': () =>
        jsonResponse({ error: 'no terminal emulator found', command }, 409),
    })
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    renderHeader(run('done'))
    await clickTerminalResume()

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command))
    expect((await screen.findByRole('status')).textContent).toBe(
      'No terminal found — command copied to clipboard.',
    )
  })

  it('with no clipboard access the toast carries the command itself', async () => {
    const command = "cd '/tmp/wt' && claude --resume sess-1"
    stubFetch({
      '/api/v1/runs/r1/open-in-cli': () =>
        jsonResponse({ error: 'no terminal emulator found', command }, 409),
    })
    vi.stubGlobal('navigator', {}) // http, denied permission — no clipboard at all

    renderHeader(run('done'))
    await clickTerminalResume()

    expect((await screen.findByRole('status')).textContent).toBe(`Run manually: ${command}`)
  })

  it('a 409 without a command is an ordinary error toast', async () => {
    stubFetch({
      '/api/v1/runs/r1/open-in-cli': () => jsonResponse({ error: 'no agent session to resume' }, 409),
    })
    renderHeader(run('done'))
    await clickTerminalResume()
    expect((await screen.findByRole('status')).textContent).toBe('no agent session to resume')
  })
})

describe('Open in… menu — agent CLI resume labeling (#402)', () => {
  const CLI_LABELS: Record<string, string> = {
    'cli:claude': 'Claude CLI',
    'cli:codex': 'Codex CLI',
    'cli:opencode': 'OpenCode',
  }
  const openTargets = (ids: string[]) => ({
    targets: ids.map((id) => ({ id, label: CLI_LABELS[id] ?? id })),
  })

  async function openMenu(): Promise<HTMLElement> {
    // Without a resumable Terminal item, the button itself only appears once the async
    // worktreeTargets query resolves (empty-until-loaded) — findByRole waits it in.
    const trigger = await actionBar().findByRole('menuitem', { name: 'Open in…' })
    fireEvent.click(trigger)
    return screen.findByRole('region', { name: 'Open task worktree in…' })
  }

  it('labels the CLI matching the run\'s own runner "(resume)"; a foreign CLI stays plain', async () => {
    stubFetch({
      '/api/v1/open-targets': () => jsonResponse(openTargets(['cli:claude', 'cli:codex'])),
      '/api/v1/providers/status': () => jsonResponse({
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      }),
    })
    renderHeader(run('done', { runner: 'claude', worktreePath: '/tmp/wt' }))
    const menu = await openMenu()
    // The CLI targets load async (useOpenTargets) — findByRole waits them in, unlike the
    // static Terminal/Copy items already asserted synchronously elsewhere in this file.
    expect(await within(menu).findByRole('button', { name: 'Claude CLI (resume)' })).not.toBeNull()
    expect(within(menu).getByRole('button', { name: 'Codex CLI' })).not.toBeNull()
  })

  it('a run with no session yet: not even the matching CLI claims to resume', async () => {
    stubFetch({ '/api/v1/open-targets': () => jsonResponse(openTargets(['cli:claude'])) })
    renderHeader(run('done', { runner: 'claude', worktreePath: '/tmp/wt', steps: [step()] }))
    const menu = await openMenu()
    expect(await within(menu).findByRole('button', { name: 'Claude CLI' })).not.toBeNull()
  })

  it('picking a CLI target POSTs /open-in with that target id, resuming or not', async () => {
    const sent = stubFetch({
      '/api/v1/open-targets': () => jsonResponse(openTargets(['cli:codex'])),
      '/api/v1/providers/status': () => jsonResponse({
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      }),
    })
    renderHeader(run('done', { runner: 'claude', worktreePath: '/tmp/wt' }))
    const menu = await openMenu()
    // Cross-runner (this run is Claude): Codex opens fresh, not "(resume)".
    fireEvent.click(await within(menu).findByRole('button', { name: 'Codex CLI' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/open-in')?.body).toEqual({ target: 'cli:codex' })
    })
  })

  it.each([
    ['disabled', { provider: 'codex', status: 'connected', enabled: false }],
    ['disconnected', { provider: 'codex', status: 'disconnected', enabled: true }],
  ] as const)('keeps non-agent targets while hiding %s Codex handoff targets', async (_case, codex) => {
    stubFetch({
      '/api/v1/open-targets': () => jsonResponse({
        targets: [
          { id: 'cli:codex', label: 'Codex CLI' },
          { id: 'idea', label: 'IntelliJ IDEA', icon: 'idea' },
        ],
      }),
      '/api/v1/providers/status': () => jsonResponse({
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          codex,
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      }),
    })
    renderHeader(run('done', { runner: 'codex', worktreePath: '/tmp/wt' }))
    const menu = await openMenu()

    expect(await within(menu).findByRole('button', { name: 'IntelliJ IDEA' })).not.toBeNull()
    expect(within(menu).queryByRole('button', { name: /Terminal \(resume session\)/ })).toBeNull()
    expect(within(menu).queryByRole('button', { name: /Codex CLI/ })).toBeNull()
  })
})

describe('Open in… menu per-target icons (#361)', () => {
  it('renders a known target with its mapped icon, falls back for an unrecognized icon key, and POSTs the clicked id', async () => {
    const sent = stubFetch({
      '/api/v1/open-targets': () =>
        jsonResponse({
          targets: [
            { id: 'idea', label: 'IntelliJ IDEA', icon: 'idea' },
            { id: 'mystery-app', label: 'Mystery App', icon: 'not-a-real-icon' },
            { id: 'no-icon-app', label: 'No Icon App' },
          ],
        }),
    })
    renderHeader(run('done', { worktreePath: '/tmp/wt' }))
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Open in…' }))
    const menu = await screen.findByRole('region', { name: 'Open task worktree in…' })

    // The menu opens immediately; the worktree targets only appear once useOpenTargets resolves.
    const ideaItem = await within(menu).findByRole('button', { name: 'IntelliJ IDEA' })
    expect(ideaItem.querySelector('svg')).not.toBeNull()
    // Unknown/missing icon keys still render the generic fallback glyph — never bare text only.
    expect(within(menu).getByRole('button', { name: 'Mystery App' }).querySelector('svg')).not.toBeNull()
    expect(within(menu).getByRole('button', { name: 'No Icon App' }).querySelector('svg')).not.toBeNull()

    fireEvent.click(ideaItem)
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/open-in')?.body).toEqual({ target: 'idea' })
    })
  })
})

describe('notes panel', () => {
  it('toggles open, fetches the handoff and renders it as markdown', async () => {
    stubFetch({
      '/api/v1/runs/r1/handoff': () =>
        new Response('# Handoff notes\n\nStill **todo**: the composer.', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    })
    renderHeader(run('done'))

    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Notes / handoff' }))
    await waitFor(() => {
      expect(document.querySelector('[data-slot="notes-panel"]')).not.toBeNull()
    })
    await screen.findByText('Handoff notes')
    // Rendered markdown, not echoed source.
    expect(document.querySelector('[data-slot="notes-panel"]')?.textContent).not.toContain('#')

    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Notes / handoff' }))
    expect(document.querySelector('[data-slot="notes-panel"]')).toBeNull()
  })

  it('an unseeded handoff file reads as an honest empty state', async () => {
    stubFetch({
      '/api/v1/runs/r1/handoff': () => new Response('', { status: 200 }),
    })
    renderHeader(run('running'))
    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Notes / handoff' }))
    await screen.findByText('No notes yet — the handoff file is seeded when the task starts.')
  })
})

describe('header layout, tabs, pill and resume hint', () => {
  it('sticks the run header on desktop and lets it scroll away on phones', () => {
    stubFetch()
    renderHeader(run('done'))

    const header = document.querySelector('[data-slot="run-header"]') as HTMLElement
    const classes = header.className.split(/\s+/)
    // Phone: in document flow. Desktop: docks to the shell scroller so Archive stays on screen.
    expect(classes).toContain('relative')
    expect(classes).not.toContain('sticky')
    expect(classes).not.toContain('top-0')
    expect(classes).toContain('md:sticky')
    expect(classes).toContain('md:top-0')
    expect(classes).toContain('bg-background')
    expect(classes).toContain('z-20')
    expect(classes).toContain('px-[18px]')
    expect(classes).toContain('md:px-9')
    expect(screen.getByRole('button', { name: 'Run actions' }).className).toContain('size-11')
  })

  it('leaves the run header in document flow on Git tabs so their sticky chrome stays visible', () => {
    stubFetch()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/tasks/r1/changes']}>
          <Routes>
            <Route
              path="/tasks/:id/changes"
              element={<RunHeader run={run('done')} tab="changes" />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const header = document.querySelector('[data-slot="run-header"]') as HTMLElement
    const classes = header.className.split(/\s+/)
    expect(classes).not.toContain('md:sticky')
    expect(classes).not.toContain('md:top-0')
  })

  // The session header no longer owns plan progress — the dock does. The header must stay
  // free of that mirror on every width.
  it('does not render a plan mirror in the session header at any width', () => {
    stubFetch()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route
              path="/tasks/:id"
              element={<RunHeader run={run('running')} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(document.querySelector('[data-slot="plan-mirror"]')).toBeNull()
  })

  it('tabs: Session is current; Changes and Files link to the routed surfaces', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Session' }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: 'Changes' }).getAttribute('href')).toBe('/tasks/r1/changes')
    expect(tabs.getByRole('link', { name: 'Files' }).getAttribute('href')).toBe('/tasks/r1/files')
  })

  it('a queued run shows its position in the pill, from the shared runs list', async () => {
    stubFetch({
      '/api/v1/run-summaries': () =>
        jsonResponse([
          run('queued', { id: 'earlier', createdAt: '2026-07-14T11:00:00.000Z' }),
          run('queued'),
        ]),
    })
    renderHeader(run('queued'))
    await waitFor(() => {
      expect(document.querySelector('[data-slot="pill"]')?.textContent).toBe('Queued #2')
    })
  })

  it('a closed run keeps its resume command under Open in', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderHeader(run('failed', { runner: 'opencode', worktreePath: '/tmp/wt' }))

    fireEvent.click(actionBar().getByRole('menuitem', { name: 'Open in…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy resume command' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1')
    })
  })

  it('an active run has no resume hint — the engine still owns the session', () => {
    stubFetch()
    renderHeader(run('running'))
    expect(document.querySelector('[data-slot="resume-hint"]')).toBeNull()
  })
})


it('uses one actions menu and omits the legacy action and resume rows', () => {
  stubFetch()
  renderHeader(run('done'))
  expect(document.querySelector('[data-slot="run-actions"]')).toBeNull()
  expect(document.querySelector('[data-slot="resume-hint"]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Run actions' }).className).not.toContain('md:hidden')
})


it('confirms archive before retiring an active-list task', async () => {
  const sent = stubFetch()
  renderHeader(run('done'), undefined, 'changes')
  fireEvent.click(document.querySelector('[data-slot="archive-action"]') as HTMLElement)
  expect(sent.some(r => r.path.endsWith('/archive'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Archive task' }))
  await waitFor(() => expect(sent.find(r => r.path.endsWith('/archive'))?.body).toEqual({ archived: true }))
})


it('copies the resumable command directly from the task actions menu', async () => {
  stubFetch()
  const writeText = vi.fn(() => Promise.resolve())
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  renderHeader(run('done'))
  fireEvent.click(actionBar().getByRole('menuitem', { name: 'Copy resume command' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude --resume sess-1'))
})

/**
 * #281 — who owns Finish and Archive on each tab. The composer holds both on Session, where it is
 * thumb-reachable; the three git tabs have no composer, so the header carries Archive there and
 * Finish is absent from the kebab. Exactly one surface offers each action on any given screen, which is
 * what keeps one mutation from growing two pending states.
 */
describe('the promoted actions, per tab (#281)', () => {
  const renderTab = (record: ApiRun, tab: 'session' | 'changes' | 'commits' | 'files') =>
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
          <Routes>
            <Route path="/tasks/:id" element={<RunHeader run={record} tab={tab} />} />
            <Route path="/" element={<div data-slot="home-probe" />} />
          </Routes>
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>,
    )

  const headerArchive = () => document.querySelector('[data-slot="archive-action"]')

  it.each(['changes', 'commits', 'files'] as const)('%s — the header carries Archive, the kebab drops it', (tab) => {
    stubFetch()
    renderTab(run('done'), tab)
    expect(headerArchive()?.textContent).toContain('Archive task')
    expect(actionBar().queryByRole('menuitem', { name: 'Archive task' })).toBeNull()
  })

  it('Session — the composer carries Archive, so the header shows none', () => {
    stubFetch()
    renderTab(run('done'), 'session')
    expect(headerArchive()).toBeNull()
    expect(actionBar().queryByRole('menuitem', { name: 'Archive task' })).toBeNull()
  })

  it.each(['running', 'waiting', 'queued'] as const)('%s offers no Archive anywhere — it is still active', (status) => {
    stubFetch()
    renderTab(run(status), 'changes')
    expect(headerArchive()).toBeNull()
    expect(actionBar().queryByRole('menuitem', { name: 'Archive task' })).toBeNull()
  })

  it('an archived run offers Unarchive in the header slot', () => {
    stubFetch()
    renderTab(run('done', { archived: true }), 'changes')
    expect(headerArchive()?.textContent).toContain('Unarchive')
  })

  // hearsay-tools/cezarion#1233: Stop takes the composer slot on a failed run holding wait results,
  // so the header carries Archive on the Session tab too, and the kebab still offers Delete.
  const heldFailed = (extra: Partial<ApiRun> = {}) => run('failed', {
    waits: [{
      id: '00000000-0000-4000-8000-0000000000e2', kind: 'timer', source: 'agent', via: 'cezar_wait',
      turnId: 'turn-1', seconds: 60, registeredAt: '2026-09-22T12:00:00.000Z',
      deadline: '2026-09-22T12:01:00.000Z', resolvedAt: '2026-09-22T12:01:00.000Z', phase: 'resolved',
    }],
    ...extra,
  })

  it.each(['session', 'changes'] as const)('%s — a failed run holding wait results gets Archive in the header', (tab) => {
    stubFetch()
    renderTab(heldFailed(), tab)
    expect(headerArchive()?.textContent).toContain('Archive task')
  })

  it('a failed run holding wait results keeps Delete in the kebab', () => {
    stubFetch()
    renderTab(heldFailed(), 'session')
    expect(actionBar().getByRole('menuitem', { name: 'Delete task…' })).toBeTruthy()
  })

  it('Session — the kebab drops Finish, because the composer promoted it', () => {
    stubFetch()
    renderTab(run('waiting'), 'session')
    expect(actionBar().queryByRole('menuitem', { name: 'Finish' })).toBeNull()
  })

  it.each(['changes', 'commits', 'files'] as const)('%s — the kebab never offers Finish', (tab) => {
    stubFetch()
    renderTab(run('waiting'), tab)
    expect(actionBar().queryByRole('menuitem', { name: 'Finish' })).toBeNull()
  })

  it('review has no Finish in the kebab', () => {
    stubFetch()
    renderTab(run('review'), 'session')
    expect(actionBar().queryByRole('menuitem', { name: 'Finish' })).toBeNull()
  })

  it('an ordinary waiting task with a pending ask has Finish promoted, so the kebab drops it', () => {
    stubFetch()
    renderTab(run('waiting', { waits: [openHumanWait()] }), 'session')
    expect(actionBar().queryByRole('menuitem', { name: 'Finish' })).toBeNull()
  })

  it('a blocked root offers no Finish in the kebab', () => {
    stubFetch()
    renderTab(run('waiting', {
      waits: [openHumanWait()],
      delegation: { role: 'root', permissions: [], receipts: [] },
    }), 'session')
    expect(actionBar().queryByRole('menuitem', { name: 'Finish' })).toBeNull()
  })
})

describe('linked issue and PR tabs (#692)', () => {
  const t = (kind: 'issue' | 'pr', number: number) => ({ kind, number })
  const five = [t('pr', 1), t('pr', 2), t('pr', 3), t('pr', 4), t('issue', 5)]
  const tabRow = () => document.querySelector('[data-slot="run-tabs"]') as HTMLElement
  const tabNames = () => within(tabRow()).getAllByRole('link').map((link) => link.getAttribute('aria-label') ?? link.textContent)
  const fiveRefs = (): Partial<ApiRun> => ({
    markerRefs: { pr: 1 },
    pullRequestUrl: 'https://github.com/acme/demo/pull/2',
    referencedPullRequestUrl: 'https://github.com/acme/demo/pull/3',
    prNumber: 4,
    issueNumber: 5,
  })
  const withRepo = () => stubFetch({ '/api/v1/health': () => jsonResponse({ repo: { remote: 'git@github.com:acme/demo.git' } }) })

  it('visibleItemTabs keeps the first three inline and the rest in the overflow', () => {
    expect(visibleItemTabs(five, null)).toEqual({ inline: five.slice(0, 3), overflow: five.slice(3) })
  })

  it('visibleItemTabs moves an active overflow tab into the third inline slot', () => {
    expect(visibleItemTabs(five, t('issue', 5))).toEqual({
      inline: [five[0], five[1], five[4]],
      overflow: [five[2], five[3]],
    })
    // An active tab already inline changes nothing.
    expect(visibleItemTabs(five, t('pr', 2))).toEqual({ inline: five.slice(0, 3), overflow: five.slice(3) })
  })

  it('adds one tab per linked PR and issue after Files', () => {
    stubFetch()
    renderHeader(run('done', { prNumber: 801, issueNumber: 692 }))
    const tabs = within(tabRow())
    expect(tabs.getAllByRole('link').map((link) => link.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Session', 'Changes', 'Commits', 'Files', 'Pull request #801', 'Issue #692',
    ])
    expect(tabs.getByRole('link', { name: 'Pull request #801' }).getAttribute('href')).toBe('/tasks/r1/pr/801')
    expect(tabs.getByRole('link', { name: 'Issue #692' }).getAttribute('href')).toBe('/tasks/r1/issue/692')
    expect(tabs.getByRole('link', { name: 'Pull request #801' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks the item tab active and Session inactive', () => {
    stubFetch()
    renderHeader(run('done', { prNumber: 801, issueNumber: 692 }), undefined, { kind: 'pr', number: 801 })
    const tabs = within(tabRow())
    expect(tabs.getByRole('link', { name: 'Pull request #801' }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: 'Issue #692' }).getAttribute('aria-current')).toBeNull()
    expect(tabs.getByRole('link', { name: 'Session' }).getAttribute('aria-current')).toBeNull()
  })

  it('puts tabs past the third into a +N menu that links to them', async () => {
    withRepo()
    renderHeader(run('done', fiveRefs()))
    const tabs = within(tabRow())
    await waitFor(() => expect(tabs.getByRole('link', { name: 'Pull request #3' })).toBeTruthy())
    expect(tabs.queryByRole('link', { name: 'Pull request #4' })).toBeNull()
    const more = tabs.getByRole('button', { name: '2 more linked items' })
    expect(more.textContent).toBe('+2')
    fireEvent.pointerDown(more)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Pull request #4' }).getAttribute('href')).toBe('/tasks/r1/pr/4')
    expect(within(menu).getByRole('menuitem', { name: 'Issue #5' }).getAttribute('href')).toBe('/tasks/r1/issue/5')
  })

  it('shows the active overflow tab inline', async () => {
    withRepo()
    renderHeader(run('done', fiveRefs()), undefined, { kind: 'issue', number: 5 })
    const tabs = within(tabRow())
    await waitFor(() => expect(tabs.getByRole('link', { name: 'Issue #5' }).getAttribute('aria-current')).toBe('page'))
    expect(tabs.queryByRole('link', { name: 'Pull request #3' })).toBeNull()
  })

  it('a task with no own-repo references keeps exactly the four tabs', () => {
    stubFetch()
    // Without a repo base, a URL reference cannot be proven own, so it gets no tab.
    renderHeader(run('done', { pullRequestUrl: 'https://github.com/other/repo/pull/9' }))
    expect(tabNames()).toEqual(['Session', 'Changes', 'Commits', 'Files'])
    expect(within(tabRow()).queryByRole('button')).toBeNull()
  })

  it('paints the reference status glyph on the item tab', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'acme' }),
      '/api/v1/p/acme/github/ref-status?prs=801': () =>
        jsonResponse({ available: true, prs: { 801: 'merged' }, issues: {}, recheckAfterMs: null }),
    })
    renderHeader(run('done', { prNumber: 801 }))
    const tab = within(tabRow()).getByRole('link', { name: 'Pull request #801' })
    await waitFor(() => expect(tab.querySelector('[data-slot="reference-status-glyph"]')?.getAttribute('data-status')).toBe('merged'))
  })
})

describe('Preview header toggle (#781)', () => {
  const server = (port: number) => ({
    port,
    command: 'npm run dev',
    label: `s${port}`,
    registeredAt: '2026-10-02T10:00:00.000Z',
    answeredAtRegistration: false,
  })
  const health = (preview: boolean) => () =>
    jsonResponse({
      capabilities: { localHandoff: true, followups: false, singleProject: false, tokenMetrics: true, preview },
    })
  const withWorktree = (servers: number[] = []) =>
    run('done', { worktreePath: '/tmp/wt', previewServers: servers.map(server) })

  let client: ReturnType<typeof createQueryClient>
  /** The flag-off cases assert absence: only meaningful once the health answer is in the cache. */
  const healthSettled = () =>
    waitFor(() =>
      expect(client.getQueryCache().getAll().some(query => JSON.stringify(query.queryKey).includes('health') && query.state.status === 'success')).toBe(true),
    )

  function renderToggle(record: ApiRun, pane: Partial<PreviewPane> = {}) {
    const openPane = vi.fn()
    const value: PreviewPane = { open: false, live: false, openPane, ...pane }
    client = createQueryClient()
    render(
      <QueryClientProvider client={client}>
        <PreviewPaneContext.Provider value={value}>
          <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
            <Routes>
              <Route path="/tasks/:id" element={<RunHeader run={record} />} />
            </Routes>
          </MemoryRouter>
        </PreviewPaneContext.Provider>
      </QueryClientProvider>,
    )
    return openPane
  }
  const toggle = () => screen.queryByRole('button', { name: /^Preview/ })

  it('is hidden when the server reports capabilities.preview: false', async () => {
    stubFetch({ '/api/v1/health': health(false) })
    renderToggle(withWorktree([5173]))
    await healthSettled()
    expect(toggle()).toBeNull()
  })

  it('is hidden when the run has no worktree', async () => {
    stubFetch({ '/api/v1/health': health(true) })
    renderToggle(run('done', { previewServers: [server(5173)] }))
    await healthSettled()
    expect(toggle()).toBeNull()
  })

  it('reads Preview with no servers, Preview :5173 with one, Preview :5173 +1 with two', async () => {
    stubFetch({ '/api/v1/health': health(true) })
    renderToggle(withWorktree())
    expect((await screen.findByRole('button', { name: /^Preview/ })).textContent).toBe('Preview')
    cleanup()
    renderToggle(withWorktree([5173]))
    expect((await screen.findByRole('button', { name: /^Preview/ })).textContent).toBe('Preview :5173')
    cleanup()
    renderToggle(withWorktree([5173, 3000]))
    expect((await screen.findByRole('button', { name: /^Preview/ })).textContent).toBe('Preview :5173 +1')
  })

  it('opens the pane on the one server, on the empty state otherwise, and never asks to run', async () => {
    stubFetch({ '/api/v1/health': health(true) })
    let openPane = renderToggle(withWorktree([5173]))
    fireEvent.click(await screen.findByRole('button', { name: /^Preview/ }))
    expect(openPane).toHaveBeenCalledTimes(1)
    expect(openPane).toHaveBeenCalledWith({ port: 5173 })
    cleanup()
    openPane = renderToggle(withWorktree([5173, 3000]))
    fireEvent.click(await screen.findByRole('button', { name: /^Preview/ }))
    expect(openPane).toHaveBeenCalledWith({})
    for (const [request] of openPane.mock.calls) expect(request).not.toHaveProperty('run')
  })

  it('shows the green dot only while the pane is live', async () => {
    stubFetch({ '/api/v1/health': health(true) })
    renderToggle(withWorktree([5173]), { open: true, live: false })
    const button = await screen.findByRole('button', { name: /^Preview/ })
    expect(button.querySelector('[data-slot="status-dot"]')).toBeNull()
    cleanup()
    renderToggle(withWorktree([5173]), { open: true, live: true })
    const live = await screen.findByRole('button', { name: /^Preview/ })
    expect(live.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
  })

  it('has no toggle outside a pane provider (the git tabs)', async () => {
    stubFetch({ '/api/v1/health': health(true) })
    renderHeader(withWorktree([5173]))
    await act(async () => {})
    expect(toggle()).toBeNull()
  })
})
