import { productName } from '@/lib/product-name'
import { HEALTH, HEALTH_MULTI, HEALTH_ALL, HEALTH_NO_GIT, PROVIDERS_CONNECTED, PROVIDERS_MULTI, PROVIDERS_NONE, WORKFLOWS, REPO, REPO_NO_GIT, WORKSPACE_CONFIG, requests, deferredJson, serve, renderNewTask, textarea, sourcePill, location, draftSource, pillReady, startTask, postedBody, ACCOUNTS, runnerPill, pickFrom } from './new-task.testkit'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceQueryKeys } from '@/api/queries'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { resetToasts } from '@/components/ui/toaster'
import { resetDraft, writeDraft } from './new-task-draft'
import { cssRules, paintsBefore, targets } from '@/test/css-rules'

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

describe('the hero surface', () => {
  it('keeps default-off completion switches in the draft and sends them on create', async () => {
    serve()
    const view = renderNewTask()
    await pillReady()
    const execution = document.querySelector('[data-slot="execution-options"]')!
    expect(screen.queryByText('After Done', { selector: 'legend:not(.sr-only)' })).toBeNull()
    expect(screen.queryByText('Merge runs before archive when both are on.')).toBeNull()
    for (const name of ['Archive when Done', 'Auto-merge PR']) {
      const control = screen.getByRole('switch', { name })
      expect(execution.contains(control)).toBe(true)
      expect(control.getAttribute('aria-checked')).toBe('false')
      fireEvent.click(control)
    }
    expect(screen.getByText('Merge runs before archive when both are on.')).toBeTruthy()
    view.unmount()
    renderNewTask()
    await pillReady()
    expect(screen.getByRole('switch', { name: 'Auto-merge PR' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Archive when Done' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    await startTask()
    expect(postedBody()).toMatchObject({ archiveWhenDone: true, autoMergePr: true })
  })

  it('defaults task access on and sends an explicit off on create (hearsay-tools/cezarion#2784)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const execution = document.querySelector('[data-slot="execution-options"]')!
    const group = screen.getByRole('group', { name: 'Task access' })
    expect(execution.contains(group)).toBe(true)
    const workers = screen.getByRole('switch', { name: `Allow ${productName("cezar")} workers` })
    const messaging = screen.getByRole('switch', { name: 'Allow task messaging' })
    expect(workers.getAttribute('aria-checked')).toBe('true')
    expect(messaging.getAttribute('aria-checked')).toBe('true')
    expect(document.getElementById(workers.getAttribute('aria-describedby')!)?.textContent).toBe(
      `Agents in this task can start ${productName("Cezar")} workers. Each worker is a separate paid agent session. Worker limits cap resources, not spending.`,
    )
    expect(document.getElementById(messaging.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Agents in this task can message other tasks in this project.',
    )
    fireEvent.click(workers)
    expect(workers.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    await startTask()
    expect(postedBody()).toMatchObject({ allowWorkers: false })
    expect(postedBody()).not.toHaveProperty('allowMessaging')
  })

  it('describes the selected working directory directly under Worktree', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const worktree = screen.getByRole('checkbox', { name: 'Worktree' })
    expect(worktree.textContent).toContain('Changes stay in a separate working copy.')
    expect(document.querySelector('[data-slot="execution-tip"]')).toBeNull()
    fireEvent.click(worktree)
    expect(worktree.textContent).toContain('Changes are made in the current working directory.')
    expect(worktree.nextElementSibling?.textContent).toContain('Base branch')
  })

  // hearsay-tools/cezarion#1605: Base branch sits above Autonomous. Inserting it when `/repo`
  // answered moved that toggle mid-click, so a browser's second click hit the Base branch row.
  // Removing it when `/repo` failed moved the toggle the same way.
  it.each([
    { outcome: 'answers', status: 200 },
    { outcome: 'fails', status: 404 },
  ])('keeps the rows above Autonomous in place when the repo $outcome', async ({ status }) => {
    let answerRepo!: () => void
    serve({
      repo: () => new Promise<Response>((resolve) => {
        const body = status === 200 ? REPO : { error: 'no repo' }
        answerRepo = () => resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
      }),
    })
    const { client } = renderNewTask()
    await pillReady()
    const rowsAboveAutonomous = () => {
      const rows: Element[] = []
      for (let row = screen.getByRole('checkbox', { name: 'Autonomous' }).previousElementSibling; row; row = row.previousElementSibling) rows.push(row)
      return rows
    }
    const pending = rowsAboveAutonomous()
    expect(pending[0]?.textContent).toContain('Base branch')
    answerRepo()
    const repoStatus = () => client.getQueryCache().findAll().find((query) => query.queryKey.at(-1) === 'repo')?.state.status
    await waitFor(() => {
      expect(repoStatus()).toBe(status === 200 ? 'success' : 'error')
      const settled = rowsAboveAutonomous()
      expect(settled).toHaveLength(pending.length)
      expect(settled.every((row, index) => row === pending[index])).toBe(true)
    })
    expect(document.querySelector('[data-slot="base-pill"]') !== null).toBe(status === 200)
  })

  it('keeps run options in a disclosure separate from prompt, agent selection, and submission', async () => {
    serve({ health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()
    const summary = screen.getByText('Execution settings')
    const disclosure = summary.closest('details')!
    expect(disclosure).not.toBeNull()
    expect(disclosure.open).toBe(true)
    expect(disclosure.contains(sourcePill())).toBe(false)
    expect(disclosure.contains(screen.getByRole('radio', { name: 'Plan first' }))).toBe(false)
    expect(disclosure.contains(screen.getByRole('button', { name: 'Start task' }))).toBe(false)
    expect(summary.parentElement?.textContent).toContain('claude')
    const model = screen.getByRole('button', { name: /^Model · / })
    expect(disclosure.contains(model)).toBe(false)
    fireEvent.pointerDown(model)
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /sonnet/ }))
    expect(summary.parentElement?.textContent).toContain('sonnet')
    fireEvent.change(textarea(), { target: { value: 'Keep this draft' } })
    const originalTextarea = textarea()
    fireEvent.click(summary)
    fireEvent.click(summary)
    expect(textarea()).toBe(originalTextarea)
    expect(textarea().value).toBe('Keep this draft')
    expect(screen.queryByRole('button', { name: 'Parallel variants' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Model · / })).toBe(model)
  })

  it('renders the design hero without decorative backdrops and focuses the textarea', async () => {
    serve()
    renderNewTask()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What should the agent work on?')
    expect(document.querySelector('[data-slot="page-eyebrow"]')?.textContent).toBe('NEW TASK')
    expect(document.querySelector('[data-slot="page-description"]')?.textContent).toBe(
      'Describe the outcome. Configure the run. Review everything before it lands.',
    )
    expect(screen.getByText('Runs in an isolated worktree — review everything before it lands.')).toBeTruthy()
    expect(document.querySelector('[data-route="new"] [data-slot="twinkle-backdrop"]')).toBeNull()
    // Asserted here for the DEFAULT run mode only. #793: this line used to be printed
    // unconditionally, so it also claimed isolation for runs that had opted out of it — the
    // per-state cases live in "the run-mode note" below.
    await pillReady()
    // ⌘N drops you here to type — after the provider check enables the composer, the caret
    // must land in the box without the user clicking it.
    await waitFor(() => expect(document.activeElement).toBe(textarea()))
  })

  it.each([false, true])('restores sidebar focus after providers load unless the user moved it: %s', async (moveFocus) => {
    const providers = deferredJson<typeof PROVIDERS_CONNECTED>()
    serve({ providerStatus: providers.fetch })
    const anchor = document.createElement('a')
    anchor.href = '/new'
    document.body.append(anchor)
    anchor.focus()
    const view = renderNewTask()
    try {
      expect(textarea().disabled).toBe(true)
      expect(document.activeElement).toBe(anchor)
      const other = screen.getByRole('checkbox', { name: 'Autonomous' })
      if (moveFocus) other.focus()
      await act(async () => { providers.release(PROVIDERS_CONNECTED) })
      await waitFor(() => expect(textarea().disabled).toBe(false))
      await waitFor(() => expect(document.activeElement).toBe(moveFocus ? other : textarea()))
    } finally {
      view.unmount()
      anchor.remove()
    }
  })

  it('does not render suggestion chips — design.pen 1A–1D have none', async () => {
    serve()
    renderNewTask()
    await pillReady()
    expect(document.querySelector('[data-slot="suggested-chip"]')).toBeNull()
    expect(screen.queryByText('Start with a suggestion')).toBeNull()
  })
})

describe('picker data flows', () => {
  it('keeps agent selection with the editor and run settings in the open execution panel', async () => {
    serve()
    renderNewTask()
    await pillReady()

    const editor = document.querySelector('[data-slot="composer-editor"]') as HTMLElement
    const execution = document.querySelector('[data-slot="execution-options"]') as HTMLDetailsElement
    const model = document.querySelector('[data-slot="model-pill"]') as HTMLElement
    const variants = document.querySelector('[data-slot="variants-pill"]') as HTMLElement
    expect(execution.open).toBe(true)
    expect(editor.contains(model)).toBe(false)
    expect(document.querySelector('[data-slot="composer-agent-options"]')?.contains(model)).toBe(true)
    expect(execution.contains(model)).toBe(false)
    expect(variants).toBeNull()
  })

  it('uses one in-pill Field · value grammar for Model, Runner, and Effort (#272)', async () => {
    serve({ health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()
    expect(screen.getByRole('button', { name: /^Model · / }).textContent).toMatch(/^Model \u00b7 /)
    expect(screen.getByRole('button', { name: /^Runner · / }).textContent).toMatch(/^Runner \u00b7 /)
    expect(screen.getByRole('button', { name: /^Effort · / }).textContent).toMatch(/^Effort \u00b7 /)
    expect(document.querySelector('.new-task-model-label')).toBeNull()
    expect(document.querySelector('.new-task-runner-control')).toBeNull()
  })

  it('hides the runner pill on a single-backend host (legacy rule)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    expect(document.querySelector('[data-slot="model-pill"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="effort-pill"]')).not.toBeNull()
  })

  it('filters effort by model and resets an unsupported pick before submission', async () => {
    serve({
      health: HEALTH_MULTI,
      providerStatus: PROVIDERS_MULTI,
      models: {
        runner: 'codex',
        models: [
          { id: 'gpt-wide', label: 'gpt-wide', description: '', effortLevels: ['high', 'xhigh'] },
          { id: 'gpt-lean', label: 'gpt-lean', description: '', effortLevels: ['low'] },
        ],
        source: 'live',
        stale: false,
      },
    })
    renderNewTask()
    await pillReady()

    const runner = document.querySelector('[data-slot="runner-pill"]') as HTMLElement
    fireEvent.pointerDown(runner)
    let options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((option) => option.textContent?.includes('codex')) as HTMLElement)
    await waitFor(() => expect(runner.textContent).toContain('codex'))

    const model = document.querySelector('[data-slot="model-pill"]') as HTMLElement
    fireEvent.pointerDown(model)
    let modelOption: HTMLElement | undefined
    await waitFor(() => {
      modelOption = screen.getAllByRole('menuitemradio')
        .find((option) => option.textContent?.includes('gpt-wide'))
      expect(modelOption).toBeDefined()
    })
    fireEvent.click(modelOption as HTMLElement)

    const effort = screen.getByRole('button', { name: /^Effort · / })
    fireEvent.pointerDown(effort)
    options = await screen.findAllByRole('menuitemradio')
    expect(options).toHaveLength(3)
    expect(options.some((option) => option.textContent?.includes('low'))).toBe(false)
    fireEvent.click(options.find((option) => option.textContent?.includes('xhigh')) as HTMLElement)
    expect(effort.textContent).toContain('xhigh')

    fireEvent.pointerDown(model)
    options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((option) => option.textContent?.includes('gpt-lean')) as HTMLElement)
    await waitFor(() => expect(effort.textContent).toContain('auto'))

    fireEvent.change(textarea(), { target: { value: 'use supported effort only' } })
    await startTask()
    expect(postedBody()).toMatchObject({ runner: 'codex', model: 'gpt-lean' })
    expect((postedBody() as { effort?: string | undefined }).effort).toBeUndefined()
  })

  it('shows the runner pill with >1 backend, and switching runner swaps the model presets', async () => {
    serve({ health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()

    const runnerPill = () => document.querySelector('[data-slot="runner-pill"]') as HTMLElement
    await waitFor(() => expect(runnerPill()).not.toBeNull())
    expect(runnerPill().textContent).toContain('claude')

    // claude's presets first…
    fireEvent.pointerDown(document.querySelector('[data-slot="model-pill"]') as HTMLElement)
    let options = await screen.findAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('opus'), expect.stringContaining('sonnet')]),
    )
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0))

    // …pick codex…
    fireEvent.pointerDown(runnerPill())
    options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('codex')) as HTMLElement)
    await waitFor(() => expect(runnerPill().textContent).toContain('codex'))
    // …the model reset to auto and the presets are codex's now.
    expect((document.querySelector('[data-slot="model-pill"]') as HTMLElement).textContent).toContain('auto')
    fireEvent.pointerDown(document.querySelector('[data-slot="model-pill"]') as HTMLElement)
    // codex's catalog is fetched for the runner now SELECTED (#794), so it lands after the switch.
    await waitFor(() => {
      const labels = screen.getAllByRole('menuitemradio').map((o) => o.textContent ?? '')
      expect(labels.some((l) => l.includes('gpt-future'))).toBe(true)
      expect(labels.some((l) => l.includes('opus'))).toBe(false)
    })
  })

  it('excludes disconnected providers from the runner choices even when health detects them', async () => {
    serve({ health: HEALTH_ALL, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()

    const runnerPill = document.querySelector('[data-slot="runner-pill"]') as HTMLElement
    fireEvent.pointerDown(runnerPill)
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('claude'),
      expect.stringContaining('codex'),
    ])
    expect(options.some((option) => option.textContent?.includes('opencode'))).toBe(false)
  })

  it('excludes connected but disabled providers while retaining an enabled runner choice', async () => {
    serve({
      health: HEALTH_ALL,
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'connected', enabled: false },
        ],
      },
    })
    renderNewTask()
    await pillReady()

    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    expect(textarea().disabled).toBe(false)
  })

  it('drops a persisted model preset that belongs to another runner', async () => {
    writeDraft({
      text: '', source: null, runner: 'codex', agentProfile: null, model: 'claude-opus-4-8', effort: null, retiredVariants: false,
      planFirst: false, worktree: null, autonomous: null, archiveWhenDone: false, autoMergePr: false, allowWorkers: true, allowMessaging: true,
    })
    serve({ health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()

    const modelPill = document.querySelector('[data-slot="model-pill"]') as HTMLElement
    await waitFor(() => expect(modelPill.textContent).toContain('auto'))
    fireEvent.pointerDown(modelPill)
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.some((option) => option.textContent?.includes('claude-opus-4-8'))).toBe(false)
  })

  describe('the run-mode note (#793)', () => {
    const note = () => document.querySelector('[data-slot="run-mode-note"]')?.textContent

    it('promises isolation only while the run will actually get a worktree', async () => {
      serve()
      renderNewTask()
      await pillReady()
      expect(note()).toBe('Runs in an isolated worktree — review everything before it lands.')

      // Unchecking the chip changes where the work lands, so it has to change what the header
      // says. This is the regression: the line was printed unconditionally, so it kept promising
      // isolation for a run that was about to edit the user's checkout directly.
      fireEvent.click(document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement)
      await waitFor(() => expect(note())
        .toBe('Runs in the repo working tree — your checkout is modified directly.'))
    })

    it('explains a non-git folder rather than warning about a checkout', async () => {
      // There is no worktree to opt into here, so "your checkout is modified directly" would be
      // the wrong half of the truth — the user needs to know WHY there is no isolation on offer.
      serve({ health: HEALTH_NO_GIT, repo: REPO_NO_GIT })
      renderNewTask()
      await pillReady()
      expect(note())
        .toBe('Runs in place — no git repository detected, so there is no worktree to isolate in.')
    })

    it('follows the workspace Worktree-off policy, not just an explicit click', async () => {
      // The resolved mode, not the draft: a run can land in the checkout because policy said so,
      // and the header has to be honest about that too.
      serve({
        workspaceConfig: {
          ...WORKSPACE_CONFIG,
          composerDefaults: { ...WORKSPACE_CONFIG.composerDefaults!, inheritedWorktree: false },
        },
      })
      renderNewTask()
      await pillReady()
      await waitFor(() => expect(note())
        .toBe('Runs in the repo working tree — your checkout is modified directly.'))
    })
  })

  it('has no parallel variant control, including without git', async () => {
    serve({ health: HEALTH_NO_GIT, repo: REPO_NO_GIT })
    renderNewTask()
    await pillReady()
    expect(document.querySelector('[data-slot="variants-pill"]')).toBeNull()
    expect(document.querySelector('[data-slot="base-pill"]')).toBeNull()
  })

  // #791: health is bound to the boot folder, so a cezar booted outside a git repo answered
  // `repo: null` for EVERY project. Reading git state from the project-scoped `/repo` instead is
  // what keeps the worktree controls alive for a git project under a non-git boot root.
  it('offers worktrees for the project repo even when the boot folder has no git', async () => {
    serve({ health: HEALTH_NO_GIT, repo: REPO })
    renderNewTask()
    await pillReady()
    expect(document.querySelector('[data-slot="worktree-toggle"]')).not.toBeNull()
    fireEvent.change(textarea(), { target: { value: 'Fix the composer git detection' } })
    await startTask()
    // `worktree` is sent only when explicitly OFF (new-task-form.ts): an absent key IS the
    // isolated-worktree default, so absence — not `worktree: false` — is what the fix restores.
    expect(postedBody()).not.toHaveProperty('worktree')
  })

  it('base branch pill shows config default (falling back to the checkout) and PUTs /api/v1/config', async () => {
    serve({ repo: { ...REPO, baseBranch: 'develop' } })
    renderNewTask()
    await pillReady()
    const basePill = () => document.querySelector('[data-slot="base-pill"]') as HTMLElement
    await waitFor(() => expect(basePill()).not.toBeNull())
    expect(basePill().textContent).toContain('develop')

    fireEvent.pointerDown(basePill())
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('follow checked-out branch (main)'),
      expect.stringContaining('main'),
      expect.stringContaining('develop'),
    ])
    fireEvent.click(options[0] as HTMLElement)
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/config')).toBe(true),
    )
    // find the PUT specifically — the composer also GETs /api/v1/config for the model presets.
    expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/config')?.body).toEqual({
      baseBranch: null,
    })
  })

  it('filters base branches by name', async () => {
    serve({ repo: { ...REPO, branches: ['main', 'develop', 'feature/searchable-base'] } })
    renderNewTask()
    await pillReady()

    fireEvent.pointerDown(document.querySelector('[data-slot="base-pill"]') as HTMLElement)
    const search = await screen.findByRole('searchbox', { name: 'Search branches…' })
    fireEvent.change(search, { target: { value: ' SEARCHABLE ' } })

    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual([
      expect.stringContaining('feature/searchable-base'),
    ])
    expect(screen.queryByText('develop')).toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByText('No matches found.')).not.toBeNull()

    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('searchbox', { name: 'Search branches…' })).toBeNull())
    fireEvent.pointerDown(document.querySelector('[data-slot="base-pill"]') as HTMLElement)
    const reopenedSearch = await screen.findByRole('searchbox', { name: 'Search branches…' })
    expect((reopenedSearch as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)
  })

  it('opens with NOTHING picked, whatever the last run used', async () => {
    // The report this fixes: a skill picked once sat in the pill for every task afterwards,
    // and the composer offered no way to take it out. `lastTask` is still recorded — it just
    // no longer decides what the next task runs.
    serve({ uiState: { lastTask: { source: 'skill', ref: 'om-fix' } } })
    renderNewTask()
    await pillReady()
    expect(sourcePill().getAttribute('data-source-kind')).toBe('none')
    expect(sourcePill().textContent).not.toContain('om-fix')
  })

  it('preselects the draft pick, and drops it when the catalog no longer has it', async () => {
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve()
    renderNewTask()
    await pillReady('fix-and-verify')

    cleanup()
    resetDraft()
    draftSource({ source: 'skill', ref: 'deleted-skill' })
    serve()
    renderNewTask()
    await pillReady()
    expect(sourcePill().getAttribute('data-source-kind')).toBe('none')
  })

  it('the source menu groups: Project skills (bold), Workflows, Global last', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')

    const options = [...document.querySelectorAll('[data-slot="source-option"]')]
    // "No skill" leads, heading-less; `quick-task` is NOT a row of its own — that row is it.
    expect(options.map((o) => o.getAttribute('data-source-kind'))).toEqual([
      'none', 'skill', 'workflow', 'skill',
    ])
    expect(options.map((o) => o.getAttribute('data-source-ref'))).toEqual([
      null, 'om-fix', 'fix-and-verify', 'deploy',
    ])
    expect(options[0]!.textContent).toContain('No skill')
    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(headings).toEqual(['Project skills', 'Workflows', 'Global'])
  })

  it('the empty pill reads "Skill or workflow" when the catalog offers workflows — "Skill" when it has none (#263)', async () => {
    // The default mock catalog has fix-and-verify beyond the built-in, so the control must
    // announce BOTH kinds — a label that only says "Skill" hid the workflow picker (#263).
    serve()
    renderNewTask()
    await pillReady('Skill or workflow')
    expect(sourcePill().textContent).toBe('Skill or workflow')

    cleanup()
    resetDraft()
    // A catalog of only the built-in offers no workflow to pick — "Skill" stays the honest label.
    serve({ workflows: { workflows: [WORKFLOWS.workflows[0]!], issues: [] } })
    renderNewTask()
    await pillReady('Skill')
    expect(sourcePill().textContent).toBe('Skill')
  })

  it('multi-keyword search: "fix issue" matches om-fix via hyphen-split keywords (#411)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')

    // "fix issue" should match "om-fix" because both "fix" and "issue" appear in the
    // combined value+keywords text (name splits: "om","fix" + description "Fix an issue end to end").
    fireEvent.change(input, { target: { value: 'fix issue' } })
    await waitFor(() => {
      const visible = [...document.querySelectorAll('[data-slot="source-option"]')]
      expect(visible.some((o) => o.getAttribute('data-source-ref') === 'om-fix')).toBe(true)
    })
  })

  it('multi-keyword search hides items that do not match all words (#411)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')

    fireEvent.change(input, { target: { value: 'deploy fix' } })
    await waitFor(() => {
      // "deploy" does not have "fix" in its name/description, and "om-fix" does not have "deploy"
      const visible = [...document.querySelectorAll('[data-slot="source-option"]')]
      expect(visible).toHaveLength(0)
    })
  })

  it('typing an exact skill name ranks that skill first even when a weaker hit is Most used (#255)', async () => {
    serve({
      skills: [
        { name: 'om-code-review', description: 'Review a PR', body: '', path: '/p/om-code-review.md', source: 'ai' },
        { name: 'review', description: 'The review skill', body: '', path: '/g/review.md', source: 'global' },
      ],
      uiState: { skillUsage: { 'om-code-review': 999 } },
    })
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.change(input, { target: { value: 'review' } })
    await waitFor(() => {
      const skills = [...document.querySelectorAll('[data-slot="source-option"][data-source-kind="skill"]')]
      expect(skills.map((o) => o.getAttribute('data-source-ref'))).toEqual(['review', 'om-code-review'])
    })
  })
})

