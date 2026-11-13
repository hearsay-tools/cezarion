import { HEALTH, HEALTH_MULTI, PROVIDERS_CONNECTED, PROVIDERS_MULTI, PROVIDERS_NONE, SKILLS, WORKFLOWS, CONFIG, WORKSPACE_CONFIG, PLAN, FALLBACK_PLAN, requests, deferredJson, serve, renderNewTask, textarea, sourcePill, location, draftSource, pillReady, startTask, postedBody, planToggle, startToggle, stepIds, planTask } from './new-task.testkit'

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceQueryKeys } from '@/api/queries'
import type { ConfigResponse, HealthResponse, ProviderStatusResponse } from '@open-mercato/cezar-api-client'
import { resetToasts } from '@/components/ui/toaster'
import { readDraft, resetDraft, writeDraft } from './new-task-draft'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  resetDraft()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
})

describe('submit', () => {
  // #458: an untouched /setup is allowed to default on; a retained explicit off must
  // survive remount and win over both workspace policy and skill selection.
  it.each([
    { choice: null, configured: null, interactive: false, expected: true },
    { choice: false, configured: true, interactive: false, expected: false },
    { choice: true, configured: false, interactive: false, expected: true },
    { choice: null, configured: false, interactive: false, expected: false },
    { choice: null, configured: true, interactive: false, expected: true },
    { choice: null, configured: true, interactive: true, expected: false },
    { choice: false, configured: null, interactive: true, expected: false },
    { choice: true, configured: null, interactive: true, expected: true },
  ])('/setup choice=$choice policy=$configured interactive=$interactive agrees with its payload', async ({
    choice, configured, interactive, expected,
  }) => {
    writeDraft({ ...readDraft(), autonomous: choice })
    serve({
      skills: [{ name: 'setup', description: 'Set up SDLC', body: '', path: '/p/setup.md',
        source: 'ai', ...(interactive ? { interactive: true as const } : {}) }],
      workspaceConfig: { ...WORKSPACE_CONFIG, composerDefaults: {
        ...WORKSPACE_CONFIG.composerDefaults, autonomous: configured,
      } },
    })
    renderNewTask('/new?skill=setup')
    await pillReady('setup')
    await waitFor(() => expect(document.querySelector('[data-slot="autonomous-toggle"]')
      ?.getAttribute('aria-checked')).toBe(String(expected)))
    fireEvent.change(textarea(), { target: { value: 'Set up SDLC' } })
    await startTask()

    const body = postedBody() as Record<string, unknown>
    expect(body.steps).toEqual([{ id: 'task', name: 'setup', skill: 'setup', prompt: '{{task}}' }])
    // Off is omitted on the wire and normalizes to false at startRun, never to a server default.
    expect(body.autonomous).toBe(expected ? true : undefined)
    expect(readDraft().autonomous).toBe(choice)
  })

  it('a SKILL source posts the one-step inline chain and persists lastTask, then navigates', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve({ createRun: { id: 'run-9' } })
    renderNewTask()
    await pillReady('om-fix')
    fireEvent.change(textarea(), { target: { value: 'Fix the flaky worktree test' } })
    await startTask()

    expect(postedBody()).toEqual({
      task: 'Fix the flaky worktree test',
      steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }],
      // Skills default to autonomous (#autonomous).
      autonomous: true,
    })
    await waitFor(() => expect(location()).toBe('/tasks/run-9'))
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')?.body).toEqual({
        lastTask: { source: 'skill', ref: 'om-fix' },
        // The run also lands at the head of the recency list (picker sort)...
        recentSources: [{ source: 'skill', ref: 'om-fix' }],
        // ...and bumps its usage count for the #408 frequency sort (a workflow source would
        // NOT carry a skillUsage key at all — see the WORKFLOW test below).
        skillUsage: { 'om-fix': 1 },
      }),
    )
  })

  it('a SKILL run with ui-state unavailable omits skillUsage rather than wiping the map', async () => {
    // `sourcesReady` only rules out `isPending`, so an ERRORED ui-state query still lets the
    // form submit with `uiState.data === undefined`. The PUT merge is shallow, so bumping off
    // that would send a one-entry map and replace every stored count.
    // 404, not a 5xx: the query client never retries a 4xx (query-client.ts), so the query
    // lands in its errored state immediately and the test stays deterministic.
    writeDraft({
      text: '', source: { source: 'skill', ref: 'om-fix' }, runner: null, agentProfile: null, model: null, effort: null,
      retiredVariants: false, planFirst: false, worktree: null, autonomous: null, archiveWhenDone: false, autoMergePr: false, allowWorkers: true, allowMessaging: true,
    })
    serve({ createRun: { id: 'run-9' }, uiStateStatus: 404 })
    renderNewTask()
    await pillReady('om-fix')
    fireEvent.change(textarea(), { target: { value: 'Fix the flaky worktree test' } })
    await startTask()

    await waitFor(() => expect(location()).toBe('/tasks/run-9'))
    const put = requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')
    // The other prefs still persist — only the unknowable map is left alone.
    expect(put?.body).not.toHaveProperty('skillUsage')
  })

  it('a WORKFLOW source posts { workflow, task }', async () => {
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve()
    renderNewTask()
    await pillReady('fix-and-verify')
    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    await startTask()

    expect(postedBody()).toEqual({ task: 'Ship it', workflow: 'fix-and-verify' })
  })

  it('a workflow PICKED IN THE MENU labels the pill and posts { workflow, task } (#263)', async () => {
    // The full gesture the report asked for: open the picker, click the workflow row, watch the
    // pill take its name — and the pick must STICK through Start onto the POST body.
    serve({ createRun: { id: 'run-wf' } })
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-slot="source-option"][data-source-kind="workflow"][data-source-ref="fix-and-verify"]',
      )!,
    )
    await pillReady('fix-and-verify')
    expect(sourcePill().getAttribute('data-source-kind')).toBe('workflow')
    fireEvent.change(textarea(), { target: { value: 'Ship it with the workflow' } })
    await startTask()

    expect(postedBody()).toEqual({ task: 'Ship it with the workflow', workflow: 'fix-and-verify' })
    await waitFor(() => expect(location()).toBe('/tasks/run-wf'))
  })

  it('NO source posts the plain quick-task, records lastTask:null and no recency entry', async () => {
    serve({ createRun: { id: 'run-plain' } })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    await startTask()

    expect(postedBody()).toEqual({ task: 'Ship it', workflow: 'quick-task' })
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')?.body).toEqual({
        // An honest record of a run that picked nothing — and the value that stops an older
        // cockpit restoring a stale skill from this same file.
        lastTask: null,
        // Nothing was picked, so nothing joins the recency list or the frequency map.
      }),
    )
  })

  it('posts worktree:false after opt-out for every single-step source shape', async () => {
    const cases: Array<{
      label: string
      source?: { source: 'skill' | 'workflow'; ref: string }
      overrides: NonNullable<Parameters<typeof serve>[0]>
      expected: Record<string, unknown>
    }> = [
      {
        label: 'Skill',
        overrides: {},
        expected: { workflow: 'quick-task' },
      },
      {
        label: 'om-fix',
        source: { source: 'skill', ref: 'om-fix' },
        overrides: {},
        expected: { steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }] },
      },
      {
        label: 'one-step',
        source: { source: 'workflow', ref: 'one-step' },
        overrides: {
          workflows: {
            workflows: [
              ...WORKFLOWS.workflows,
              { name: 'one-step', source: 'file', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] },
            ],
            issues: [],
          },
        },
        expected: { workflow: 'one-step' },
      },
    ]

    for (const testCase of cases) {
      cleanup()
      resetDraft()
      if (testCase.source) draftSource(testCase.source)
      serve(testCase.overrides)
      renderNewTask()
      await pillReady(testCase.label)
      const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
      fireEvent.click(worktree)
      expect(worktree.getAttribute('aria-checked')).toBe('false')
      fireEvent.change(textarea(), { target: { value: `Run ${testCase.label} in place` } })
      await startTask()
      expect(postedBody()).toMatchObject({ ...testCase.expected, worktree: false })
    }
  })

  it('carries an inherited Worktree-off policy into the submitted payload', async () => {
    serve({
      workspaceConfig: {
        ...WORKSPACE_CONFIG,
        composerDefaults: {
          ...WORKSPACE_CONFIG.composerDefaults!,
          inheritedWorktree: false,
        },
      },
    })
    renderNewTask()
    await pillReady()
    const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
    expect(worktree.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(textarea(), { target: { value: 'Use the environment seed' } })
    await startTask()
    expect(postedBody()).toMatchObject({ workflow: 'quick-task', worktree: false })
  })

  it('preserves old draft text and requires a choice before launching one task', async () => {
    localStorage.setItem('cez-new-task-draft', JSON.stringify({ text: 'Race two attempts', variants: 2 }))
    serve()
    renderNewTask()
    await pillReady()
    expect(screen.getByRole('alert').textContent).toContain('Parallel variants are removed')
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(screen.getByText(/Choose Use one task/)).toBeTruthy())
    expect(requests.filter(request => request.method === 'POST' && request.url === '/api/v1/runs')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Use one task' }))
    await startTask()
    expect(postedBody()).toMatchObject({ task: 'Race two attempts' })
    expect(postedBody()).not.toHaveProperty('variants')
  })

  it('shows a locked native default but omits it from the direct run request', async () => {
    writeDraft({ ...readDraft(), model: 'opus' })
    serve({
      providerStatus: PROVIDERS_MULTI,
      config: {
        defaultModels: { claude: 'native-sonnet', codex: 'gpt-5.6-codex' },
        modelsLocked: true,
      },
    })
    renderNewTask()
    await pillReady()

    const modelPill = document.querySelector('[data-slot="model-pill"]') as HTMLElement
    expect(modelPill.textContent).toContain('native-sonnet')
    expect(modelPill.textContent).not.toContain('opus')
    expect(screen.queryByRole('button', { name: /^Model · / })).toBeNull()

    fireEvent.pointerDown(screen.getByRole('button', { name: /^Runner · / }))
    const runnerOptions = await screen.findAllByRole('menuitemradio')
    fireEvent.click(runnerOptions.find((option) => option.textContent?.includes('Codex')) as HTMLElement)
    await waitFor(() => expect(modelPill.textContent).toContain('gpt-5.6-codex'))

    fireEvent.change(textarea(), { target: { value: 'Use native settings' } })
    await startTask()
    expect(postedBody()).toEqual({
      task: 'Use native settings',
      workflow: 'quick-task',
      runner: 'codex',
    })
  })

  it('single-backend hosts omit `runner` when it matches the server default', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'no runner key' } })
    await startTask()
    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
  })

  it('uses the active project default rather than the boot project health default', async () => {
    serve({ health: { ...HEALTH, defaultRunner: 'codex' }, config: { defaultRunner: 'claude' } })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'follow the project default' } })
    await startTask()
    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
  })

  it('sends an explicit runner pick when boot health claims that runner is the default', async () => {
    serve({
      health: { ...HEALTH_MULTI, defaultRunner: 'codex' },
      config: { defaultRunner: 'claude' },
      providerStatus: PROVIDERS_MULTI,
    })
    renderNewTask()
    await pillReady()
    fireEvent.pointerDown(document.querySelector('[data-slot="runner-pill"]') as HTMLElement)
    const options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((option) => option.textContent?.includes('codex')) as HTMLElement)
    fireEvent.change(textarea(), { target: { value: 'pin codex' } })
    await startTask()
    expect(postedBody()).toMatchObject({ runner: 'codex' })
  })

  it('applies an interactive skill hint to untouched controls while keeping both overridable', async () => {
    // The composer opens on no source, so an interactive skill only drives the recommendation
    // once it is the selected one — here from the draft.
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve({ skills: [{ ...SKILLS[0]!, interactive: true }, SKILLS[1]!] })
    renderNewTask()
    await pillReady('om-fix')

    const autonomous = document.querySelector(
      '[data-slot="autonomous-toggle"]',
    ) as HTMLButtonElement
    const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
    expect(autonomous.getAttribute('aria-checked')).toBe('false')
    expect(worktree.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/recommends an interactive run in the current checkout/i)).toBeTruthy()

    fireEvent.click(autonomous)
    fireEvent.click(worktree)
    expect(autonomous.getAttribute('aria-checked')).toBe('true')
    expect(worktree.getAttribute('aria-checked')).toBe('true')
  })

  it('lets a multi-step workflow opt out and submits worktree:false', async () => {
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve({
      workflows: {
        workflows: [
          WORKFLOWS.workflows[0]!,
          {
            name: 'fix-and-verify',
            source: 'file',
            steps: [
              { id: 'fix', name: 'Fix', prompt: '{{task}}' },
              { id: 'verify', name: 'Verify', command: 'npm test' },
            ],
          },
        ],
        issues: [],
      },
    })
    renderNewTask()
    await pillReady('fix-and-verify')

    const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
    expect(worktree.disabled).toBe(false)
    fireEvent.click(worktree)
    expect(worktree.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(textarea(), { target: { value: 'Run the whole workflow in place' } })
    await startTask()
    expect(postedBody()).toMatchObject({ workflow: 'fix-and-verify', worktree: false })
  })

  // #471 — the composer must not offer a switch the server overrides anyway.
  const retiredInboxHealth: HealthResponse = {
    ...HEALTH,
    capabilities: { localHandoff: true, settingsAdmin: true, remoteSettingsAdmin: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, singleProject: false, automations: false, preview: false, voice: false },
  }
  const followupsToggle = () =>
    document.querySelector('[data-slot="generate-followups-toggle"]')

  it('omits the retired follow-up toggle', async () => {
    serve({ health: retiredInboxHealth })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(followupsToggle()).toBeNull())
    // The neighbouring toggles are untouched — the gate owns exactly one control.
    expect(document.querySelector('[data-slot="autonomous-toggle"]')).not.toBeNull()
  })

})

