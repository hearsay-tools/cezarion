import { ISSUE_142, ISSUE_139, PROVIDERS_MULTI, PROVIDERS_NONE, jsonResponse, stubFetch, rows, promptField, promptValue, BASE, openDetail, health, MULTI_BACKEND, SINGLE_BACKEND, pickPill, postedRun, waitForAgentRunEnabled, cascadeCss, selectSkill } from './github.testkit'

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderStatusResponse, Runner, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { resetToasts } from '@/components/ui/toaster'

import { githubTaskRef } from '@/lib/github-task'

import { ListViewportResizeObserver } from './github-geometry.testkit'
import { cssRules, targets } from '@/test/css-rules'
import { readFollowupPrompt, readFollowupSelection, writeFollowupSelection } from './hand-to-agent-draft'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // Radix popovers position with floating-ui, which needs a ResizeObserver; jsdom has none. The
  // list's scroll owner gets a tall viewport so the virtualized rows mount (hearsay-tools/cezarion#1183).
  vi.stubGlobal('ResizeObserver', ListViewportResizeObserver)
  // The open-mercato/cezar#408 follow-up persistence (remembered selection + per-item draft) is localStorage-
  // backed and jsdom's localStorage survives across tests in this file — start every test clean.
  localStorage.clear()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('GitHub handoff field chrome (#243)', () => {
  const rel = path.join('src', 'routes', 'github', 'github-layout.css')
  const cssPath = [
    path.join(process.cwd(), 'packages', 'web', rel),
    path.join(process.cwd(), rel),
  ].find((file) => existsSync(file))
  if (!cssPath) throw new Error(`github-layout.css not found from ${process.cwd()}`)
  const css = readFileSync(cssPath, 'utf8')
  const rules = cssRules(css)

  it('styles row dividers and the phone preview on the row item, which survives virtualization (hearsay-tools/cezarion#1183)', () => {
    expect(css).toMatch(/\[data-slot='gh-row-item'\]\[data-divided\]\s*\{\s*border-block-start:/)
    expect(css).toMatch(/\[data-mobile-preview\] \[data-slot='gh-row-item'\]\[data-compact-hidden\]\s*\{\s*display:\s*none/)
    expect(rules.map((rule) => rule.selector).filter((selector) => selector.includes("[data-slot='gh-rows'] > li"))).toEqual([])
  })

  it('keeps phone filters wrapping instead of stacking a column that hides the first row (#325)', () => {
    const stacked = rules.filter((rule) =>
      (targets(rule.selector, "[data-slot='gh-issue-filters']") || targets(rule.selector, "[data-slot='gh-filter-toolbar']"))
      && /column/.test(`${rule.declarations['flex-direction'] ?? ''} ${rule.declarations['flex-flow'] ?? ''}`))
    expect(stacked.map((rule) => rule.selector)).toEqual([])
  })

  it('keeps the Workflow trigger in the shared field grammar — no workflow-only overrides (#262)', () => {
    // The trigger markup already mirrors Skills; any rule naming it is a rewrite of that
    // geometry (icon hidden, chevron moved left), which is what #262 came to remove.
    expect(css).not.toMatch(/gh-workflow-trigger/)
    const field = cascadeCss(css, ['.gh-field > button, .gh-field > select'])
    expect(field['min-height']).toBe('44px')
    expect(field.width).toBe('100%')
  })

  it('gives the Account pill the full-width field the other pickers get (#262)', () => {
    const pill = cascadeCss(css, [".gh-field [data-slot='account-pill']"])
    expect(pill.width).toBe('100%')
  })

  it('lays the Runner · Model · Effort pills out in the shared engine row, not a GitHub-only grid (#724)', () => {
    expect(css).not.toMatch(/gh-engine-fields|gh-fixed-runner/)
    const rowCss = readFileSync(path.join(path.dirname(cssPath), '..', '..', 'components', 'engine-row.css'), 'utf8')
    const pill = cascadeCss(rowCss, [".engine-row [data-slot$='pill']"])
    expect(pill['border-color']).toBe('var(--border)')
    expect(pill['min-height']).toBe('44px')
    expect(pill.width).toBe('100%')
    // Wide default is the one-row grid; the narrow rules live in the container query below it.
    expect(rowCss).toMatch(/^\.engine-row \{[^}]*grid-template-columns: max-content minmax\(0, 1fr\) max-content;/m)
    expect(rowCss).toMatch(/@container engine-row \(max-width: 549\.99px\)/)
  })

  it('does not paint in-button Model/Runner/Effort ::before labels — PickerPill fieldLabel owns the name (#272)', () => {
    const painted = rules.filter((rule) => /pill'\]::before/.test(rule.selector) && (rule.declarations.content ?? 'none') !== 'none')
    expect(painted.map((rule) => rule.selector)).toEqual([])
  })

  it('gives the prompt textarea its own bordered typing area', () => {
    const prompt = cascadeCss(css, [
      "[data-slot='gh-custom-prompt']",
      ".gh-prompt-field [data-slot='gh-custom-prompt']",
    ])
    expect(prompt.border).toBe('1px solid var(--border)')
    expect(prompt.background).toBe('var(--card)')
    expect(Number.parseInt(prompt['min-height'] ?? '0', 10)).toBeGreaterThanOrEqual(44)
  })
})

describe('the hand-to-agent backend pills (#401)', () => {
  it('a single-backend host hides the runner pill but still offers the model', async () => {
    // A real one-check health response — the default stub 404s /api/v1/health, which exercises
    // the no-data fallback instead and would pass for the wrong reason.
    stubFetch({ 'GET /api/v1/health': SINGLE_BACKEND })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="model-pill"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
  })

  it('an untouched cold-load panel posts the connected runner and no model', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ workflow: 'quick-task' })
    expect((postedRun(sent) as { runner?: string | undefined }).runner).toBe('claude')
    expect((postedRun(sent) as { model?: string | undefined }).model).toBeUndefined()
  })

  it('sends the connected runner explicitly when provider status resolves before health', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => new Promise<Response>(() => {}),
    })
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'claude' })
  })

  it('a runner + model pick rides the POST alongside the workflow routing', async () => {
    const sent = stubFetch({
      // Health describes the boot project; config describes the scoped GitHub project.
      'GET /api/v1/health': () => jsonResponse({ ...health(['claude', 'codex']), defaultRunner: 'codex' }),
      'GET /api/v1/config': () => jsonResponse({ defaultRunner: 'claude', defaultModels: {} }),
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_MULTI),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await pickPill('runner-pill', 'codex')
    await pickPill('model-pill', 'gpt-future')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({
      workflow: 'quick-task',
      runner: 'codex',
      model: 'gpt-future',
    })
  })

  it('switching backend resets the model pick — the presets are per runner', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': MULTI_BACKEND,
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_MULTI),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    // Pin a claude model, then move to codex: the claude id must not survive onto codex.
    await pickPill('model-pill', 'opus')
    await pickPill('runner-pill', 'codex')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex' })
    // Back to auto for the new runner, so no model at all.
    expect((postedRun(sent) as { model?: string | undefined }).model).toBeUndefined()
  })

  it('the pick survives switching to another issue (it is a way of working, not a property of one item)', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': MULTI_BACKEND,
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_MULTI),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await pickPill('runner-pill', 'codex')

    // Hop to the other issue — HandToAgent remounts (key={item.url}), the pick must not.
    fireEvent.click(rows().find((row) => row.dataset.number === '139')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-hand"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="runner-pill"]')?.textContent).toContain('codex')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex' })
  })

  it('disables click and shortcut starts with no connected provider while browsing and editing stay live', async () => {
    const sent = stubFetch({
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_NONE),
    })
    await openDetail('/p/acme/github/issues/142')

    const run = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    await waitFor(() => expect(run.disabled).toBe(true))
    expect(
      document.querySelector<HTMLButtonElement>('[data-slot="model-pill"]')?.disabled,
    ).toBe(true)
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/p/acme/settings/agents#providers',
    )

    fireEvent.change(promptField(), { target: { value: 'Keep this editable.' } })
    expect(promptValue()).toBe('Keep this editable.')
    fireEvent.click(rows().find((row) => row.dataset.number === '139')!)
    await waitFor(() => expect(promptField().value).toContain('#139'))

    // Force both entry points past their visual disabled state; neither may reach createRun.
    const currentRun = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    currentRun.removeAttribute('disabled')
    fireEvent.click(currentRun)
    fireEvent.keyDown(promptField(), { key: 'Enter', ctrlKey: true })
    await act(() => Promise.resolve())
    expect(postedRun(sent)).toBeUndefined()
  })

  it('describes provider route failure as failed verification and keeps setup available', async () => {
    stubFetch({
      'GET /api/v1/providers/status': () =>
        jsonResponse({ error: 'provider probe failed' }, 404),
    })
    await openDetail()

    expect(await screen.findByText('Provider authentication could not be verified.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('No agent provider is connected')
    expect(screen.getByRole('link', { name: 'Configure providers' })).toBeTruthy()
  })

  it('explicitly sends a connected fallback that differs from the server default', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => jsonResponse(health(['claude'])),
      'GET /api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        } satisfies ProviderStatusResponse),
    })
    await openDetail()

    const run = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    await waitFor(() => expect(run.disabled).toBe(false))
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    fireEvent.click(run)

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex', workflow: 'quick-task' })
  })

  it('excludes a connected disabled default runner and sends the enabled fallback', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => jsonResponse(health(['claude', 'codex'])),
      'GET /api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'connected', enabled: false },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        } satisfies ProviderStatusResponse),
    })
    await openDetail()

    const run = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    await waitFor(() => expect(run.disabled).toBe(false))
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    fireEvent.click(run)

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex', workflow: 'quick-task' })
  })
})