describe('skill picker touch focus', () => {
  function pointer(target: Element, type: string, pointerType: string) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    fireEvent(target, event)
    return event
  }

  it('opens from touch without focusing search, then allows explicit search focus', async () => {
    serve()
    renderNewTask()
    await pillReady()
    pointer(sourcePill(), 'pointerdown', 'touch')
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')
    expect(document.activeElement).not.toBe(input)
    expect(document.activeElement).toBe(input.closest('[data-slot="popover-content"]'))
    act(() => input.focus())
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'deploy' } })
    expect(document.querySelectorAll('[data-slot="source-option"]')).toHaveLength(1)
    expect(document.querySelector('[data-slot="source-option"]')?.getAttribute('data-source-ref')).toBe('deploy')
  })

  it('touch movement does not refocus search or change the hovered selection', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')
    expect(document.activeElement).toBe(input)
    // iOS can dismiss its keyboard while leaving the input as activeElement.
    const focus = vi.spyOn(input, 'focus')
    try {
      const selected = document.querySelector('[data-slot="source-option"][aria-selected="true"]')
      const last = document.querySelector('[data-source-ref="deploy"][data-slot="source-option"]')!
      const event = pointer(last, 'pointermove', 'touch')
      expect(focus).not.toHaveBeenCalled()
      expect(last.getAttribute('aria-selected')).toBe('false')
      expect(selected?.getAttribute('aria-selected')).toBe('true')
      expect(event.defaultPrevented).toBe(false) // native scrolling remains available
      expect(screen.queryByPlaceholderText('search skills & workflows…')).toBe(input)
      fireEvent.click(last)
      expect(sourcePill().textContent).toContain('deploy')
    } finally {
      focus.mockRestore()
    }
  })

  it('keeps desktop hover, arrow keys, Enter selection and Escape dismissal', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')
    expect(document.activeElement).toBe(input)
    const last = document.querySelector('[data-source-ref="deploy"][data-slot="source-option"]')!
    pointer(last, 'pointermove', 'mouse')
    expect(last.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(document.querySelector('[data-source-ref="fix-and-verify"][data-slot="source-option"]')?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sourcePill().textContent).toContain('deploy')
    await waitFor(() => expect(screen.queryByPlaceholderText('search skills & workflows…')).toBeNull())
    fireEvent.click(sourcePill())
    const reopened = await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.keyDown(reopened, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByPlaceholderText('search skills & workflows…')).toBeNull())
  })
})