describe('drafts and prefill', () => {
  it('text and picker choices survive an unmount/remount (navigation away and back)', async () => {
    serve()
    const first = renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'half-written thought' } })
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.click(document.querySelector('[data-source-ref="fix-and-verify"]') as HTMLElement)
    await pillReady('fix-and-verify')
    first.unmount()

    renderNewTask()
    await pillReady('fix-and-verify')
    expect(textarea().value).toBe('half-written thought')
  })

  it('?skill=&ref= prefill: ref becomes the text, the skill is selected — beating the draft', async () => {
    serve()
    const first = renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'stale draft' } })
    first.unmount()

    renderNewTask('/new?skill=deploy&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fissues%2F5&auto=1&key=whatever')
    // auto=1 with the WRONG key resolves to the blocked/prefill path — never a run.
    await pillReady('deploy')
    expect(textarea().value).toBe('https://github.com/o/r/issues/5')
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/runs')).toBe(false)
  })

  it('launches omit retired Inbox fields', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'unrelated task' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).todoId).toBeUndefined()
    expect((postedBody() as Record<string, unknown>).generateFollowups).toBeUndefined()
  })

  it('submit spends the draft text', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'send me' } })
    await startTask()
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())

    renderNewTask()
    expect(textarea().value).toBe('')
  })
})