describe('the hand-to-agent agent account', () => {
  const agentProfiles = (profiles: unknown[], selections: unknown = {}) => () =>
    jsonResponse({
      editable: true,
      profiles,
      profileCapableProviders: ['claude', 'codex'],
      selections,
      defaults: {},
    })

  const login = (provider: Runner, id: string, label: string) => ({
    id,
    provider,
    label,
    configDir: `~/.${provider}-${id}`,
    path: `/home/u/.${provider}-${id}`,
    exists: true,
    looksValid: true,
    isDefault: id === 'default',
  })

  const TWO_CLAUDE_LOGINS = [
    login('claude', 'default', 'Default'),
    login('claude', 'klaudiusz', 'Klaudiusz'),
  ]

  it('lists a runner’s logins as rows once there is more than one', async () => {
    stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS),
    })
    await openDetail()

    // One runner would normally hide the pill — a second LOGIN is a choice too, so it shows.
    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    fireEvent.pointerDown(document.querySelector('[data-slot="runner-pill"]')!)

    const menu = await screen.findByTestId('runner-pill-menu')
    await waitFor(() =>
      expect(
        within(menu).getAllByRole('menuitemradio').map((o) => o.textContent),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('claude · Default'),
          expect.stringContaining('claude · Klaudiusz'),
        ]),
      ),
    )
  })

  it('offers the account as the panel pill, not a bare native select (#262)', async () => {
    stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="account-pill"]')).not.toBeNull())
    const pill = document.querySelector('[data-slot="account-pill"]')!
    expect(pill.tagName).toBe('BUTTON')
    // The hand-off panel keeps no native select: every field shares the pill chrome.
    expect(document.querySelector('[data-slot="gh-hand"] select')).toBeNull()

    fireEvent.pointerDown(pill)
    const menu = await screen.findByTestId('account-pill-menu')
    await waitFor(() =>
      expect(
        within(menu).getAllByRole('menuitemradio').map((o) => o.textContent),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Default'),
          expect.stringContaining('Klaudiusz'),
        ]),
      ),
    )
  })

  it('the Account pill disables with the pills while a run starts (#262)', async () => {
    stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS),
      'POST /api/v1/runs': () => new Promise<Response>(() => {}),
    })
    await openDetail()
    await waitForAgentRunEnabled()

    const pill = () => document.querySelector<HTMLButtonElement>('[data-slot="account-pill"]')!
    expect(pill().disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(pill().disabled).toBe(true))
  })

  it('posts the picked account as agentProfile', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await pickPill('account-pill', 'Klaudiusz')
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ workflow: 'quick-task', agentProfile: 'klaudiusz' })
  })

  /**
   * `'default'` is the discovered account named EXPLICITLY, which beats the project's selection
   * server-side — so it must ride the request, unlike an untouched pill. The project here selects
   * `klaudiusz`; picking the Default row is a real override and has to be sent to undo it.
   */
  it('sends the discovered account explicitly when it is picked over the project’s selection', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/repo': () => jsonResponse({ info: { root: '/repo' } }),
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS, {
        '/repo': { claude: 'klaudiusz' },
      }),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    // The project's row is the selected one until overridden.
    expect(document.querySelector('[data-slot="runner-pill"]')?.textContent).toContain('Klaudiusz')
    await pickPill('runner-pill', 'claude · Default')
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ agentProfile: 'default' })
  })

  it('an untouched pill posts no agentProfile — the run follows the project’s selection', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/repo': () => jsonResponse({ info: { root: '/repo' } }),
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS, {
        '/repo': { claude: 'klaudiusz' },
      }),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await waitForAgentRunEnabled()
    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    // The KEY, not merely its value: an absent field is what "follow the selection" means.
    expect('agentProfile' in (postedRun(sent) as object)).toBe(false)
  })

  /** Switching the AGENT must not carry the previous agent's login along — that would bill the
   *  wrong subscription. The model pin goes with it; the account does too. */
  it('drops the account when the agent changes', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': MULTI_BACKEND,
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_MULTI),
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await pickPill('runner-pill', 'claude · Klaudiusz')
    await pickPill('runner-pill', 'codex')
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex' })
    expect('agentProfile' in (postedRun(sent) as object)).toBe(false)
  })

  /** Changing only the ACCOUNT keeps the model pin: the catalog is identical across logins of
   *  the same runner, so there is nothing for a switch to invalidate. */
  it('keeps the model pin when only the account changes', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/workspace/agent-profiles': agentProfiles(TWO_CLAUDE_LOGINS),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await pickPill('model-pill', 'opus')
    await pickPill('runner-pill', 'claude · Klaudiusz')
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ model: 'opus', agentProfile: 'klaudiusz' })
  })

  /**
   * The zero-config guard, and the one that passes both before and after this change: one runner
   * with one login must see no pill and send byte-for-byte the request it always sent.
   */
  it('a host with one runner and one login is unchanged — no pill, no agentProfile', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': SINGLE_BACKEND,
      'GET /api/v1/workspace/agent-profiles': agentProfiles([login('claude', 'default', 'Default')]),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="model-pill"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()

    await waitForAgentRunEnabled()
    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect('agentProfile' in (postedRun(sent) as object)).toBe(false)
  })
})