describe('clearing the picked skill or workflow', () => {
  const clearButton = () => document.querySelector<HTMLButtonElement>('[data-slot="source-pill-clear"]')
  const openMenu = async () => {
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
  }
  const option = (kind: string, ref?: string) =>
    document.querySelector<HTMLElement>(
      ref === undefined
        ? `[data-slot="source-option"][data-source-kind="${kind}"]`
        : `[data-slot="source-option"][data-source-kind="${kind}"][data-source-ref="${ref}"]`,
    )

  it('the ✕ clears in one click, without opening the menu', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    expect(clearButton()?.getAttribute('aria-label')).toBe('Clear the skill om-fix')
    fireEvent.click(clearButton()!)

    await waitFor(() => expect(sourcePill().getAttribute('data-source-kind')).toBe('none'))
    // No menu was ever opened — the whole point of the affordance.
    expect(screen.queryByPlaceholderText('search skills & workflows…')).toBeNull()
    // And the run really does go out as the plain built-in.
    fireEvent.change(textarea(), { target: { value: 'Ship it plain' } })
    await startTask()
    expect(postedBody()).toEqual({ task: 'Ship it plain', workflow: 'quick-task' })
  })

  it('offers no ✕ while nothing is picked — there is nothing to clear', async () => {
    serve()
    renderNewTask()
    await pillReady()
    expect(clearButton()).toBeNull()
  })

  it('Backspace on the focused pill clears it, like a token in a tag field', async () => {
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve()
    renderNewTask()
    await pillReady('fix-and-verify')

    fireEvent.keyDown(sourcePill(), { key: 'Backspace' })
    await waitFor(() => expect(sourcePill().getAttribute('data-source-kind')).toBe('none'))
  })

  it('leaves the pill alone on ⌘/Ctrl+Backspace — that is a text gesture, not a picker one', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    fireEvent.keyDown(sourcePill(), { key: 'Backspace', metaKey: true })
    expect(sourcePill().getAttribute('data-source-kind')).toBe('skill')
  })

  it('picking the SELECTED row again clears it — for a skill and for a workflow', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    await openMenu()
    fireEvent.click(option('skill', 'om-fix')!)
    await waitFor(() => expect(sourcePill().getAttribute('data-source-kind')).toBe('none'))

    await openMenu()
    fireEvent.click(option('workflow', 'fix-and-verify')!)
    await waitFor(() => expect(sourcePill().textContent).toContain('fix-and-verify'))
    await openMenu()
    fireEvent.click(option('workflow', 'fix-and-verify')!)
    await waitFor(() => expect(sourcePill().getAttribute('data-source-kind')).toBe('none'))
  })

  it('the "No skill" row clears the picker, and answers to a search for quick-task', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    await openMenu()
    const input = screen.getByPlaceholderText('search skills & workflows…')
    // The built-in has no row of its own any more — typing its name finds the row that runs it.
    fireEvent.change(input, { target: { value: 'quick' } })
    await waitFor(() => {
      const visible = [...document.querySelectorAll('[data-slot="source-option"]')]
      expect(visible.map((o) => o.getAttribute('data-source-kind'))).toEqual(['none'])
    })

    fireEvent.click(option('none')!)
    await waitFor(() => expect(sourcePill().getAttribute('data-source-kind')).toBe('none'))
  })

  it('a cleared pill stays cleared for the NEXT task, and the started one is not remembered', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve({ createRun: { id: 'run-2' } })
    renderNewTask()
    await pillReady('om-fix')
    fireEvent.change(textarea(), { target: { value: 'Fix it with the skill' } })
    await startTask()
    await waitFor(() => expect(location()).toBe('/tasks/run-2'))

    // Same browser, same project, next visit: the skill went with the task it ran.
    cleanup()
    serve()
    renderNewTask()
    await pillReady()
    expect(sourcePill().getAttribute('data-source-kind')).toBe('none')
  })
})