describe('bookmarklet auto-start', () => {
  const runsPosted = () => requests.filter((r) => r.method === 'POST' && r.url === '/api/v1/runs')
  const keyFetched = () => requests.some((r) => r.method === 'GET' && r.url === '/api/v1/launch-key')

  it('waits for provider status before a valid signed bookmarklet starts', async () => {
    let release!: (response: Response) => void
    serve({
      providerStatus: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() =>
      expect(requests.some((request) => request.url === '/api/v1/providers/status')).toBe(true),
    )
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)

    release(
      new Response(JSON.stringify(PROVIDERS_CONNECTED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted()).toHaveLength(1)
  })

  it('waits for project config, then keeps an untouched project-default runner implicit', async () => {
    const delayedConfig = deferredJson<ConfigResponse>()
    const delayedProviders = deferredJson<ProviderStatusResponse>()
    serve({
      health: { ...HEALTH, defaultRunner: 'codex' },
      config: delayedConfig.fetch,
      providerStatus: delayedProviders.fetch,
    })
    const { client } = renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() => {
      expect(requests.some((request) => request.url === '/api/v1/config')).toBe(true)
      expect(requests.some((request) => request.url === '/api/v1/providers/status')).toBe(true)
    })
    await act(async () => {
      delayedProviders.release(PROVIDERS_CONNECTED)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('success'),
    )
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)

    delayedConfig.release(CONFIG)
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((request) => request.body)).toEqual([
      {
        task: 'hello',
        steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }],
      },
    ])
  })

  it('waits for project config and sends a connected fallback when that default is unavailable', async () => {
    const delayedConfig = deferredJson<ConfigResponse>()
    const delayedProviders = deferredJson<ProviderStatusResponse>()
    serve({ config: delayedConfig.fetch, providerStatus: delayedProviders.fetch })
    const { client } = renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() => {
      expect(requests.some((request) => request.url === '/api/v1/config')).toBe(true)
      expect(requests.some((request) => request.url === '/api/v1/providers/status')).toBe(true)
    })
    await act(async () => {
      delayedProviders.release(PROVIDERS_CONNECTED)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('success'),
    )
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)

    delayedConfig.release({ ...CONFIG, defaultRunner: 'codex' })
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((request) => request.body)).toEqual([
      {
        task: 'hello',
        steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }],
        runner: 'claude',
      },
    ])
  })

  it('valid key + auto=1 + skill/ref → starts unattended with the exact legacy body, then the thread', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())

    expect(keyFetched()).toBe(true)
    // The body pin: Step 1.1's skill-source shape, nothing else on the wire — no model, no
    // runner, no variants (legacy's bookmarklet start never sent them either).
    expect(runsPosted().map((r) => r.body)).toEqual([
      { task: 'hello', steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }] },
    ])
    expect(location()).toBe('/tasks/r1')
    // Unattended starts do not rewrite the sticky lastTask (legacy parity).
    expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')).toBe(false)
  })

  it('uses an explicit connected fallback when the saved server default is disconnected', async () => {
    serve({
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())

    expect(runsPosted().map((request) => request.body)).toEqual([
      {
        task: 'hello',
        steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }],
        runner: 'codex',
      },
    ])
  })

  it('keeps the prefilled composer disabled and does not POST when none are connected', async () => {
    serve({ providerStatus: PROVIDERS_NONE })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() =>
      expect(textarea().placeholder).toBe('Connect an agent provider before starting a task.'),
    )
    expect(textarea().value).toBe('hello')
    expect(runsPosted()).toHaveLength(0)
    expect(screen.getByRole('link', { name: 'Configure providers' })).toBeTruthy()
  })

  it('ref only (no skill) + valid key → quick-task, exactly like legacy', async () => {
    serve()
    renderNewTask('/new?ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((r) => r.body)).toEqual([{ task: 'hello', workflow: 'quick-task' }])
  })

  it('the legacy `task` alias for ref still auto-starts', async () => {
    serve()
    renderNewTask('/new?task=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((r) => r.body)).toEqual([{ task: 'hello', workflow: 'quick-task' }])
  })

  it('an unknown skill with a valid key STILL starts (legacy never validated it client-side)', async () => {
    // The server notes `skill "…" not found — running with the plain prompt` and runs anyway
    // (src/workflows/run.ts); blocking here would break saved bookmarklets legacy honored.
    serve()
    renderNewTask('/new?skill=ghost&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((r) => r.body)).toEqual([
      { task: 'hello', steps: [{ id: 'task', name: 'ghost', skill: 'ghost', prompt: '{{task}}' }] },
    ])
  })

  it('wrong key + auto=1 → blocked: prefill, a toast, focus on Start, no run, key never rendered', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=wrong')
    await pillReady('deploy')
    await screen.findByText('Auto-start blocked (bad key) — review and press Start')

    expect(keyFetched()).toBe(true)
    expect(runsPosted()).toHaveLength(0)
    expect(textarea().value).toBe('hello')
    expect(document.body.textContent).not.toContain('k-real')
    // Legacy focused the Run button so a bare Enter submits the reviewed form.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start task' })),
    )
  })

  it('missing key + auto=1 → the same blocked path', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1')
    await pillReady('deploy')
    await screen.findByText('Auto-start blocked (bad key) — review and press Start')
    expect(runsPosted()).toHaveLength(0)
    expect(textarea().value).toBe('hello')
  })

  it('valid key WITHOUT auto=1 → prefill + toast, the key is not even fetched', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&key=k-real')
    await pillReady('deploy')
    await screen.findByText('Prefilled from link — review and press Start')
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)
    expect(textarea().value).toBe('hello')
    expect(document.body.textContent).not.toContain('k-real')
  })

  it('the generic launcher link (auto=0&key=&ref=, no skill) prefills — never starts', async () => {
    // Exactly what legacy `bookmarkletUrl('', false, key)` emits: auto=0 still carries the key.
    serve()
    renderNewTask('/new?auto=0&key=k-real&ref=hello')
    await pillReady()
    await screen.findByText('Prefilled from link — review and press Start')
    expect(textarea().value).toBe('hello')
    expect(runsPosted()).toHaveLength(0)
    expect(keyFetched()).toBe(false)
  })

  it('an unknown skill on the prefill path → honest toast + the legacy quick-task embedding', async () => {
    serve()
    renderNewTask('/new?skill=ghost&ref=hello')
    await screen.findByText('Unknown skill "ghost" — prefilled for quick-task; review and press Start')
    // Legacy initFromQuery verbatim: the intent goes into the text, quick-task resolves it.
    expect(textarea().value).toBe('Use the "ghost" skill on: hello')
    // "quick-task" IS the empty picker now — the prefill lands on it by picking nothing.
    await pillReady()
    expect(sourcePill().getAttribute('data-source-kind')).toBe('none')
    expect(runsPosted()).toHaveLength(0)
  })

  it('a failed unattended POST falls back to the prefilled composer with the reason', async () => {
    serve({ createRun: { error: 'boom' }, createRunStatus: 500 })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await screen.findByText('Auto-start failed: boom — review and press Start')
    expect(runsPosted()).toHaveLength(1)
    expect(textarea().value).toBe('hello')
    expect(location()).toBe('/new')
  })

  it('cleans the sensitive params from the URL immediately (legacy history.replaceState)', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=wrong')
    await waitFor(() => expect(location()).toBe('/new'))
  })

  it('cleans the URL on plain prefill links too', async () => {
    serve()
    renderNewTask('/new?ref=hello')
    await waitFor(() => expect(location()).toBe('/new'))
  })
})

