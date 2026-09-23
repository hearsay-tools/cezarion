import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { GlobalEventsProvider } from '@/api/global-events'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type {
  ApiRun,
  HealthResponse,
  ProviderStatusResponse,
  RunEvent,
  RunStatus,
} from '@open-mercato/cezar-api-client'

import { TaskThreadRoute, ThreadView } from './task-thread'
import { buildTranscriptRows, mainTranscriptSections } from './session-transcript'
import { reduceThread } from './thread-state'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** ThreadView now hosts the run header, whose hooks need a query client (mutations, the runs
 *  list) and a router (tabs, delete-navigates-home). Data assertions still drive the reduced
 *  fixture states directly — the providers are plumbing, not fixtures.
 *
 *  `health` is served on `/api/v1/health`: the footer's issue link is synthesized against the
 *  project's own repo remote (#526), so a test that wants one must say which repo this is. */
function renderView(
  ui: ReactElement,
  providerStatus: ProviderStatusResponse = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'not-installed', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  },
  health: Partial<HealthResponse> = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      const body =
        path === '/api/v1/models?runner=claude' ? { runner: 'claude', models: [], source: 'unavailable', stale: false }
        : path === '/api/v1/providers/status' ? providerStatus
        : path === '/api/v1/health' ? health
        : path.endsWith('/relationships') ? { workers: [] }
        : []
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )
  // The client is handed back so a test can await a specific query landing in the cache —
  // the only honest barrier for asserting that something is absent *after* data arrived.
  const queryClient = createQueryClient()
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient,
  }
}

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    finishBlocked: null,
    id: 'r1',
    title: 'do the thing plz',
    titleSummary: 'Do the thing',
    workflow: 'quick-task',
    task: 'Summarize what this project does.',
    status,
    createdAt: '2026-07-14T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }) as ApiRun

const line = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: '2026-07-14T12:00:00.000Z', type, ...rest }) as RunEvent

/** A small real-shaped transcript: dim lines, a v2 message, a tool, a v1 user reply. */
const EVENTS: RunEvent[] = [
  line(1, 'lifecycle', { message: 'run started — workflow "quick-task" (runner: claude)' }),
  line(2, 'note', { message: 'worktree ready — branch cez/r1 (base main)' }),
  line(3, 'turn.started', { turnId: 'turn_1' }),
  line(4, 'item.completed', {
    item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'It is a **cockpit** for agents.' },
  }),
  line(5, 'item.completed', {
    item: { kind: 'tool', id: 'toolu_1', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'completed', output: 'ok' },
  }),
  line(6, 'item.completed', { item: { kind: 'reasoning', id: 'item_2', text: 'Considering the layout…' } }),
  line(7, 'user-message', { text: 'Thanks!', imageCount: 2 }),
]

const transcriptRows = (fixture: ApiRun, thread = reduceThread(EVENTS)) =>
  buildTranscriptRows(mainTranscriptSections(fixture, thread), fixture.id)