describe('provider authentication gate', () => {
  it('keeps a pending status honest without claiming that providers are missing', async () => {
    let release!: (response: Response) => void
    serve({
      providerStatus: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    renderNewTask()

    await waitFor(() => expect(sourcePill().textContent).toContain('Skill'))
    expect(textarea().disabled).toBe(true)
    expect(textarea().placeholder).toBe('Checking agent providers…')
    expect(screen.queryByRole('link', { name: 'Configure providers' })).toBeNull()
    expect(document.body.textContent).not.toContain('Connect an agent provider')

    release(
      new Response(JSON.stringify(PROVIDERS_CONNECTED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })

  it('disables Start and Plan and links to project-aware provider settings when none connect', async () => {
    serve({ providerStatus: PROVIDERS_NONE })
    renderNewTask('/p/acme/new')

    await waitFor(() =>
      expect(textarea().placeholder).toBe('Connect an agent provider before starting a task.'),
    )
    expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Plan first' }))
    expect((screen.getByRole('button', { name: 'Plan task' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/p/acme/settings/agents#providers',
    )
  })

  it('disables submission with verification-failed copy and setup guidance on a status error', async () => {
    serve({ providerStatus: { providers: [] }, providerStatusStatus: 404 })
    renderNewTask()

    await waitFor(() =>
      expect(textarea().placeholder).toBe('Provider authentication could not be verified.'),
    )
    expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
  })

  it('one connected provider suppresses the runner pill but leaves submission enabled', async () => {
    serve({
      health: { ...HEALTH_MULTI, defaultRunner: 'codex' },
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask()
    await pillReady()

    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    fireEvent.change(textarea(), { target: { value: 'Use the only connected provider' } })
    expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('can safely omit the runner while boot health is pending because project config is authoritative', async () => {
    const delayedHealth = deferredJson<HealthResponse>()
    serve({ health: delayedHealth.fetch })
    renderNewTask()
    await pillReady()

    fireEvent.change(textarea(), { target: { value: 'Start before health resolves' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
    delayedHealth.release(HEALTH)
  })

  it('posts an explicit connected fallback when the configured default is disconnected', async () => {
    serve({
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Fall back safely' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).runner).toBe('codex')
  })

  it('stays enabled when one provider is connected and another status is unknown', async () => {
    serve({
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'unknown', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Known-good provider wins' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).runner).toBe('codex')
  })

  it('a status refresh enables an already-open form without a reload', async () => {
    let current = PROVIDERS_NONE
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
    await waitFor(() =>
      expect(textarea().placeholder).toBe('Connect an agent provider before starting a task.'),
    )

    current = PROVIDERS_CONNECTED
    await client.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
    await waitFor(() => expect(textarea().disabled).toBe(false))
  })
})

describe('prompt templates on the new-task composer', () => {
  const ASSIGNED = [
    { id: 'assigned', label: 'Fix rules', text: 'Follow the fix rules.', skills: ['om-fix'] },
    { id: 'manual', label: 'Manual', text: 'Never auto.' },
  ]

  const templateTrigger = () => screen.getByRole('button', { name: 'Insert a prompt template' })
  const option = (id: string) =>
    document.querySelector<HTMLElement>(`[data-slot="prompt-template-option"][data-template="${id}"]`)

  const pickSource = async (ref: string) => {
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.click(document.querySelector(`[data-slot="source-option"][data-source-ref="${ref}"]`)!)
  }

  it('labels the template picker alongside the skill picker', async () => {
    serve()
    renderNewTask()
    await pillReady()

    // No "templates" word next to the icon, unlike the roomier GitHub composer.
    expect(templateTrigger().textContent).toContain('Template')
    expect(templateTrigger().querySelector('svg')).not.toBeNull()
  })

  it('inserts a template into the composer draft at the caret', async () => {
    serve()
    renderNewTask()
    await pillReady()

    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    fireEvent.click(templateTrigger())
    await waitFor(() => expect(option('add-tests')).not.toBeNull())
    fireEvent.click(option('add-tests')!)

    await waitFor(() =>
      expect(textarea().value).toBe('Ship it\n\nAlso add or update tests covering this change.'),
    )
  })

  it('picking a skill auto-applies the templates assigned to it into an empty composer', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))
  })

  it('switching to a skill with nothing assigned takes the auto-applied text back out', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))

    await pickSource('deploy')
    await waitFor(() => expect(textarea().value).toBe(''))
  })

  it('NEVER overwrites a draft the user already typed', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    fireEvent.change(textarea(), { target: { value: 'my own words' } })
    await pickSource('om-fix')

    await waitFor(() => expect(sourcePill().textContent).toContain('om-fix'))
    expect(textarea().value).toBe('my own words')
  })

  it('a workflow never auto-applies — assignment is a skill concept', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('fix-and-verify')
    await waitFor(() => expect(sourcePill().textContent).toContain('fix-and-verify'))
    expect(textarea().value).toBe('')
  })

  it('the auto-applied text is what actually gets submitted', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))

    await startTask()
    // The auto-applied text is the real task text on the wire, not just something on screen.
    expect(postedBody()).toMatchObject({
      task: 'Follow the fix rules.',
      steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }],
    })
  })
})

describe('the composer runner pill carries the account', () => {
  it('adds nothing when no second login exists — the zero-config composer is unchanged', async () => {
    serve({
      agentProfiles: { ...ACCOUNTS, profiles: ACCOUNTS.profiles.filter((p: (typeof ACCOUNTS)['profiles'][number]) => p.isDefault) },
    })
    renderNewTask()
    await pillReady()
    // Settled: the model pill (rendered unconditionally beside it) is up, so this is not a race.
    await waitFor(() => expect(document.querySelector('[data-slot="model-pill"]')).not.toBeNull())
    // One runner and no accounts leaves nothing to choose, so the pill stays away entirely.
    expect(runnerPill()).toBeNull()
    expect(document.querySelector('[data-slot="account-pill"]')).toBeNull()
  })

  it('lists every agent-and-login as ONE flat row, on a single-runner host too', async () => {
    // Two regressions in one: folding the account into the runner pill must not hide it on a
    // claude-only machine (where the pill never used to render), and the list must be flat —
    // one row per thing that can run the task, not a runner choice with an account choice nested
    // under it.
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    fireEvent.pointerDown(runnerPill()!)
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent?.replace(/\s+/g, ' '))).toEqual([
      'claude · Default/home/u/.claude'.replace(/\s+/g, ' '),
      'claude · Klaudiusz~/.claude-klaudiusz'.replace(/\s+/g, ' '),
    ])
    // Each row names its folder: the labels are cezar's invention, the folder is the account.
    expect(options[1]?.textContent).toContain('~/.claude-klaudiusz')
  })

  it('starts on the account the repo is set to, without the user picking anything', async () => {
    serve({
      agentProfiles: { ...ACCOUNTS, selections: { '/repo': { claude: 'klaudiusz' } } },
    })
    renderNewTask()
    await pillReady()
    // The repo's choice IS the initial selection — no "repo default" abstraction to decode.
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))

    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // …and an untouched pill still sends nothing, so the repo stays in charge.
    expect(postedBody()).not.toHaveProperty('agentProfile')
  })

  it('sends `default` explicitly when the repo points elsewhere — not an absent key', async () => {
    // The one case where "follow the repo" and "the discovered account" differ. An absent key would
    // run the task on Klaudiusz, which is the opposite of what picking `claude · Default` says.
    serve({
      agentProfiles: { ...ACCOUNTS, selections: { '/repo': { claude: 'klaudiusz' } } },
    })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))

    await pickFrom(runnerPill()!, 'Default')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Default'))
    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()

    expect(postedBody()).toMatchObject({ agentProfile: 'default' })
  })

  it('sends the picked account on the wire', async () => {
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    await pickFrom(runnerPill()!, 'Klaudiusz')
    // The pill says which login the task will really use, not just which agent.
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))
    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()

    expect(postedBody()).toMatchObject({ agentProfile: 'klaudiusz' })
  })

  it('sends NOTHING when the repo default is left alone', async () => {
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // An absent key means "follow the repo", which is what an untouched control means.
    expect(postedBody()).not.toHaveProperty('agentProfile')
  })

  it('switches back to the discovered account after picking another', async () => {
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    await pickFrom(runnerPill()!, 'Klaudiusz')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))
    await pickFrom(runnerPill()!, 'Default')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Default'))

    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // This repo has no selection of its own, so `default` and "follow the repo" agree — but the
    // pick was explicit, and saying so keeps it true if the repo setting changes before it starts.
    expect(postedBody()).toMatchObject({ agentProfile: 'default' })
  })

  it('drops an account belonging to another runner when the runner switches', async () => {
    // A Claude account must not ride along into a codex run: the id means nothing there, and
    // sending it would assert a choice the user never made for that engine.
    serve({ agentProfiles: ACCOUNTS, health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    await pickFrom(runnerPill()!, 'Klaudiusz')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('Klaudiusz'))

    await pickFrom(runnerPill()!, 'codex')

    // Codex has no second login, so the account group goes away and the pill is a runner again…
    await waitFor(() => expect(runnerPill()?.querySelector('[data-slot="picker-label"]')?.textContent?.trim()).toBe('Runner · codex'))
    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // …and nothing account-shaped reaches the wire.
    expect(postedBody()).not.toHaveProperty('agentProfile')
  })
})