describe('the Start | Plan first toggle', () => {
  it('flips the selected state (#383): aria-checked moves, the submit becomes "Plan task"', async () => {
    serve()
    renderNewTask()
    await pillReady()

    expect(startToggle().getAttribute('aria-checked')).toBe('true')
    expect(planToggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Start task' })).not.toBeNull()

    fireEvent.click(planToggle())
    expect(planToggle().getAttribute('aria-checked')).toBe('true')
    expect(startToggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Plan task' })).not.toBeNull()

    fireEvent.click(startToggle())
    expect(planToggle().getAttribute('aria-checked')).toBe('false')
    expect(startToggle().getAttribute('aria-checked')).toBe('true')
  })

  it('disables the Autonomous toggle in plan mode (planning is interactive)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const autonomous = () =>
      document.querySelector('[data-slot="autonomous-toggle"]') as HTMLButtonElement

    // Off plan mode the toggle is interactive.
    expect(autonomous().disabled).toBe(false)
    fireEvent.click(planToggle())
    expect(autonomous().disabled).toBe(true)
    expect(autonomous().getAttribute('aria-checked')).toBe('false')
  })

  it('persists in the draft store across unmount/remount', async () => {
    serve()
    const first = renderNewTask()
    await pillReady()
    fireEvent.click(planToggle())
    first.unmount()

    renderNewTask()
    await pillReady()
    expect(planToggle().getAttribute('aria-checked')).toBe('true')
  })
})

describe('the Notify webhook toggle (#589)', () => {
  const registry = (webhook?: { url: string; tokenSet: boolean }) => ({
    projects: [{
      id: 'demo', name: 'demo', root: '/repo', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok',
      ...(webhook ? { webhook } : {}),
    }],
    bootProject: 'demo',
    projectsDir: '~/cezar/projects',
  })
  const toggle = () => document.querySelector('[data-slot="notify-webhook-toggle"]') as HTMLButtonElement | null

  it('is not rendered when the project has no webhook, and the start body says nothing', async () => {
    serve({ projects: registry() })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/projects')).toBe(true))
    expect(toggle()).toBeNull()
    fireEvent.change(textarea(), { target: { value: 'do it' } })
    await startTask()
    expect(postedBody()).not.toHaveProperty('notify')
  })

  it('renders off when the project has a webhook, and sends notify:true once checked', async () => {
    serve({ projects: registry({ url: 'https://bot.example/hooks/cez', tokenSet: true }) })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(toggle()).not.toBeNull())
    expect(toggle()!.getAttribute('aria-checked')).toBe('false')
    // The row names the action. The host and path stay on the tooltip (#614).
    expect(toggle()!.textContent).toContain('Send status changes')
    expect(toggle()!.textContent).not.toContain('bot.example')
    fireEvent.click(toggle()!)
    expect(toggle()!.getAttribute('aria-checked')).toBe('true')
    fireEvent.change(textarea(), { target: { value: 'do it' } })
    await startTask()
    expect(postedBody()).toMatchObject({ notify: true })
  })

  it('never shows the query string in the label or the tooltip (#594 review)', async () => {
    serve({ projects: registry({ url: 'https://bot.example/hooks/cez?key=secret', tokenSet: true }) })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(toggle()).not.toBeNull())
    for (const on of [false, true]) {
      if (on) fireEvent.click(toggle()!)
      expect(toggle()!.getAttribute('aria-checked')).toBe(String(on))
      expect(toggle()!.outerHTML).not.toContain('secret')
      expect(toggle()!.getAttribute('title')).toContain('bot.example/hooks/cez')
    }
  })
})