describe('the hand-to-agent pickers (#385)', () => {
  it('the workflow trigger carries the Skills grammar — icon, value, right-side chevron (#262)', async () => {
    stubFetch()
    await openDetail()

    const workflow = document.querySelector('[data-slot="gh-workflow-trigger"]')!
    const skills = document.querySelector('[data-slot="gh-skills-trigger"]')!
    // Nothing is selected on either trigger, so the chrome classes must be identical —
    // the CSS may not rewrite one trigger's geometry away from the other's.
    expect(workflow.className).toBe(skills.className)
    const children = Array.from(workflow.children)
    expect(children[0]?.tagName).toBe('svg')
    expect(children[children.length - 1]?.tagName).toBe('svg')
    // The value sits between the icons and reads as a placeholder while empty.
    const span = children[1]
    expect(span?.tagName).toBe('SPAN')
    expect(span?.textContent).toBe('workflow')
  })

  it('the workflow dropdown lists, filters, selects — and re-selecting deselects', async () => {
    stubFetch()
    await openDetail()

    const trigger = document.querySelector('[data-slot="gh-workflow-trigger"]')!
    const touch = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    fireEvent(trigger, touch)
    fireEvent.click(trigger)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-workflow-option"]')).toHaveLength(2),
    )

    const search = screen.getByPlaceholderText('search workflows…')
    expect(document.activeElement).toBe(search.closest('[data-slot="popover-content"]'))

    // cmdk filtering: a query narrows the list.
    fireEvent.change(screen.getByPlaceholderText('search workflows…'), { target: { value: 'ship' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-workflow-option"]')).toHaveLength(1),
    )

    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).toContain('ship-it'),
    )

    // Click the selected workflow again → deselected (legacy chip parity).
    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).not.toContain('ship-it'),
    )
  })

  it('the skills dropdown is project-first with bold project rows (#377), and keeps selection visible as chips', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    // Server order was global-first; the menu reorders project skills first, emphasized.
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-option"]')]
    expect(options.map((option) => option.dataset.skill)).toEqual(['om-fix', 'team-x', 'g-review'])
    expect(options[0]?.querySelector('.font-semibold')).not.toBeNull()
    expect(options[1]?.querySelector('.font-semibold')).not.toBeNull()
    expect(options[2]?.querySelector('.font-semibold')).toBeNull()

    // Multi-select: toggling keeps the menu open; the chip row mirrors the selection.
    fireEvent.click(options[0]!)
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)
    await waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-chip"]')].map(
          (chip) => chip.dataset.skill,
        ),
      ).toEqual(['om-fix', 'g-review']),
    )
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).toContain('· 2')

    // The filter narrows the list but can never hide the selection — the chips live outside.
    fireEvent.change(screen.getByPlaceholderText('search skills…'), { target: { value: 'team' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(1),
    )
    expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(2)

    // A chip's × deselects without the dropdown.
    fireEvent.click(document.querySelector('[data-slot="gh-skill-chip"][data-skill="om-fix"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(1),
    )
  })

  it('the eye opens the read-only skill preview (shared detail component) without toggling the row', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    fireEvent.click(
      document.querySelector('[data-slot="gh-skill-option"][data-skill="om-fix"] [data-slot="gh-skill-view"]')!,
    )
    // The Settings catalog's detail component, as a dialog — name, source tag, path.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="skill-preview"] [data-slot="skill-detail"]')).not.toBeNull(),
    )
    const preview = document.querySelector('[data-slot="skill-preview"]')!
    expect(preview.textContent).toContain('om-fix')
    expect(preview.textContent).toContain('project fixer')
    expect(preview.querySelector('[data-slot="skill-path"]')?.textContent).toContain('/p/om-fix.md')
    // Viewing is read-only: nothing got selected (no chip, no count on the trigger).
    expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(0)
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).not.toContain('·')
    // The escape hatch into the browsable Skills catalog.
    expect(
      preview.querySelector('[data-slot="skill-preview-manage"]')?.getAttribute('href'),
    ).toBe('/skills?skill=om-fix')
  })

  it('multi-keyword search: "fix project" narrows the skills list to matches (#411)', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    // "fix project" should match om-fix (name splits "om","fix" + description "project fixer")
    fireEvent.change(screen.getByPlaceholderText('search skills…'), { target: { value: 'fix project' } })
    await waitFor(() => {
      const visible = [...document.querySelectorAll('[data-slot="gh-skill-option"]')]
      expect(visible).toHaveLength(1)
      expect(visible[0]?.getAttribute('data-skill')).toBe('om-fix')
    })
  })
})