describe('ThreadView', () => {
  it('keeps provider authorization recovery visible after the run reaches done', () => {
    const authRequired = [
      line(1, 'provider-auth-required', { provider: 'codex', authFailureId: 'incident-1' }),
      line(2, 'done'),
    ]
    renderView(<ThreadView run={run('done')} thread={reduceThread(authRequired)} />)

    expect(screen.getByRole('alert').textContent).toContain('This run needed Codex authorization')
    expect(screen.getByRole('link', { name: 'Open provider settings' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
  })

  it('an issue-subject closed run links its DISCOVERED issue URL, never the incidental PR (#526)', () => {
    const issueRun = run('done', {
      markerRefs: { issue: 524 },
      referencedIssueUrl: 'https://github.com/o/r/issues/524',
      // An unrelated PR that only appeared in the transcript — it must not surface.
      referencedPullRequestUrl: 'https://github.com/o/r/pull/454',
    })
    renderView(<ThreadView run={issueRun} thread={reduceThread([line(1, 'done')])} />)

    const issueLink = document.querySelector('[data-slot="issue-link"]')
    expect(issueLink?.getAttribute('href')).toBe('https://github.com/o/r/issues/524')
    // Defect B: the incidental PR is not linked in the footer.
    expect(document.querySelector('[data-slot="thread-footer"] [data-slot="pr-link"]')).toBeNull()
  })

  it('renders the task as the leading user bubble and the v1 reply as another', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const bubbles = document.querySelectorAll('[data-slot="user-bubble"]')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]!.textContent).toContain('Summarize what this project does.')
    expect(bubbles[1]!.textContent).toContain('Thanks!')
    expect(bubbles[1]!.textContent).toContain('2 images attached')
  })

  it('turns the screenshot-shaped provisional marker into option cards without exposing JSON', () => {
    const questions = [
      {
        header: 'Who books',
        question: 'Who should be able to create bookings in v1?',
        multiSelect: false,
        options: [
          { label: 'Staff only', description: 'Backend/admin CRUD only for v1' },
          { label: 'Staff + customer self-service', description: 'Also let customers book through the portal' },
        ],
      },
    ]
    const raw = `later:\n\nCEZ:ASK ${JSON.stringify({ questions })}`
    const events = [
      line(1, 'item.completed', {
        item: { kind: 'message', id: 'ask-message', role: 'assistant', text: raw },
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(events, { activeTurn: true })} />)
    expect(document.body.textContent).toContain('later:')
    expect(document.body.textContent).not.toContain('CEZ:ASK')

    cleanup()
    const settled = [...events, line(2, 'ask.requested', { requestId: 'ask-screenshot', questions })]
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(settled)} />)
    expect(document.body.textContent).not.toContain('CEZ:ASK')
    expect(screen.getByText('Staff only')).not.toBeNull()
    expect(screen.getByText('Staff + customer self-service')).not.toBeNull()
  })

  it('renders assistant messages as markdown, not raw text', async () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    // The ** marks became a strong element (Streamdown spells it as a data-tagged span) —
    // the renderer parsed, it didn't echo.
    await waitFor(() => {
      const strong = document.querySelector('[data-slot="assistant-message"] [data-streamdown="strong"]')
      expect(strong?.textContent).toBe('cockpit')
    })
    expect(document.querySelector('[data-slot="assistant-message"]')?.textContent).not.toContain('**')
  })

  it('renders USER messages as markdown too, not raw text (#524)', async () => {
    // A GitHub hand-off prompt is markdown — a `#N` line, a bare link, a `---` rule — so the
    // bubble that echoes it back must parse it, exactly as the assistant side does. Rendering
    // one side raw made the same document look broken going in and fine coming out.
    const events = [
      line(1, 'user-message', { text: 'Fix **now**: see https://github.com/acme/demo/issues/142' }),
    ]
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(events)} />)

    await waitFor(() => {
      const strong = document.querySelector('[data-slot="user-bubble"] [data-streamdown="strong"]')
      expect(strong?.textContent).toBe('now')
    })
    const bubble = [...document.querySelectorAll('[data-slot="user-bubble"]')].at(-1)
    expect(bubble?.textContent).not.toContain('**')
  })

  it('dims lifecycle lines and shows the tool card + folded reasoning', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const notes = [...document.querySelectorAll('[data-slot="note-line"]')]
    expect(notes.map((n) => n.getAttribute('data-tone'))).toEqual(['dim', 'dim'])
    expect(notes[1]!.textContent).toContain('worktree ready')

    const toolCard = document.querySelector('[data-slot="tool-card"]')
    expect(toolCard?.textContent).toContain('Ran')
    expect(toolCard?.textContent).toContain('npm test')
    expect(toolCard?.getAttribute('data-status')).toBe('completed')

    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('Thinking — Considering the layout…')
  })

  it('shows the header title (auto-summary, never the raw title) and the status pill', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain('needs you')
  })

  it('waiting → the paused hint (pulsing dot) in the dock, right above an ENABLED composer', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const hint = document.querySelector('[data-slot="thread-dock"] [data-slot="paused-hint"]')
    expect(hint?.textContent).toContain('The agent is paused, waiting for your reply')
    expect(hint?.querySelector('[data-slot="status-dot"]')).not.toBeNull()
    // No body footer for waiting — the dock owns that state now.
    expect(document.querySelector('[data-slot="thread-footer"]')).toBeNull()
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Reply — / for skills, @ for files…')
  })

  it('failed by a usage limit → the dock says when it resumes itself, and links the setting', () => {
    renderView(
      <ThreadView
        run={run('failed', {
          error: 'step "work" failed: Claude AI usage limit reached|1754236800',
          autoResumeAt: '2026-08-03T17:00:30.000Z',
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    const hint = document.querySelector('[data-slot="thread-dock"] [data-slot="auto-resume-hint"]')
    expect(hint?.textContent).toContain('Usage limit reached — this task resumes automatically at')
    // To the SECOND: "6:41 PM" cannot tell a wait that is nearly over from one that just
    // started. Matched as a pattern because the rendered zone is the reader's own.
    expect(hint?.querySelector('time')?.textContent).toMatch(/:\d{2}:30\b/)
    // The absolute instant is the source of truth, not a countdown (spec
    // 2026-08-03-auto-resume-after-usage-limit).
    expect(hint?.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-03T17:00:30.000Z')
    // The other half of an automation nobody opted into: one click to switch it off.
    expect(screen.getByRole('link', { name: 'Auto-resume settings' }).getAttribute('href')).toBe(
      '/settings/global/resources',
    )
  })

  it('offers a per-task opt-out that hits DELETE /auto-resume for THIS run only', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' })
        const body = String(input).endsWith('/auto-resume') ? { cancelled: true } : []
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView
            run={run('failed', { autoResumeAt: '2026-08-03T17:00:30.000Z' })}
            thread={reduceThread(EVENTS)}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Don’t resume' }))
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/runs/r1/auto-resume'))).toBe(true),
    )
  })

  it('an ordinary failure has no resume hint — the promise is only made when the server armed one', () => {
    renderView(<ThreadView run={run('failed', { error: 'boom' })} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="auto-resume-hint"]')).toBeNull()
  })

  it('running → the composer stays enabled with the "message" placeholder, no paused hint', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="paused-hint"]')).toBeNull()
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Message the agent — / for skills, @ for files…')
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }],
  ] as const)('keeps a queued Codex prompt authorable when fallback Claude is %s', async (_case, claude) => {
    renderView(
      // Before the run starts, an omitted runner means the server will use its configured
      // default (Codex in the reported case). The active-provider helper used to guess Claude
      // here and block a mutation that invokes no provider at all.
      <ThreadView run={run('queued', { runner: undefined })} thread={reduceThread([])} />,
      {
        providers: [
          claude,
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    )

    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.disabled).toBe(false))
    expect(textarea.placeholder).toBe('Add to the prompt — sent when the run starts…')
    expect(screen.queryByRole('link', { name: 'Configure providers' })).toBeNull()
  })

  it('keeps a waiting composer enabled when a retrying current step uses a usable provider', async () => {
    renderView(
      <ThreadView
        run={run('waiting', {
          runner: 'claude',
          currentStepId: 'retry',
          steps: [{ id: 'retry', name: 'Retry', kind: 'agent', status: 'waiting', iterations: 2, tokensUsed: 0, backend: 'codex' }],
        })}
        thread={reduceThread(EVENTS)}
      />,
      {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    )

    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.disabled).toBe(false))
  })

  it('monitoring → no paused hint, "message" placeholder, and a "monitoring" pill (#490)', () => {
    renderView(<ThreadView run={run('running', { activity: 'monitoring' })} thread={reduceThread(EVENTS)} />)
    // Still working on downstream work, not on you: never the "paused, waiting for your reply" banner.
    expect(document.querySelector('[data-slot="paused-hint"]')).toBeNull()
    expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain('monitoring')
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Message the agent — / for skills, @ for files…')
  })

  /** A closed run with a session to resume is still AUTHORABLE: Continue takes a prompt, so
   *  the composer stays live and its send is that Continue. */
  it('closed but resumable → the composer stays enabled, and sending is Continue', async () => {
    renderView(
      <ThreadView
        run={run('done', {
          steps: [
            { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
          ],
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.disabled).toBe(false))
    expect(textarea.placeholder).toBe('Continue — add a prompt, or send to just reopen the session…')
    // Empty is still the one-click Continue, so send is live with nothing typed.
    expect((screen.getByLabelText('Continue') as HTMLButtonElement).disabled).toBe(false)
    // The engine pills ride along, so the prompt and the picked backend go in one request.
    expect(document.querySelector('[data-slot="follow-up-engine"]')).not.toBeNull()
  })

  /** #472 — stacked messages render as their own bubbles, after the task. */
  it('renders one bubble per stacked message, in order, with their images', () => {
    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [
            { id: 'm1', text: 'also update the changelog', createdAt: '2026-07-21T10:00:00.000Z' },
            {
              id: 'm2',
              text: 'and bump the version',
              images: ['/api/v1/runs/r1/images/pasted-1.png'],
              createdAt: '2026-07-21T10:01:00.000Z',
            },
          ],
        })}
        thread={reduceThread([])}
      />,
    )
    const bubbles = [...document.querySelectorAll('[data-slot="user-bubble"]')].map(
      (b) => b.textContent ?? '',
    )
    expect(bubbles[0]).toContain('Summarize what this project does.')
    expect(bubbles[1]).toContain('also update the changelog')
    expect(bubbles[2]).toContain('and bump the version')
    expect(
      document.querySelector('img[src="/api/v1/runs/r1/images/pasted-1.png"]'),
    ).not.toBeNull()
  })

  /**
   * The no-regression assertion, at the row-builder level rather than the DOM:
   * an absent stack and an empty one must produce the same rows, and a run with
   * no stack must produce exactly today's rows. Asserting on the shared row builder's
   * keys keeps this free of Radix's per-render generated ids.
   */
  it('builds the same rows whether the stack is absent or empty', () => {
    const keys = (extra: Partial<ApiRun>) =>
      transcriptRows(run('queued', extra)).map((r) => r.key)

    const absent = keys({})
    expect(absent[0]).toBe('task')
    // No `queued:` row is invented for a run that has none.
    expect(absent.some((k) => k.startsWith('queued:'))).toBe(false)
    expect(keys({ queuedMessages: [] })).toEqual(absent)
  })

  it('inserts the stacked rows directly after the task row, in order', () => {
    const keys = transcriptRows(
      run('queued', {
        queuedMessages: [
          { id: 'm1', text: 'one', createdAt: '2026-07-21T10:00:00.000Z' },
          { id: 'm2', text: 'two', createdAt: '2026-07-21T10:01:00.000Z' },
        ],
      }),
    ).map((r) => r.key)

    expect(keys.slice(0, 3)).toEqual(['task', 'queued:m1', 'queued:m2'])
    // …and the rest of the transcript is untouched behind them.
    expect(keys.slice(3)).toEqual(
      transcriptRows(run('queued')).map((r) => r.key).slice(1),
    )
  })

  /**
   * Review fix: the affordance callbacks are memoized on the mutations' `mutateAsync`
   * functions, not on the mutation RESULT objects — TanStack returns a fresh result object
   * every render, which would rebuild every thread row each time and defeat the memo that
   * exists because these threads get big enough to virtualize.
   *
   * Asserted as the observable consequence: re-rendering with identical inputs neither
   * duplicates nor loses the affordances, and the row builder is pure.
   */
  it('re-renders a queued run without duplicating or losing the affordances', () => {
    const fixture = run('queued', {
      queuedMessages: [{ id: 'm1', text: 'stacked', createdAt: '2026-07-21T10:00:00.000Z' }],
    })
    const thread = reduceThread(EVENTS)

    // The row builder is pure: same inputs, same rows.
    expect(transcriptRows(fixture, thread).map((r) => r.key)).toEqual(
      transcriptRows(fixture, thread).map((r) => r.key),
    )

    const { rerender } = renderView(<ThreadView run={fixture} thread={thread} />)
    expect(screen.getAllByLabelText('Remove message')).toHaveLength(1)
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView run={fixture} thread={thread} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getAllByLabelText('Remove message')).toHaveLength(1)
    expect(screen.getAllByLabelText('Edit message')).toHaveLength(1)
  })

  /** #472 — the edit/remove affordances exist only while the run is queued. */
  it('offers edit + remove on stacked bubbles and edit-only on the prompt, while queued', () => {
    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'stacked', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    // The prompt is editable but never removable — a run with no prompt is not a run.
    expect(screen.getByLabelText('Edit the prompt')).toBeTruthy()
    expect(screen.getAllByLabelText('Edit message')).toHaveLength(1)
    expect(screen.getAllByLabelText('Remove message')).toHaveLength(1)
  })

  it('renders the bubbles read-only once the run is running', () => {
    renderView(
      <ThreadView
        run={run('running', {
          queuedMessages: [{ id: 'm1', text: 'stacked', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    expect(screen.queryByLabelText('Edit the prompt')).toBeNull()
    expect(screen.queryByLabelText('Edit message')).toBeNull()
    expect(screen.queryByLabelText('Remove message')).toBeNull()
  })

  it('PATCHes the edited text, and Escape cancels without writing', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []

    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'typo here', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    // Stubbed AFTER render: renderView installs its own fetch stub, and the mutations
    // only fire on the clicks below.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        // GET answers `[]`: our own invalidateQueries refetches the runs LIST, and the
        // header's queuePositions would choke on a non-array.
        const body = (init?.method ?? 'GET') === 'GET' ? '[]' : '{}'
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )

    // Escape first: opens the editor, changes the text, cancels — nothing is written.
    fireEvent.click(screen.getAllByLabelText('Edit message')[0]!)
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'discarded' } })
    fireEvent.keyDown(screen.getByLabelText('Edit the message'), { key: 'Escape' })
    expect(screen.queryByLabelText('Edit the message')).toBeNull()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)

    // Then a real edit.
    fireEvent.click(screen.getAllByLabelText('Edit message')[0]!)
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'fixed now' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toContain('/queued-messages/m1')
    expect(patch.body).toMatchObject({ text: 'fixed now' })
  })

  it('keeps a failed edit open and surfaces the server error', async () => {
    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'typo here', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(
        new Response(JSON.stringify({ error: 'run already started' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      )),
    )

    fireEvent.click(screen.getAllByLabelText('Edit message')[0]!)
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'fixed now' } })
    fireEvent.click(screen.getByText('Save'))

    expect((await screen.findByRole('alert')).textContent).toContain('run already started')
    expect((screen.getByLabelText('Edit the message') as HTMLTextAreaElement).value).toBe('fixed now')
  })

  it('DELETEs a removed message', async () => {
    const calls: string[] = []

    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'remove me', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'DELETE') calls.push(String(input))
        // GET answers `[]`: our own invalidateQueries refetches the runs LIST, and the
        // header's queuePositions would choke on a non-array.
        const body = (init?.method ?? 'GET') === 'GET' ? '[]' : '{}'
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )
    fireEvent.click(screen.getAllByLabelText('Remove message')[0]!)
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toContain('/queued-messages/m1')
  })

  it('PATCHes the run itself when the initial prompt is edited', async () => {
    const bodies: unknown[] = []

    renderView(<ThreadView run={run('queued')} thread={reduceThread([])} />)
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PATCH' && !String(input).includes('queued-messages')) {
          bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
        }
        // GET answers `[]`: our own invalidateQueries refetches the runs LIST, and the
        // header's queuePositions would choke on a non-array.
        const body = (init?.method ?? 'GET') === 'GET' ? '[]' : '{}'
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )
    fireEvent.click(screen.getByLabelText('Edit the prompt'))
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'a better prompt' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ task: 'a better prompt' })
  })

  /** #472 — a queued run has not started, so its prompt is still authorable. */
  it('queued → the composer is ENABLED with its own placeholder and hint, and no Continue', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread(EVENTS)} />)
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Add to the prompt — sent when the run starts…')
    expect(document.querySelector('[data-slot="queued-hint"]')?.textContent).toContain(
      'folded into the prompt before the run starts',
    )
    // Continue is meaningless for a run that has not run, so no engine pills either.
    expect(document.querySelector('[data-slot="follow-up-engine"]')).toBeNull()
  })

  /**
   * The scope boundary: the queued branch is `queued` ONLY, and the composer only stays live
   * on a closed run that HAS a session to resume. This `done` run has none, so it is the one
   * remaining genuinely-disabled state — and it is told so honestly, without offering a
   * Continue it cannot perform.
   */
  it('closed with no resumable session → disabled composer, and no Continue invented', () => {
    renderView(<ThreadView run={run('done')} thread={reduceThread(EVENTS)} />)
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Session closed — no session to resume.')
    expect(document.querySelector('[data-slot="follow-up-engine"]')).toBeNull()
    expect(document.querySelector('[data-slot="queued-hint"]')).toBeNull()
  })

  it('done → the closed footer; failed → the danger footer carrying the run error', () => {
    renderView(<ThreadView run={run('done')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="thread-footer"]')?.textContent).toBe('Session closed')
    cleanup()

    renderView(<ThreadView run={run('failed', { error: 'checks failed' })} thread={reduceThread(EVENTS)} />)
    const footer = document.querySelector('[data-slot="thread-footer"]')
    expect(footer?.textContent).toBe('Session failed — checks failed')
    expect(footer?.className).toContain('text-danger')
  })

  /**
   * #526 at the surface the user actually reported: run `6ab44452` (`om-prepare-issue`) created
   * issue #524, declared `CEZ:ISSUE` and no `CEZ:PR`, and had one incidental PR (#454) scraped
   * out of its duplicate-search output. The footer linked #454 and never linked #524. Asserting
   * on the rendered anchors — not just the helpers — is what makes deleting or miswiring the
   * JSX fail.
   */
  it('an issue-subject closed run SYNTHESIZES its issue link from the project repo (#526)', async () => {
    renderView(
      <ThreadView
        run={run('done', {
          issueNumber: 524,
          markerRefs: { issue: 524 },
          referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/454',
          referencedPrCandidates: ['https://github.com/open-mercato/cezar/pull/454'],
        })}
        thread={reduceThread(EVENTS)}
      />,
      undefined,
      { repo: { root: '/repo', branch: 'main', remote: 'git@github.com:open-mercato/cezar.git' } },
    )
    await waitFor(() => {
      expect(document.querySelector('[data-slot="issue-link"]')).not.toBeNull()
    })
    const footer = document.querySelector('[data-slot="thread-footer"]')
    expect(footer?.querySelector('[data-slot="issue-link"]')?.getAttribute('href')).toBe(
      'https://github.com/open-mercato/cezar/issues/524',
    )
    expect(footer?.querySelector('[data-slot="issue-link"]')?.textContent).toContain('Issue')
    expect(footer?.querySelector('[data-slot="pr-link"]')).toBeNull()
  })

  /**
   * `/health` is workspace-level — the server builds it from the BOOT project's root whatever
   * the URL is scoped to. So a task belonging to another registered project must synthesize
   * nothing: a link built from the boot project's remote would name a completely different
   * repository, which is #526's defect wearing a different hat.
   */
  it('a task in a non-boot project synthesizes no issue link — health names the wrong repo (#526)', async () => {
    const issueRun = run('done', { markerRefs: { issue: 524 } })
    const health = {
      bootProject: 'cezar',
      repo: { root: '/repo', branch: 'main', remote: 'git@github.com:open-mercato/cezar.git' },
    }

    // Control — unscoped IS the boot project, so health's remote really is this task's repo.
    renderView(<ThreadView run={issueRun} thread={reduceThread(EVENTS)} />, undefined, health)
    await waitFor(() => {
      expect(document.querySelector('[data-slot="issue-link"]')?.getAttribute('href')).toBe(
        'https://github.com/open-mercato/cezar/issues/524',
      )
    })
    cleanup()

    // Scoped to a DIFFERENT registered project: same health, and the link must stay away.
    const { queryClient } = renderView(
      <ProjectScopeProvider projectId="other-project">
        <ThreadView run={issueRun} thread={reduceThread(EVENTS)} />
      </ProjectScopeProvider>,
      undefined,
      health,
    )
    // Health HAS arrived under this scope — the missing link is a refusal, not a slow render.
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.health)).toBeDefined())
    expect(document.querySelector('[data-slot="issue-link"]')).toBeNull()
  })

  it('a PR-subject closed run still gets its PR link and no invented issue link (#526)', () => {
    renderView(
      <ThreadView
        run={run('done', { pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/900' })}
        thread={reduceThread(EVENTS)}
      />,
      undefined,
      { repo: { root: '/repo', branch: 'main', remote: 'git@github.com:open-mercato/cezar.git' } },
    )
    const footer = document.querySelector('[data-slot="thread-footer"]')
    expect(footer?.querySelector('[data-slot="pr-link"]')?.getAttribute('href')).toBe(
      'https://github.com/open-mercato/cezar/pull/900',
    )
    expect(footer?.querySelector('[data-slot="issue-link"]')).toBeNull()
  })

  it('running → no footer (the stream itself is the status), and no invented empty state', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="thread-footer"]')).toBeNull()
    expect(document.querySelector('[data-slot="thread-empty"]')).toBeNull()
  })

  it('an eventless run says so instead of rendering blank space', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread([])} />)
    expect(document.querySelector('[data-slot="thread-empty"]')?.textContent).toBe('No session events yet.')
  })

  it('an eventless QUEUED run gets the queued placeholder, not the generic empty line (#351)', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread([])} />)
    const placeholder = document.querySelector('[data-slot="queued-state"]')
    expect(placeholder?.textContent).toContain('Waiting for a free agent slot')
    expect(placeholder?.textContent).toContain('quick-task · starts automatically')
    expect(document.querySelector('[data-slot="thread-empty"]')).toBeNull()
  })

  it('the first real event replaces the queued placeholder', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread([line(1, 'lifecycle', { message: 'cezar restarted — task re-queued' })])} />)
    expect(document.querySelector('[data-slot="queued-state"]')).toBeNull()
    expect(document.querySelector('[data-slot="note-line"]')?.textContent).toContain('re-queued')
  })

  it('groups session activity into the dock and leaves the header rail off the session tab', () => {
    renderView(
      <ThreadView
        run={run('running', {
          steps: [
            { id: 'task', name: 'Do the task', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 },
            { id: 'verify', name: 'Verify', kind: 'check', status: 'pending', iterations: 1, tokensUsed: 0 },
          ],
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    expect(document.querySelector('[data-slot="run-activity-dock"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="plan-dock"]')).toBeNull()
    expect(document.querySelector('[data-slot="plan-mirror"]')).toBeNull()
    expect(document.querySelector('[data-slot="run-header"] [data-slot="workflow-steps"]')).toBeNull()
    const dock = document.querySelector('[data-slot="run-activity-dock"]')!
    expect(dock.textContent).toContain('Run activity')
    // Only the workflow has anything to show in this fixture — the count is honest about it.
    expect(dock.textContent).toContain('1 section')
    expect(dock.textContent).toContain('Working')
    // The workflow row is titled by the step the run is on, not by the word "Workflow".
    expect(document.querySelector('[data-slot="run-activity-workflow"]')?.textContent).toContain('Do the task')
  })

  it('quarantined delegation metadata adds no workers section — and no dock of its own', () => {
    // `{ role: 'invalid' }` is what the contract parks unreadable metadata as, and
    // RunRelationshipsPanel renders nothing for it. Counting it as a section would inflate the
    // dock's tally and leave an empty bordered panel behind.
    renderView(<ThreadView run={run('done', { delegation: { role: 'invalid' } } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="run-activity-workers"]')).toBeNull()
    expect(document.querySelector('[data-slot="run-activity-dock"]')).toBeNull()
  })

  it('a live run is never reported as All complete, however quiet its rows are', () => {
    // A parent parked on its workers has no workflow, agent or plan rows at all, and a running
    // run's visible items settle between turns — completeness is a claim about the run.
    const delegation = { role: 'root', permissions: [], receipts: [] }
    renderView(<ThreadView run={run('waiting', { id: 'dock-waiting', delegation } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />)
    const status = document.querySelector('[data-slot="run-activity-status"]')?.textContent
    expect(status).not.toContain('All complete')
    expect(status).toContain('In progress')
  })

  it.each(['failed', 'cancelled'] as const)('a %s workflow step never reads All complete', (status) => {
    // A terminal run is not a successful one. Failed sub-agents already keep the green summary
    // away (`subagentCounts` counts only `completed`); a failed or cancelled STEP must too,
    // or the card contradicts the rail's danger X one click below it.
    const steps = [{ id: 'task', name: 'Do the task', kind: 'agent', status, iterations: 1, tokensUsed: 0 }]
    renderView(<ThreadView run={run('done', { id: `dock-${status}`, steps } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />)
    const summary = document.querySelector('[data-slot="run-activity-status"]')?.textContent
    expect(summary).not.toContain('All complete')
    // Not "In progress" either: the run is over, so the header names an outcome (#402 feedback).
    expect(summary).toContain('Incomplete')
  })

  it('a finished run with everything settled still reads All complete', () => {
    const steps = [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }]
    renderView(<ThreadView run={run('done', { id: 'dock-done', steps } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="run-activity-status"]')?.textContent).toContain('All complete')
  })

  it.each([
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ] as const)('a %s run says so instead of All complete', (status, summary) => {
    // `runIsTerminal` is true for every settled status, but settled is not successful: a run
    // that failed with a finished workflow behind it was reading the green "All complete".
    const steps = [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }]
    renderView(<ThreadView run={run(status, { id: `dock-${status}`, steps } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />)
    const status_ = document.querySelector('[data-slot="run-activity-status"]')?.textContent
    expect(status_).not.toContain('All complete')
    expect(status_).toContain(summary)
  })

  it('a run parked at the review gate is not complete either', () => {
    // Parked awaiting a human, like a `review` STEP, which `railVisual` calls active.
    const steps = [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }]
    renderView(<ThreadView run={run('review', { id: 'dock-review', steps } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="run-activity-status"]')?.textContent).not.toContain('All complete')
  })

  it('the dock re-derives its collapse default per run, like the docks it replaced', () => {
    const steps = [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 }]
    const { rerender } = renderView(
      <ThreadView run={run('running', { id: 'dock-run-a', steps } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Run activity/ }))
    expect(document.querySelector('[data-slot="run-activity-dock"]')?.getAttribute('data-state')).toBe('collapsed')

    // The route does not remount between tasks: only the run prop changes.
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView run={run('running', { id: 'dock-run-b', steps } as Partial<ApiRun>)} thread={reduceThread(EVENTS)} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(document.querySelector('[data-slot="run-activity-dock"]')?.getAttribute('data-state')).toBe('open')
  })

  it('a plan in the stream → the dock above the composer area + the compact header mirror', () => {
    const withPlan: RunEvent[] = [
      ...EVENTS,
      line(8, 'plan.updated', {
        entries: [
          { content: 'Read the docs', status: 'completed' },
          { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
          { content: 'Reply', status: 'pending' },
        ],
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(withPlan)} />)
    expect(document.querySelector('[data-slot="run-activity-dock"]')).not.toBeNull()
    // The plan is a section of the one dock now — its own card is gone, its meter moved.
    expect(document.querySelector('[data-slot="plan-dock"]')).toBeNull()
    expect(
      document.querySelector('[data-slot="run-activity-plan"] [data-slot="run-activity-meta"]')?.textContent,
    ).toBe('1 of 3 complete')
    expect(document.querySelector('[data-slot="plan-mirror"]')).toBeNull()
    // The workflow rail has moved into the session dock, so the header stays clear.
    expect(document.querySelector('[data-slot="run-header"] [data-slot="workflow-steps"]')).toBeNull()
  })

  it('plan-kind tool cards stay out of the thread — the dock is their surface (#382)', () => {
    const todoInput = {
      todos: [
        { content: 'Read the docs', status: 'completed', activeForm: 'Reading the docs' },
        { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
      ],
    }
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', {
        item: { kind: 'tool', id: 'toolu_todo', name: 'TodoWrite', toolKind: 'plan', title: 'Update plan', status: 'running', input: todoInput },
      }),
      line(3, 'plan.updated', { entries: todoInput.todos }),
      line(4, 'item.completed', {
        item: { kind: 'tool', id: 'toolu_todo', name: 'TodoWrite', toolKind: 'plan', title: 'Update plan', status: 'completed', input: todoInput },
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(events)} />)
    expect(document.querySelector('[data-slot="tool-card"]')).toBeNull()
    expect(document.querySelector('[data-slot="run-activity-plan"]')).not.toBeNull()
  })
})

/** The bounded-history routes the thread route hydrates from (progressive-history spec): the
 *  newest page and the compact current-state context. The route-level suites below are about the
 *  RECORD — the auto-resume hint, the read receipt — not the transcript, so they answer both with
 *  an honest empty session. A catch-all `{}` would not do: these are typed payloads the hook
 *  reads directly, so an unmodelled route makes the whole thread fail for a reason that has
 *  nothing to do with what the test is proving. */
const EMPTY_HISTORY_PAGE = {
  events: [],
  itemCount: 0,
  liveCursor: 'live-0',
  asOfSeq: 0,
  hasOlder: false,
}
const EMPTY_HISTORY_CONTEXT = { contextEvents: [], asOfSeq: 0 }

/** The history payload for `path`, or `undefined` when it is not a history route — so each fetch
 *  stub below keeps its own routing table and only defers the two shared shapes to here. */
function historyBodyFor(path: string, id: string): unknown {
  if (path === `/api/v1/runs/${id}/history`) return EMPTY_HISTORY_PAGE
  if (path === `/api/v1/runs/${id}/history-context`) return EMPTY_HISTORY_CONTEXT
  return undefined
}

/** Route-level GETs through the real fetch boundary. jsdom has no EventSource unless a
 * test installs one explicitly; these ordinary loading/error cases need no stream. */
function renderRoute(id: string, queryClient = createQueryClient(), withStream = false) {
  const route = (
    <MemoryRouter initialEntries={[`/tasks/${id}`]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskThreadRoute />} />
      </Routes>
    </MemoryRouter>
  )
  render(
    <QueryClientProvider client={queryClient}>
      {withStream ? <GlobalEventsProvider>{route}</GlobalEventsProvider> : route}
    </QueryClientProvider>,
  )
  return queryClient
}

describe('TaskThreadRoute', () => {
  it('is honestly loading while /api/v1/runs/:id has not answered', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    renderRoute('r1')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Loading task…')
    expect(document.querySelector('[data-route="task-thread"]')).not.toBeNull()
  })

  it('renders the auto-resume hint from what GET /runs/:id actually answers', async () => {
    // The whole path, not just the component: the record shape is copied verbatim from a live
    // `GET /api/v1/runs/:id` after a `mock:limit` run, so a field that survives the server but
    // gets lost between fetch, cache and dock fails here (spec
    // 2026-08-03-auto-resume-after-usage-limit).
    const record = {
      id: 'r1',
      title: 'mock:limit ship it',
      workflow: 'quick-task',
      task: 'mock:limit ship it',
      status: 'failed',
      error: 'step "task" failed: Claude AI usage limit reached|1785785603',
      autoResumeAt: '2026-08-03T19:33:53.000Z',
      createdAt: '2026-08-03T19:23:00.000Z',
      finishedAt: '2026-08-03T19:23:13.000Z',
      tokensUsed: 0,
      archived: false,
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0, sessionId: 's1' }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input)
        const history = historyBodyFor(path, 'r1')
        const body =
          history !== undefined ? history : path === '/api/v1/runs/r1' ? record : path === '/api/v1/health' ? {} : []
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )
    renderRoute('r1')
    const hint = await waitFor(() => {
      const found = document.querySelector('[data-slot="auto-resume-hint"]')
      expect(found).not.toBeNull()
      return found
    })
    expect(hint?.textContent).toContain('Usage limit reached — this task resumes automatically at')
  })

  it('a genuine non-404 GET failure shows the load error, not a missing task', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      const history = historyBodyFor(path, 'r1')
      return Promise.resolve(history !== undefined
        ? new Response(JSON.stringify(history), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'server unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }))
    }))
    renderRoute('r1')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Could not load this task'), { timeout: 3_000 })
    expect(document.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('danger')
    expect(screen.queryByText('Task not found')).toBeNull()
  })

  it('unknown run id → the 404-style CenteredState with a way home', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })),
      ),
    )
    renderRoute('nope')
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Task not found')
    })
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/')
    expect(document.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('neutral')
  })
})