describe('the plan flow', () => {
  it('submit in plan mode POSTs /api/v1/plan (never /api/v1/runs) and opens the review overlay', async () => {
    serve()
    renderNewTask()
    await planTask('Tighten the flaky suite')

    expect(requests.find((r) => r.url === '/api/v1/plan')?.body).toEqual({
      task: 'Tighten the flaky suite',
    })
    expect(requests.some((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(false)

    // Task line, rationale, numbered cards with skill/check badges and hints.
    expect(document.querySelector('[data-slot="plan-task"]')?.textContent).toBe(
      'Tighten the flaky suite',
    )
    expect(screen.getByText('Implement, verify with tests, then review.')).toBeTruthy()
    expect(stepIds()).toEqual(['implement', 'verify', 'review'])
    expect(document.querySelector('[data-slot="plan-badge-check"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="plan-badge-skill"]')?.textContent).toBe('om-fix')
    expect(screen.getByText('npm test')).toBeTruthy()
  })

  it('a degraded answer shows the fallback note instead of a rationale', async () => {
    serve({ plan: FALLBACK_PLAN })
    renderNewTask()
    await planTask()
    expect(document.querySelector('[data-slot="plan-fallback"]')?.textContent).toBe(
      'planner unavailable — single-step plan',
    )
    expect(document.querySelector('[data-slot="plan-rationale"]')).toBeNull()
    expect(stepIds()).toEqual(['task'])
  })

  it('shows the busy state while planning: "Planning…" on the segment, submit disabled', async () => {
    let release!: () => void
    serve({
      plan: () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify(PLAN), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            )
        }),
    })
    renderNewTask()
    await pillReady()
    fireEvent.click(planToggle())
    fireEvent.change(textarea(), { target: { value: 'slow plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plan task' }))

    await screen.findByText('Planning…')
    expect((screen.getByRole('button', { name: 'Plan task' }) as HTMLButtonElement).disabled).toBe(true)

    release()
    await screen.findByText('Proposed chain')
    expect(screen.queryByText('Planning…')).toBeNull()
  })

  it('✕ removes a step and ↑/↓ reorder (the touch-honest path)', async () => {
    serve()
    renderNewTask()
    await planTask()

    fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }))
    expect(stepIds()).toEqual(['implement', 'review'])

    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
    expect(stepIds()).toEqual(['review', 'implement'])

    // Edges are disabled — the first card cannot move up, the last cannot move down.
    expect((screen.getByRole('button', { name: 'Move step 1 up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move step 2 down' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('removing everything leaves the honest empty line and disables Start + Save', async () => {
    serve({ plan: FALLBACK_PLAN })
    renderNewTask()
    await planTask()
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 1' }))

    expect(screen.getByText('(no steps left — discard and plan again)')).toBeTruthy()
    expect((document.querySelector('[data-slot="plan-start"]') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('[data-slot="plan-save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('▶ Start posts the EDITED steps inline — the exact wire payload — and navigates', async () => {
    serve({ createRun: { id: 'planned-1' } })
    writeDraft({ ...readDraft(), archiveWhenDone: true, autoMergePr: true, allowMessaging: false })
    renderNewTask()
    await planTask('Tighten the flaky suite')

    fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)

    await waitFor(() =>
      expect(requests.some((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(true),
    )
    expect(postedBody()).toEqual({
      task: 'Tighten the flaky suite',
      archiveWhenDone: true,
      autoMergePr: true,
      allowMessaging: false,
      steps: [
        { id: 'review', name: 'Review', skill: 'om-fix', prompt: 'Review the changes for {{task}}' },
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      ],
    })
    await waitFor(() => expect(location()).toBe('/tasks/planned-1'))
  })

  it('▶ Start omits a locked native default from the planned run request', async () => {
    serve({
      config: { defaultModels: { claude: 'native-sonnet' }, modelsLocked: true },
      createRun: { id: 'planned-native' },
    })
    renderNewTask()
    await planTask('Plan with native settings')
    expect((document.querySelector('[data-slot="model-pill"]') as HTMLElement).textContent).toContain(
      'native-sonnet',
    )

    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)
    await waitFor(() => expect(postedBody()).toBeDefined())
    expect(postedBody()).toEqual({
      task: 'Plan with native settings',
      steps: PLAN.steps,
    })
  })

  it('▶ Start uses project config while boot health is still pending', async () => {
    const delayedHealth = deferredJson<HealthResponse>()
    serve({ health: delayedHealth.fetch, createRun: { id: 'planned-before-health' } })
    renderNewTask()
    await planTask('Plan before health resolves')

    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)
    await waitFor(() => expect(postedBody()).toBeDefined())

    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
    delayedHealth.release(HEALTH)
  })

  it('does not start a reviewed plan after provider status loses every connection', async () => {
    let current = PROVIDERS_CONNECTED
    serve({
      providerStatus: () =>
        Promise.resolve(
          new Response(JSON.stringify(current), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    })
    const { client } = renderNewTask()
    await planTask('Wait for a connected provider')

    current = PROVIDERS_NONE
    await client.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
    await waitFor(() => expect(textarea().disabled).toBe(true))
    const start = document.querySelector<HTMLButtonElement>('[data-slot="plan-start"]')!
    expect(start.disabled).toBe(true)
    expect(screen.getByText('Connect an agent provider before starting a task.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
    start.removeAttribute('disabled')
    fireEvent.click(start)

    expect(requests.some((request) => request.url === '/api/v1/runs')).toBe(false)
  })

  it('embeds plan review in the page and Escape restores focus to the untouched draft', async () => {
    serve()
    renderNewTask()
    await planTask('keep the keyboard draft')

    expect(screen.getByRole('heading', { name: 'New task / Plan first', level: 1 })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    const review = document.querySelector('[data-slot="plan-review"]')!
    expect(document.activeElement).toBe(review)
    fireEvent.click(screen.getByRole('button', { name: 'Save as chain' }))
    const save = await screen.findByRole('dialog')
    fireEvent.keyDown(save, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.querySelector('[data-slot="plan-review"]')).toBe(review)
    fireEvent.keyDown(review, { key: 'Escape' })

    await waitFor(() => expect(document.querySelector('[data-slot="plan-review"]')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(textarea()))
    expect(textarea().value).toBe('keep the keyboard draft')
    expect(requests.some((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(false)
  })

  it('Discard closes the review and hands back the draft untouched', async () => {
    serve()
    renderNewTask()
    await planTask('keep this text')

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByText('Proposed chain')).toBeNull())
    expect(textarea().value).toBe('keep this text')
    expect(requests.some((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(false)
  })
})

describe('save as chain', () => {
  it('asks for the name in a dialog and posts { name, steps } — no overwrite key uninvited', async () => {
    serve()
    renderNewTask()
    await planTask()

    fireEvent.click(document.querySelector('[data-slot="plan-save"]') as HTMLElement)
    const nameInput = await screen.findByLabelText('Chain name')
    fireEvent.change(nameInput, { target: { value: '  my chain  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save chain' }))

    await waitFor(() =>
      expect(requests.some((r) => r.url === '/api/v1/workflows' && r.method === 'POST')).toBe(true),
    )
    expect(requests.find((r) => r.url === '/api/v1/workflows' && r.method === 'POST')?.body).toEqual({
      name: 'my chain',
      steps: PLAN.steps,
    })
    // Dialog closes on success; the review itself stays open (start is a separate decision).
    await waitFor(() => expect(screen.queryByLabelText('Chain name')).toBeNull())
    expect(screen.getByText('Proposed chain')).toBeTruthy()
    await screen.findByText('Saved — my-chain.yaml')
  })

  it('a 409 opens the overwrite confirm; Yes retries with overwrite: true', async () => {
    serve({
      saveWorkflow: [
        { status: 409, body: { error: 'workflow file already exists: x.yaml', exists: true } },
        { status: 201, body: { path: '.ai/cezar/workflows/my-chain.yaml', name: 'my chain' } },
      ],
    })
    renderNewTask()
    await planTask()

    fireEvent.click(document.querySelector('[data-slot="plan-save"]') as HTMLElement)
    fireEvent.change(await screen.findByLabelText('Chain name'), { target: { value: 'my chain' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save chain' }))

    await screen.findByText('Overwrite “my chain”?')
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite chain' }))

    await waitFor(() => {
      const saves = requests.filter((r) => r.url === '/api/v1/workflows' && r.method === 'POST')
      expect(saves).toHaveLength(2)
      expect(saves[1]?.body).toEqual({ name: 'my chain', steps: PLAN.steps, overwrite: true })
    })
    await waitFor(() => expect(screen.queryByLabelText('Chain name')).toBeNull())
  })

  it('a non-409 failure surfaces the server message and keeps the dialog open', async () => {
    serve({ saveWorkflow: [{ status: 400, body: { error: 'step 2: needs prompt or command' } }] })
    renderNewTask()
    await planTask()

    fireEvent.click(document.querySelector('[data-slot="plan-save"]') as HTMLElement)
    fireEvent.change(await screen.findByLabelText('Chain name'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save chain' }))

    await screen.findByText('step 2: needs prompt or command')
    expect(screen.getByLabelText('Chain name')).toBeTruthy()
  })
})

describe('retained task submission (#164)', () => {
  it('keeps prompt and attachments read-only during delayed success and blocks repeat submits', async () => {
    const delayed = deferredJson<{ id: string }>()
    serve({ createRun: delayed.fetch })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: '  Keep this prompt  ' } })
    fireEvent.paste(textarea(), { clipboardData: { items: [{ kind: 'file', getAsFile: () => new File(['notes'], 'notes.txt', { type: 'text/plain' }) }] } })
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    await startTask()
    expect(textarea().value).toBe('  Keep this prompt  ')
    expect(textarea().readOnly).toBe(true)
    expect(screen.getByText('Execution settings').closest('[inert]')).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Remove notes.txt' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Starting task…').getAttribute('role')).toBe('status')
    for (const keys of [{}, { ctrlKey: true }, { metaKey: true }]) fireEvent.keyDown(textarea(), { key: 'Enter', ...keys })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    expect(requests.filter(r => r.method === 'POST' && r.url === '/api/v1/runs')).toHaveLength(1)
    await act(async () => delayed.release({ id: 'delayed-task' }))
    await waitFor(() => expect(location()).toBe('/tasks/delayed-task'))
    expect(readDraft().text).toBe('')
  })

  it.each([503, 504])('retains failed draft and offers a deliberate retry after HTTP %s', async (status) => {
    serve({ createRun: { error: status === 504 ? 'Gateway timeout' : 'Service unavailable' }, createRunStatus: status })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Retain on failure' } })
    await startTask()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Check Tasks'))
    expect(screen.getByRole('alert').textContent).toContain('retry')
    expect(screen.getByRole('alert').textContent).toContain(status === 504 ? 'Gateway timeout' : 'Service unavailable')
    expect(textarea().value).toBe('Retain on failure')
    expect(textarea().readOnly).toBe(false)
    expect(readDraft().text).toBe('Retain on failure')
    expect(requests.filter(r => r.method === 'POST' && r.url === '/api/v1/runs')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(requests.filter(r => r.method === 'POST' && r.url === '/api/v1/runs')).toHaveLength(2))
  })

  it('does not clear or navigate away from a newer draft after the submitting route unmounts', async () => {
    const delayed = deferredJson<{ id: string }>()
    serve({ createRun: delayed.fetch })
    const first = renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Old task' } })
    await startTask()
    first.unmount()
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'New task' } })
    await act(async () => delayed.release({ id: 'old-task' }))
    expect(readDraft().text).toBe('New task')
    expect(textarea().value).toBe('New task')
    expect(location()).toBe('/new')
  })
})

it.each(['plan', 'bookmarklet'] as const)('a late %s start cannot clear a remounted draft', async (mode) => {
  const delayed = deferredJson<{ id: string }>()
  serve({ createRun: delayed.fetch })
  const first = renderNewTask(mode === 'bookmarklet' ? '/new?auto=1&ref=Old&key=k-real' : '/new')
  if (mode === 'plan') {
    await planTask('Old planned task')
    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)
  }
  await waitFor(() => expect(requests.some(r => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(true))
  first.unmount()
  renderNewTask()
  await pillReady()
  fireEvent.change(textarea(), { target: { value: 'Newer draft' } })
  await act(async () => delayed.release({ id: 'old-created-task' }))
  expect(readDraft().text).toBe('Newer draft')
  expect(textarea().value).toBe('Newer draft')
})

it('clears the submitted dictation draft after delayed creation succeeds', async () => {
  let recognition!: { onresult: ((event: unknown) => void) | null }
  vi.stubGlobal('SpeechRecognition', class {
    onresult = null
    onerror = null
    onend = null
    start() { recognition = this }
    stop() {}
    abort() {}
  })
  const delayed = deferredJson<{ id: string }>()
  serve({ createRun: delayed.fetch })
  renderNewTask()
  await pillReady()
  fireEvent.change(textarea(), { target: { value: 'Typed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
  act(() => recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'and spoken' } }] }))
  fireEvent.click(screen.getByRole('button', { name: 'Insert transcription and send' }))
  await waitFor(() => expect(postedBody()).toMatchObject({ task: 'Typed and spoken' }))
  expect(textarea().value).toBe('Typed and spoken')
  expect(readDraft().text).toBe('Typed and spoken')
  await act(async () => delayed.release({ id: 'dictated-task' }))
  await waitFor(() => expect(location()).toBe('/tasks/dictated-task'))
  expect(readDraft().text).toBe('')
})

// A back click can overtake the thread transition before even its loading fallback commits.
it.each([
  { mode: 'direct', boundary: 'outer' },
  { mode: 'plan', boundary: 'outer' },
  { mode: 'direct', boundary: 'inner' },
  { mode: 'plan', boundary: 'inner' },
] as const)('clears the spent $mode draft with the $boundary thread boundary', async ({ mode, boundary }) => {
  serve({ createRun: { id: 'suspended-task' } })
  renderNewTask('/new', boundary)
  await pillReady()
  if (mode === 'plan') await planTask('Spent task')
  else fireEvent.change(textarea(), { target: { value: 'Spent task' } })
  const original = textarea()
  const push = window.history.pushState.bind(window.history)
  let returned = false
  const navigation = vi.spyOn(window.history, 'pushState').mockImplementation((...args) => {
    push(...args)
    if (window.location.pathname === '/tasks/suspended-task') queueMicrotask(() => {
      fireEvent.click(screen.getByRole('link', { name: 'New task' }))
      returned = true
    })
  })
  try {
    if (mode === 'plan') fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)
    else await startTask()
    await waitFor(() => expect(returned).toBe(true))
    await waitFor(() => expect(location()).toBe('/new'))
    expect(textarea()).toBe(original)
    expect(textarea().value).toBe('')
    expect(readDraft().text).toBe('')
  } finally {
    navigation.mockRestore()
  }
})