describe('the hand-to-agent run (legacy three-way body)', () => {
  it('nothing selected → quick-task, and the queued affordance links the new run', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
    expect(posted?.body).toMatchObject({ workflow: 'quick-task' })
    expect((posted!.body as { task: string }).task).toContain('Fix GitHub issue #142')
    expect((posted!.body as { task: string }).task).toContain(ISSUE_142.url)

    expect(document.querySelector('[data-slot="gh-view-run"]')?.getAttribute('href')).toBe('/tasks/run-1')
    // The list row grows the queued flag.
    expect(document.querySelector('[data-slot="gh-queued-flag"]')).not.toBeNull()
  })

  it('confirms the hand-off with a toast — the inline affordance is off-screen on a phone', async () => {
    stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(screen.getByText('Added to the queue — issue #142')).toBeTruthy())
    expect(document.querySelector('[data-slot="toast"]')?.getAttribute('data-tone')).toBe('default')
  })

  it('a custom prompt is handed over WITH the item reference, not instead of it (#524)', async () => {
    const sent = stubFetch()
    await openDetail()

    // The exact prompt from the bug report: it names no number and no URL of its own.
    fireEvent.change(promptField(), {
      target: { value: 'Port this one to develop and close original PR' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
    const { task } = posted!.body as { task: string }
    expect(task).toContain('Port this one to develop and close original PR')
    expect(task).toContain('#142')
    expect(task).toContain(ISSUE_142.url)
  })

  it('a selected workflow rides the POST, with toggled skills as a prompt hint', async () => {
    const sent = stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)

    await selectSkill('om-fix')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
    expect(posted?.body).toMatchObject({ workflow: 'ship-it' })
    expect((posted!.body as { task: string }).task).toContain('Use these skills where relevant: om-fix.')
  })

  it('skills without a workflow become the steps chain (spec 008)', async () => {
    const sent = stubFetch()
    await openDetail()

    await selectSkill('om-fix')
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    const body = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
      ?.body as { workflow?: string | undefined; steps?: Array<{ id: string; skill: string; prompt: string }> }
    expect(body.workflow).toBeUndefined()
    expect(body.steps).toEqual([
      { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
      { id: 'g-review', name: 'g-review', skill: 'g-review', prompt: '{{task}}' },
    ])
  })

  it('a server refusal surfaces as a danger toast and no queued flag', async () => {
    stubFetch({
      'POST /api/v1/runs': () => jsonResponse({ error: 'a task is already running' }, 409),
    })
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(screen.getByText('a task is already running')).toBeTruthy())
    expect(document.querySelector('[data-slot="gh-queued"]')).toBeNull()
  })
})