describe('field chrome (#267)', () => {
  const routeDir = path.dirname(fileURLToPath(import.meta.url))
  const rules = [
    ...cssRules(readFileSync(path.resolve(routeDir, '../styles/index.css'), 'utf8')),
    ...cssRules(readFileSync(path.resolve(routeDir, 'new-task.css'), 'utf8')),
  ]
  const declared = (subject: string, props: readonly string[]) =>
    rules.filter((rule) => targets(rule.selector, subject)).flatMap((rule) =>
      props.flatMap((prop) => (prop in rule.declarations ? [`${rule.selector} { ${prop}: ${rule.declarations[prop]} }`] : [])))
  const borderless = /^(?:0(?:px)?|none|transparent)(?: |$)/

  it('keeps the prompt editor a bordered card, not a full-bleed strip, on mobile', () => {
    expect(declared('.new-task-editor', ['border', 'border-width', 'border-style', 'border-color', 'border-radius', 'background', 'background-color'])
      .filter((rule) => borderless.test(rule.slice(rule.indexOf(': ') + 2)))).toEqual([])
    const mobile = rules.find((rule) => rule.selector === '.new-task-editor' && rule.at.includes('@media (max-width: 767px)'))
    expect(mobile?.declarations.padding).toBe('12px')
  })

  it('keeps the model pill bordered and its field label visible on mobile', () => {
    expect([...declared("[data-slot='model-pill']", ['border', 'border-width', 'border-style', 'border-color']), ...declared("[data-slot$='pill']", ['border', 'border-width', 'border-style', 'border-color'])]
      .filter((rule) => borderless.test(rule.slice(rule.indexOf(': ') + 2)))).toEqual([])
    expect(declared("[data-slot='picker-label']", ['display', 'visibility'])).toEqual([])
    // the all-breakpoint pill geometry the mobile rules must not override away
    const pill = rules.find((rule) => rule.selector === "[data-route='new'] .new-task-agent-options [data-slot$='pill']" && rule.at.length === 0)
    expect(pill?.declarations).toMatchObject({ 'border-color': 'var(--border)', 'border-radius': '9px', 'min-height': '44px' })
  })

  it('does not paint a Runner ::before on agent-option pills (#272)', () => {
    expect(rules.filter((rule) => paintsBefore(rule.selector, "pill']")).map((rule) => rule.selector)).toEqual([])
  })
})