/** A real abortable detail GET: TanStack owns its AbortSignal; only the HTTP boundary is fake.
 * The queue makes it possible to hold a request IN FLIGHT while an SSE event or Stop cancels it. */
function stubPendingDetailGets(id = 'r1') {
  const requests: Array<{ signal: AbortSignal; reply: (run: ApiRun) => void }> = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    if (path === `/api/v1/runs/${id}` && (init.method ?? 'GET') === 'GET') {
      return new Promise<Response>((resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
        requests.push({
          signal,
          reply: (record) => resolve(new Response(JSON.stringify(record), {
            status: 200, headers: { 'content-type': 'application/json' },
          })),
        })
      })
    }
    const history = historyBodyFor(path, id)
    const body = history !== undefined ? history
      : init.method === 'POST' && path.endsWith('/cancel') ? { cancelled: true }
      : path === '/api/v1/providers/status' ? { providers: [] }
      : path === '/api/v1/runs' ? [] : {}
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  }))
  return requests
}

/** The live workspace stream is the only caller of the run-detail cancellation path. Route
 * assertions catch a false error during the debounce, not just the eventual successful GET. */
function stubWorkspaceRunEvents() {
  const sources: Array<{ emit: (name: string, payload: unknown) => void }> = []
  class FakeEventSource {
    private listeners = new Map<string, (event: MessageEvent<string>) => void>()
    constructor(url: string | URL, _options?: EventSourceInit) {
      if (String(url).endsWith('/workspace/events')) sources.push(this)
    }
    addEventListener(name: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(name, listener) }
    emit(name: string, payload: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(payload) } as MessageEvent<string>) }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  return {
    sources,
    emitRun: (record: ApiRun) => sources[0]!.emit('run', { ...record, project: 'demo' }),
  }
}