describe('the skills dropdown frequency sort (open-mercato/cezar#408 item 1, re-tiered by #519)', () => {
  it('promotes used skills into "Most used" ahead of locality, frequency descending', async () => {
    stubFetch({
      'GET /api/v1/ui-state': () => jsonResponse({ skillUsage: { 'team-x': 9, 'g-review': 1 } }),
    })
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-option"]')]
    // Most used leads (#519): team-x (9 picks) then g-review (1 pick), BOTH above the unused
    // project skill om-fix — usage now outranks locality instead of only reordering within it.
    expect(options.map((option) => option.dataset.skill)).toEqual(['team-x', 'g-review', 'om-fix'])
  })

  it('no usage stats at all falls back to the plain project-first order (#2)', async () => {
    stubFetch() // the default GET /api/v1/ui-state answers {}
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-option"]')]
    expect(options.map((option) => option.dataset.skill)).toEqual(['om-fix', 'team-x', 'g-review'])
  })

  it('a successful hand-off run bumps skillUsage for every selected skill', async () => {
    const sent = stubFetch({
      'GET /api/v1/ui-state': () => jsonResponse({ skillUsage: { 'om-fix': 2 } }),
    })
    await openDetail()

    await selectSkill('om-fix')
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
        true,
      ),
    )
    const put = sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')
    expect(put?.body).toMatchObject({ skillUsage: { 'om-fix': 3, 'g-review': 1 } })
  })

  it('a run started while ui-state is unavailable skips the bump rather than wiping the map', async () => {
    // The PUT merge is shallow, so a bump computed off an unresolved/errored ui-state query
    // would send a ONE-ENTRY map and replace every count the user has accumulated. The bump is
    // a convenience; the stored history is not — so the bump is what gives way.
    const sent = stubFetch({
      // 404, not a 5xx: the query client never retries a 4xx (query-client.ts), so the query
      // lands in its errored state immediately and the test stays deterministic.
      'GET /api/v1/ui-state': () => jsonResponse({ error: 'nope' }, 404),
    })
    await openDetail()

    await selectSkill('om-fix')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    // The run itself still goes through — persistence is fire-and-forget.
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
      false,
    )
  })

  it('picking a workflow only (no skills) never touches skillUsage', async () => {
    const sent = stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
      false,
    )
  })
})

describe('the remembered last selection (open-mercato/cezar#408 item 3)', () => {
  it('a repeat hand-off pre-selects the previous workflow + skills on a fresh mount', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)

    await selectSkill('om-fix')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(1),
    )

    // Simulate a full page reload: unmount everything and mount fresh — only localStorage (not
    // React state) can carry the pick across this boundary.
    cleanup()
    stubFetch()
    await openDetail()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).toContain(
        'ship-it',
      ),
    )
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-chip"]')].map(
        (chip) => chip.dataset.skill,
      ),
    ).toEqual(['om-fix'])
  })
})

describe('a remembered pick the catalog no longer has (open-mercato/cezar#408)', () => {
  const WITHOUT_SHIP_IT: WorkflowsResponse = {
    workflows: [{ name: 'quick-task', description: 'one step', steps: [], source: 'built-in' }],
    issues: [],
  }

  it('a workflow deleted since it was remembered is dropped from the trigger, the POST and storage', async () => {
    writeFollowupSelection({ workflow: 'ship-it', skills: [] })
    const sent = stubFetch({ 'GET /api/v1/workflows': () => jsonResponse(WITHOUT_SHIP_IT) })
    await openDetail()

    const trigger = () => document.querySelector('[data-slot="gh-workflow-trigger"]')
    await waitFor(() => expect(trigger()?.textContent).not.toContain('ship-it'))
    expect(trigger()?.textContent).toContain('workflow') // back to the unselected placeholder

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())
    // The run falls back to quick-task instead of 404-ing on a workflow that is gone.
    expect(sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body)
      .toMatchObject({ workflow: 'quick-task' })
    // Dropped from storage too — otherwise the next reload restores it right back.
    expect(readFollowupSelection().workflow).toBeNull()
  })

  it('a remembered workflow that still exists survives — the guard only drops the unknown', async () => {
    writeFollowupSelection({ workflow: 'ship-it', skills: [] })
    const sent = stubFetch()
    await openDetail()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).toContain('ship-it'),
    )
    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    expect(sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body)
      .toMatchObject({ workflow: 'ship-it' })
  })

  it('a deleted skill is dropped from the chips, the counter AND the POST — never shown but unsent', async () => {
    writeFollowupSelection({ workflow: null, skills: ['om-fix', 'deleted-skill'] })
    const sent = stubFetch()
    await openDetail()

    await waitFor(() => expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(1))
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-chip"]')].map((chip) => chip.dataset.skill),
    ).toEqual(['om-fix'])
    // The counter must agree with the chips and the POST — not report the phantom.
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).toContain('· 1')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    const body = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body as {
      steps?: Array<{ skill: string }>
    }
    expect(body.steps?.map((step) => step.skill)).toEqual(['om-fix'])
  })
})