function seedBootProject(queryClient: ReturnType<typeof createQueryClient>) {
  queryClient.setQueryData(queryKeys.health, { bootProject: 'demo' })
}

describe('TaskThreadRoute — in-flight detail cancellation (#483)', () => {
  it('keeps a cached thread on screen during cancellation and recovers from the next GET', async () => {
    const requests = stubPendingDetailGets()
    const { sources, emitRun } = stubWorkspaceRunEvents()
    const queryClient = createQueryClient()
    seedBootProject(queryClient)
    queryClient.setQueryData(queryKeys.runs.detail('r1'), run('running'))
    renderRoute('r1', queryClient, true)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing'))

    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail('r1') })
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(sources).toHaveLength(1)
    expect(requests[0]!.signal.aborted).toBe(false)
    await act(async () => emitRun(run('waiting', { titleSummary: 'Updated by stream' })))
    expect(requests[0]!.signal.aborted).toBe(true)
    expect(queryClient.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.titleSummary).toBe('Updated by stream')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Updated by stream'), { timeout: 250 })
    expect(screen.queryByText('Could not load this task')).toBeNull()
    expect(requests).toHaveLength(1) // no GET replaces the event patch before the debounce

    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.reply(run('waiting', { titleSummary: 'Fresh server title' })))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Fresh server title'))
  })

  it('keeps an uncached initial load pending through cancellation until a real GET answers', async () => {
    const requests = stubPendingDetailGets()
    const { sources, emitRun } = stubWorkspaceRunEvents()
    const queryClient = createQueryClient()
    seedBootProject(queryClient)
    renderRoute('r1', queryClient, true)
    // The own-run event must not seed a record from its summary while the detail GET is pending.
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(sources).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Loading task…')
    await act(async () => emitRun(run('running', { titleSummary: 'Only a stream summary' })))
    expect(requests[0]!.signal.aborted).toBe(true)
    // Drain the cancellation and observer notification, not the 400ms authoritative refetch.
    // An immediate assertion can race the cancelled query's pending → error notification.
    await waitFor(() => expect(queryClient.getQueryState(queryKeys.runs.detail('r1'))?.fetchStatus).toBe('idle'), { timeout: 250 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Loading task…')
    expect(screen.queryByText('Could not load this task')).toBeNull()
    expect(requests).toHaveLength(1) // the authoritative GET waits for the event debounce

    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.reply(run('running')))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing'))
  })

  it('a worker status SSE event keeps its cached parent thread visible while refreshing its in-flight detail', async () => {
    const requests = stubPendingDetailGets()
    const { sources, emitRun } = stubWorkspaceRunEvents()
    const queryClient = createQueryClient()
    seedBootProject(queryClient)
    queryClient.setQueryData(queryKeys.runs.detail('r1'), run('waiting', { finishBlocked: 'worker pending' }))
    renderRoute('r1', queryClient, true)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing'))
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail('r1') })
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(sources).toHaveLength(1)
    await act(async () => {
      emitRun(run('done', {
        id: '0f1cbcbf-84b2-4978-8381-c9dfbe9339b5',
        delegation: {
          role: 'worker', parentRunId: 'r1', permissions: [],
          workspace: {
            ownerRunId: '0f1cbcbf-84b2-4978-8381-c9dfbe9339b5',
            resourceId: 'a45eb6fd-be26-4ebc-9b96-8f1c4b7607cb',
            kind: 'owned-isolated', path: '/tmp/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40),
          },
        },
      }))
    })
    expect(requests[0]!.signal.aborted).toBe(true)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(screen.queryByText('Could not load this task')).toBeNull()
    await waitFor(() => expect(requests).toHaveLength(2), { timeout: 2_000 })
    await act(async () => requests[1]!.reply(run('waiting', { titleSummary: 'Parent after worker' })))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Parent after worker'))
  })

  it('Stop does not replace the cached thread with a load error while its in-flight detail is refreshed', async () => {
    const requests = stubPendingDetailGets()
    const queryClient = createQueryClient()
    queryClient.setQueryData(queryKeys.runs.detail('r1'), run('running'))
    renderRoute('r1', queryClient)
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail('r1') })
    await waitFor(() => expect(requests).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(requests[0]!.signal.aborted).toBe(true))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(screen.queryByText('Could not load this task')).toBeNull()
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.reply(run('done', { titleSummary: 'Stopped by server' })))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Stopped by server'))
  })
})