describe('the follow-up prompt draft (open-mercato/cezar#408 item 4)', () => {
  it('typed instructions persist when navigating away and back to the same item', async () => {
    stubFetch()
    await openDetail()

    fireEvent.change(promptField(), { target: { value: 'Also add a test.' } })
    await waitFor(() => expect(promptValue()).toBe('Also add a test.'))

    // Switch to a different item — HandToAgent remounts (key={item.url}); its OWN draft is empty.
    fireEvent.click(document.querySelector('[data-slot="gh-row"][data-number="139"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-detail-inner"]')?.textContent).toContain(
        'Add --json flag',
      ),
    )
    // Untouched means its OWN pre-filled reference (#524), never issue 142's text.
    expect(promptValue()).toBe(githubTaskRef(ISSUE_139))

    // Switch back — the first item's draft is restored.
    fireEvent.click(document.querySelector('[data-slot="gh-row"][data-number="142"]')!)
    await waitFor(() => expect(promptValue()).toBe('Also add a test.'))
  })

  it('an untouched box stores no draft — the pre-fill leaves no trace (#524)', async () => {
    stubFetch()
    await openDetail()

    await waitFor(() => expect(promptValue()).toBe(BASE))
    expect(readFollowupPrompt(ISSUE_142.url)).toBe('')
  })

  it('a page reload restores the draft too (localStorage, not just component state)', async () => {
    stubFetch()
    await openDetail()
    fireEvent.change(promptField(), { target: { value: 'do not lose me' } })
    await waitFor(() => expect(promptValue()).toBe('do not lose me'))

    cleanup()
    stubFetch()
    await openDetail()
    await waitFor(() => expect(promptValue()).toBe('do not lose me'))
  })

  it('a successful run spends that item’s draft', async () => {
    stubFetch()
    await openDetail()
    fireEvent.change(promptField(), { target: { value: 'spend me' } })
    await waitFor(() => expect(promptValue()).toBe('spend me'))

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    cleanup()
    stubFetch()
    await openDetail()
    // Spent → back to the untouched pre-fill, not to an empty box.
    expect(promptValue()).toBe(BASE)
  })

  it('spending the draft clears the textarea THERE AND THEN, not only on the next mount', async () => {
    stubFetch()
    await openDetail()
    fireEvent.change(promptField(), { target: { value: 'spend me' } })
    await waitFor(() => expect(promptValue()).toBe('spend me'))

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    // Storage and UI must agree without a remount: leaving the text on screen while the entry is
    // gone from storage means it silently vanishes the next time you come back.
    await waitFor(() => expect(promptValue()).toBe(BASE))
    expect(readFollowupPrompt(ISSUE_142.url)).toBe('')
  })
})

describe('⌘/Ctrl+Enter submits the follow-up composer (open-mercato/cezar#408 item 5)', () => {
  it('Ctrl+Enter runs the agent', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.change(textarea, { target: { value: 'go' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
        true,
      ),
    )
  })

  it('⌘+Enter (metaKey) also runs the agent', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
        true,
      ),
    )
  })

  it('a bare Enter does NOT submit — it is a multi-line instructions box', async () => {
    const sent = stubFetch()
    await openDetail()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // Give any (wrongly) scheduled submit a tick to happen before asserting its absence.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
      false,
    )
  })

  it('Shift+Ctrl+Enter does not submit — Shift wins, same rule as the thread composer', async () => {
    const sent = stubFetch()
    await openDetail()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, shiftKey: true })

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
      false,
    )
  })
})