/**
 * Read receipts through the real route (#unread-done-items, #775). These drive the whole loop —
 * fetch → cache → the auto-mark-read effect → the header's Mark unread → fetch again — because
 * the interesting behavior only exists at that junction: the effect and the action pull the
 * receipt in opposite directions on the very same record.
 */
describe('TaskThreadRoute — read receipts', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const SEEN_AT = '2026-07-14T13:05:00.000Z'
  const RE_SEEN_AT = '2026-07-14T14:00:00.000Z'

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  /** A fetch stub that actually MODELS the receipt: `/read` stamps it, `/unread` clears it, and
   *  `GET /runs/:id` answers the current record. A stub that always replayed the initial record
   *  would hide the exact bug this suite exists for — the effect re-firing on a cleared receipt. */
  function stubReceiptServer(initial: ApiRun) {
    const sent: Array<{ path: string; method: string }> = []
    let current: ApiRun = { ...initial }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        sent.push({ path, method })
        if (method === 'POST' && path === `/api/v1/runs/${initial.id}/read`) {
          current = { ...current, seenAt: RE_SEEN_AT }
          return Promise.resolve(jsonResponse(current))
        }
        if (method === 'POST' && path === `/api/v1/runs/${initial.id}/unread`) {
          const { seenAt: _cleared, ...rest } = current
          current = rest as ApiRun
          return Promise.resolve(jsonResponse(current))
        }
        const history = historyBodyFor(path, initial.id)
        if (history !== undefined) return Promise.resolve(jsonResponse(history))
        if (path === `/api/v1/runs/${initial.id}`) return Promise.resolve(jsonResponse(current))
        if (path === '/api/v1/runs') return Promise.resolve(jsonResponse([]))
        if (path === '/api/v1/providers/status') {
          return Promise.resolve(
            jsonResponse({
              providers: [
                { provider: 'claude', status: 'connected', enabled: true },
                { provider: 'codex', status: 'not-installed', enabled: true },
                { provider: 'opencode', status: 'not-installed', enabled: true },
              ],
            }),
          )
        }
        return Promise.resolve(jsonResponse({}))
      }),
    )
    return { sent, currentRecord: () => current }
  }

  /** A fresh visit to `/tasks/:id` — a NEW route instance every time, which is what makes the
   *  suppression's per-visit reset observable. The query client is shared across visits on
   *  purpose: navigating away and back inside the cockpit does not empty the cache. */
  function visit(id: string, queryClient = createQueryClient()) {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/tasks/${id}`]}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskThreadRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return { ...view, queryClient }
  }

  const posted = (sent: Array<{ path: string; method: string }>, path: string) =>
    sent.filter((r) => r.method === 'POST' && r.path === path).length

  it('opening an unread finished task marks it read', async () => {
    const { sent } = stubReceiptServer(run('done', { finishedAt: FINISHED_AT }))
    visit('r1')
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/read')).toBe(1))
  })

  it('marking unread inside the open thread is NOT re-stamped by the auto-read effect', async () => {
    // The regression this feature lives or dies on: clearing the receipt makes `isUnread` true
    // again, and the auto-mark-read effect re-runs on exactly that change. Without the per-visit
    // suppression it would immediately POST /read and the action would look broken.
    const { sent, currentRecord } = stubReceiptServer(
      run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT }),
    )
    visit('r1')

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Run actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark unread' }))
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/unread')).toBe(1))

    // Let every settled mutation, cache write and re-render drain before judging.
    await waitFor(() => expect(currentRecord().seenAt).toBeUndefined())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(posted(sent, '/api/v1/runs/r1/read')).toBe(0)
    expect(currentRecord().seenAt).toBeUndefined()
  })

  it('a later fresh visit marks it read again — reopening the mail still counts', async () => {
    // The suppression is per-visit, not sticky: the email grammar this is modelled on says a
    // task you deliberately put back to unread goes read again the next time you open it.
    const { sent, currentRecord } = stubReceiptServer(
      run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT }),
    )
    const first = visit('r1')

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Run actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark unread' }))
    await waitFor(() => expect(currentRecord().seenAt).toBeUndefined())
    expect(posted(sent, '/api/v1/runs/r1/read')).toBe(0)
    first.unmount()

    visit('r1', first.queryClient)
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/read')).toBe(1))
    expect(currentRecord().seenAt).toBe(RE_SEEN_AT)
  })

  it('the control appears as soon as opening the task has marked it read', async () => {
    // Opening an unread task is what makes the action meaningful in the first place: the auto-read
    // effect stamps the receipt, and the header immediately offers the way back. (The
    // still-unread case cannot be reached from this route — it is covered where the header's flag
    // is driven directly, in run-header.test.tsx.)
    const { sent } = stubReceiptServer(run('done', { finishedAt: FINISHED_AT }))
    visit('r1')
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/read')).toBe(1))
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Run actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Mark unread' })).not.toBeNull()
  })
})

it.each(['registered', 'parked', 'wake-pending'] as const)('uses honest dock copy for %s worker waits', phase => {
  renderView(<ThreadView run={run('waiting', { delegation: { role: 'root', permissions: [], receipts: [], wait: { id: 'wait', workerIds: ['worker'], deadline: '2026-09-06T00:00:00.000Z', phase, outcomes: [] } } })} thread={reduceThread([])} />)
  const hint = document.querySelector('[data-slot="paused-hint"]')
  expect(hint?.textContent).toContain(phase === 'parked' ? 'Waiting on workers' : 'waiting for your reply')
})
it('keeps a visible human ask above parked worker context in the header and dock', () => {
  const thread = reduceThread([line(1, 'ask.requested', { requestId: 'ask', questions: [{ header: 'Choice', question: 'Choose a path', options: [{ label: 'Proceed', description: 'Continue' }] }] })])
  renderView(<ThreadView run={run('waiting', { delegation: { role: 'root', permissions: [], receipts: [], wait: { id: 'wait', workerIds: ['worker'], deadline: '2026-09-06T00:00:00.000Z', phase: 'parked', outcomes: [] } } })} thread={thread} />)
  expect(document.querySelector('[data-slot="paused-hint"]')?.textContent).toContain('waiting for your reply')
  expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain('needs you')
  expect(screen.getByText('Choose a path')).toBeTruthy()
})

it.each([false, true].flatMap(fallback => (['pending', 'refused-human-attempt', 'stale-receipt', 'agent-input', 'matched-answer', 'old-history'] as const).map(mode => ({ fallback, mode }))))('history attention (fallback=$fallback) handles $mode separately from visible historical asks', ({ fallback, mode }) => {
  const ask = line(10, 'ask.requested', { requestId: 'compact-ask', questions: [{ header: 'Choice', question: 'Choose a current path', options: [{ label: 'First' }, { label: 'Second' }] }] })
  const visibleEvents = [ask]
  const currentEvents = mode === 'old-history' ? [] : [ask,
    ...(mode === 'refused-human-attempt' ? [line(11, 'user-message', { text: 'backend refused this attempt' })] : []),
    ...(mode === 'stale-receipt' ? [line(11, 'human-input-delivered', { askSeq: 9 })] : []),
    ...(mode === 'agent-input' ? [line(11, 'agent-input', { input: { text: 'worker finished' } })] : []),
    ...(mode === 'matched-answer' ? [line(12, 'human-input-delivered', { askSeq: 10 })] : []),
  ]
  const history: import('@/api/run-history').RunHistoryState = { visibleEvents, currentEvents, isPending: false, contextPending: false, fallback, hasOlder: true, isFetchingOlder: false, olderError: undefined, loadOlder: async () => {}, jumpToLatest: async () => {}, retainedPages: 1 }
  renderView(<ThreadView run={run('waiting', { delegation: { role: 'root', permissions: [], receipts: [], wait: { id: 'wait', workerIds: ['worker'], deadline: '2026-09-07T12:00:00.000Z', phase: 'parked', outcomes: [] } } })} thread={reduceThread(visibleEvents)} currentThread={reduceThread(currentEvents)} history={history} />)
  const expectedPending = mode !== 'matched-answer' && mode !== 'old-history'
  expect(document.querySelector('[data-slot="paused-hint"]')?.textContent).toContain(expectedPending ? 'waiting for your reply' : 'Waiting on workers')
  expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain(expectedPending ? 'needs you' : 'waiting on workers')
})

describe('composer execution actions (#201)', () => {
  it.each(['queued', 'running', 'waiting'] as const)('keeps Stop reachable for %s tasks', async (status) => {
    renderView(<ThreadView run={run(status)} thread={reduceThread([])} />)
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    const textarea = screen.getByRole('textbox', { name: 'Reply to the agent' })
    if (status === 'waiting') {
      // This assertion used to read "Send exists and is disabled" — the dead primary #281
      // reclaims. Finish holds the slot now; what has NOT changed is that an empty draft submits
      // nothing, and the lines below still prove typing hands the slot straight back to Send.
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Finish' }).hasAttribute('disabled')).toBe(false)
    }
    fireEvent.change(textarea, { target: { value: 'next instructions' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(false)
  })

  it('requeues a stopped unstarted task through the same composer Continue action', async () => {
    renderView(<ThreadView run={run('cancelled', { workflowDef: { name: 'quick-task', source: 'built-in' as const, steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] } })} thread={reduceThread([])} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'and tests' } })
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('requires an answer instead of offering empty Continue for a pending human question', async () => {
    renderView(<ThreadView run={run('done', { hasPendingHumanAsk: true, steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's1' }] })} thread={reduceThread([])} />)
    await waitFor(() => expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false))
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
  })

  it('preserves a draft after Stop acceptance until the run terminates', async () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread([])} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.disabled).toBe(false))
    const previousFetch = globalThis.fetch
    let stops = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cancel')) { stops++; return new Response(JSON.stringify({ cancelled: true }), { headers: { 'content-type': 'application/json' } }) }
      return previousFetch(input, init)
    }))
    fireEvent.change(textarea, { target: { value: 'keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stops).toBe(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stopping…' }).hasAttribute('disabled')).toBe(true))
    expect(textarea.value).toBe('keep this draft')
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(stops).toBe(1)
  })
})


describe('composer replies after idle close (#315)', () => {
  async function setup(messageStatus = 409, hasSession = true) {
    const fixture = run('waiting', {
      runner: 'claude',
      hasPendingHumanAsk: true,
      steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'waiting', iterations: 1, tokensUsed: 0,
        ...(hasSession ? { sessionId: 'session-1' } : {}) }],
    })
    const thread = reduceThread([line(1, 'ask.requested', {
      requestId: 'pending-choice',
      questions: [{ header: 'Checks', question: 'Where should checks run?', options: [{ label: 'Main' }, { label: 'Every branch' }] }],
    })])
    const { queryClient } = renderView(<ThreadView run={fixture} thread={thread} />)
    await waitFor(() => expect(queryClient.getQueryData(workspaceQueryKeys.providerStatus)).toBeDefined())
    const originalFetch = globalThis.fetch
    const posts: { path: string; body: unknown }[] = []
    let settleResume: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (init?.method !== 'POST') return originalFetch(input, init)
      posts.push({ path, body: JSON.parse(String(init.body)) })
      if (path.endsWith('/continue')) return new Promise<Response>(resolve => { settleResume = resolve })
      return Promise.resolve(new Response(JSON.stringify(
        messageStatus === 200 ? { delivered: true } : { error: messageStatus === 409 ? 'session closed' : 'cannot reach the server' },
      ), { status: messageStatus }))
    })
    const textarea = screen.getByRole('textbox', { name: 'Reply to the agent' }) as HTMLTextAreaElement
    return { posts, textarea, settle: (status = 200) => settleResume(new Response(JSON.stringify(
      status === 200 ? { continued: true } : { error: 'resume unavailable' },
    ), { status })) }
  }

  async function submit(textarea: HTMLTextAreaElement) {
    fireEvent.change(textarea, { target: { value: 'Use CI on main only' } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  }

  it('resumes an idle-closed waiting reply and keeps its draft until continuation succeeds', async () => {
    const { posts, textarea, settle } = await setup()
    const file = new File([new Uint8Array([9, 9])], 'shot.png', { type: 'image/png' })
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } })
    await screen.findByLabelText('Remove shot.png')
    await submit(textarea)
    await waitFor(() => expect(posts.map(post => post.path)).toEqual(['/api/v1/runs/r1/messages', '/api/v1/runs/r1/continue']))
    expect(posts[1]!.body).toEqual({ text: 'Use CI on main only', images: [{ mediaType: 'image/png', data: 'CQk=' }] })
    expect(screen.getByLabelText('Remove shot.png')).toBeTruthy()
    expect(textarea.value).toBe('Use CI on main only')
    expect(textarea.readOnly).toBe(true)
    expect(screen.getByText(/Sending…|Continuing…/)).toBeTruthy()
    settle()
    await waitFor(() => expect(textarea.value).toBe(''))
    expect(posts).toHaveLength(2)
    expect(screen.queryByLabelText('Remove shot.png')).toBeNull()
  })

  it('keeps a failed resume draft and explains that retry reopens the session', async () => {
    const { posts, textarea, settle } = await setup()
    await submit(textarea)
    await waitFor(() => expect(posts).toHaveLength(2))
    settle(503)
    await waitFor(() => expect(textarea.readOnly).toBe(false))
    expect(textarea.value).toBe('Use CI on main only')
    expect(screen.getByRole('alert').textContent).toMatch(/session closed/i)
    expect(screen.getByRole('alert').textContent).toMatch(/retry.*reopen/i)
    expect(screen.getByRole('alert').textContent).toContain('resume unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(posts).toHaveLength(4))
    settle()
    await waitFor(() => expect(textarea.value).toBe(''))
  })

  it('sends a live waiting reply through messages only', async () => {
    const { posts, textarea } = await setup(200)
    await submit(textarea)
    await waitFor(() => expect(textarea.value).toBe(''))
    expect(posts).toEqual([{ path: '/api/v1/runs/r1/messages', body: { text: 'Use CI on main only', images: [] } }])
  })

  it.each([{ status: 409, session: false }, { status: 503, session: true }])(
    'keeps the draft without resuming for status $status, session $session', async ({ status, session }) => {
      const { posts, textarea } = await setup(status, session)
      await submit(textarea)
      await screen.findByRole('alert')
      expect(textarea.value).toBe('Use CI on main only')
      expect(posts.map(post => post.path)).toEqual(['/api/v1/runs/r1/messages'])
    },
  )
})


it.each(['root', 'worker'] as const)('shows the actual dependency in a parked %s request thread', role => {
  const wait = { id: 'wait', workerIds: [], requestIds: ['request'], deadline: '2026-09-17T00:00:00.000Z', phase: 'parked' as const, outcomes: [] }
  const delegation: ApiRun['delegation'] = role === 'root' ? { role, permissions: [], receipts: [], wait } : {
    role, permissions: [], parentRunId: 'parent', wait,
    workspace: { kind: 'owned-isolated', ownerRunId: 'worker', resourceId: 'worker', path: '/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40) },
  }
  renderView(<ThreadView run={run('waiting', { delegation })} thread={reduceThread([])} />)
  expect(document.querySelector('[data-slot="paused-hint"]')?.textContent).toContain(role === 'worker' ? 'Waiting on parent reply' : 'Waiting on worker replies')
  expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain(role === 'worker' ? 'waiting on parent reply' : 'waiting on worker replies')
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Stop' }).some(button => !button.hasAttribute('disabled'))).toBe(true)
})

/**
 * #281 — the composer action row. Finish claims the gold primary on a Needs-you task, where it
 * was previously a DISABLED Send; Archive claims the outline slot Stop leaves empty the moment a
 * run stops being active. Both are thumb-reachable on a phone, which the header is not — it
 * scrolls away there by design.
 */
describe('the composer action row (#281)', () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  function renderThread(record: ApiRun, claudeStatus = 'connected') {
    const sent: Array<{ path: string; method: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
        const body =
          path === '/api/v1/providers/status'
            ? {
                providers: [
                  { provider: 'claude', status: claudeStatus, enabled: true },
                  { provider: 'codex', status: 'not-installed', enabled: true },
                  { provider: 'opencode', status: 'not-installed', enabled: true },
                ],
              }
            : path === '/api/v1/health' ? {}
            : path.endsWith('/relationships') ? { workers: [] }
            : []
        return Promise.resolve(jsonResponse(body))
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView run={record} thread={reduceThread(EVENTS)} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return sent
  }

  const composerActions = () => document.querySelector('[data-slot="composer-actions"]') as HTMLElement
  const finishButton = () => composerActions().querySelector('[data-slot="composer-finish"]')
  const archiveButton = () => composerActions().querySelector('[data-slot="archive-action"]')

  it('a Needs-you task offers Finish as the gold primary', () => {
    renderThread(run('waiting'))
    const finish = finishButton()
    expect(finish?.textContent).toContain('Finish')
    // Gold, per the design decision: Finish is the terminal verdict, so it carries the CTA weight
    // the disabled Send was wasting.
    expect(finish?.getAttribute('data-variant')).toBe('primary')
    expect((finish as HTMLButtonElement).disabled).toBe(false)
  })

  it('Finish posts straight to /finish — no confirmation on the waiting gate', async () => {
    const sent = renderThread(run('waiting'))
    fireEvent.click(finishButton() as HTMLElement)
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/finish')).toBe(true),
    )
    // The review-gate dialog belongs to review. Dismissing a Needs-you task is one click.
    expect(document.querySelector('[data-slot="task-confirmation"]')).toBeNull()
  })

  it('typing turns the primary back into Send — a typed draft is not an intent to finish', () => {
    renderThread(run('waiting'))
    expect(finishButton()).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Reply to the agent'), { target: { value: 'one more thing' } })
    expect(finishButton()).toBeNull()
    expect(composerActions().querySelector('[aria-label="Send"]')).not.toBeNull()
  })

  it('Stop stays reachable beside it, still an abort, and wears its word', () => {
    renderThread(run('waiting'))
    const stop = composerActions().querySelector('[aria-label="Stop"]')
    expect(stop).not.toBeNull()
    expect(stop?.getAttribute('title')).toBe('Stop execution; keep existing work')
    // A bare square beside a labelled Finish reads as an unexplained icon. Stop is icon-only
    // only when the control beside it is also an icon — the arrow Send.
    expect(stop?.textContent).toContain('Stop')
  })

  it('Stop goes back to an icon once typing restores the arrow Send', () => {
    renderThread(run('waiting'))
    fireEvent.change(screen.getByLabelText('Reply to the agent'), { target: { value: 'a reply' } })
    expect(composerActions().querySelector('[aria-label="Stop"]')?.textContent).toBe('')
  })

  it('a blocked provider disables the message, never Finish — finishing needs no credentials', async () => {
    // The composer's `disabled` gate is about SENDING: a disconnected provider cannot carry a
    // message. Finishing only settles the run the engine already owns, so gating it on the
    // provider would strand a Needs-you task with no way out on this tab — the kebab no longer
    // carries Finish here. Stop has always been independent of that gate for the same reason;
    // Finish now matches it.
    const sent = renderThread(run('waiting'), 'not-installed')
    await waitFor(() =>
      expect((screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement).disabled).toBe(true),
    )
    const finish = finishButton() as HTMLButtonElement
    expect(finish).not.toBeNull()
    expect(finish.disabled).toBe(false)
    fireEvent.click(finish)
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/finish')).toBe(true),
    )
  })

  it('a pending human ask still offers Finish — dismissing instead of answering is the point', () => {
    // The canonical Needs-you task: an agent stopped to ask you something. `finishBlockedReason`
    // refuses this only on a `root`, so an ordinary task finishes straight through its open
    // session — and locking the promotion out of it would miss the case #281 was filed about.
    renderThread(run('waiting', { hasPendingHumanAsk: true }))
    expect((finishButton() as HTMLButtonElement)?.disabled).toBe(false)
  })

  it('a blocked root has no Finish action', () => {
    renderThread(run('waiting', {
      finishBlocked: 'Answer the pending human question before finishing.',
      hasPendingHumanAsk: true,
      delegation: { role: 'root', permissions: [], receipts: [] },
    }))
    expect(finishButton()).toBeNull()
  })

  it.each(['running', 'queued', 'review', 'done'] as const)('%s does not promote Finish', (status) => {
    renderThread(run(status))
    expect(finishButton()).toBeNull()
  })

  it('a finished task offers Archive where Stop used to sit', () => {
    renderThread(run('done'))
    const archive = archiveButton()
    expect(archive?.textContent).toContain('Archive task')
    // Housekeeping, not a CTA — the gold in this row belongs to Continue.
    expect(archive?.getAttribute('data-variant')).toBe('outline')
    expect(composerActions().querySelector('[aria-label="Stop"]')).toBeNull()
  })

  it('keeps Archive named when its composer label hides on mobile', () => {
    renderThread(run('done'))
    const archive = archiveButton() as HTMLButtonElement
    expect(archive.getAttribute('aria-label')).toBe('Archive task')
    expect(archive.className).toContain('max-md:size-11')
    expect(archive.querySelector('span')?.className).toContain('max-md:sr-only')
  })

  it('Archive confirms first, then posts the flipped flag', async () => {
    const sent = renderThread(run('done'))
    fireEvent.click(archiveButton() as HTMLElement)
    expect(sent.some((r) => r.path.endsWith('/archive'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Archive task' }))
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/archive')?.body).toEqual({
        archived: true,
      }),
    )
  })

  it('an archived task offers Unarchive, and restoring needs no confirmation', async () => {
    const sent = renderThread(run('done', { archived: true }))
    fireEvent.click(archiveButton() as HTMLElement)
    await waitFor(() =>
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/archive')?.body).toEqual({ archived: false }),
    )
    expect(document.querySelector('[data-slot="task-confirmation"]')).toBeNull()
  })

  it.each(['running', 'queued', 'waiting'] as const)('%s keeps Stop in the slot, not Archive', (status) => {
    renderThread(run(status))
    expect(archiveButton()).toBeNull()
    expect(composerActions().querySelector('[aria-label="Stop"]')).not.toBeNull()
  })
})
