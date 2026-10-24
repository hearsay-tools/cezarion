import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RunActivityDock, resetActivityDisclosureForTests } from './run-activity-dock'
import { resolveConflictsPrompt } from './run-actions'
import { reduceThread } from './thread-state'

/**
 * What the run header's metadata row, agent badge and details disclosure used to answer, now
 * answered by the Session activity card's Workflow, Usage & agent and Workspace rows
 * (hearsay-tools/cezarion#1333). The behaviors are the ones the header pinned — branch copy (#434),
 * tracker chips (#617, #692, #847, #922), automation provenance (#801), metrics, and which agent,
 * account and model ran (#52, #251, #411, #416, #546) — read from their new home.
 */

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  resetActivityDisclosureForTests()
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

/** Disclosure memory is keyed by run id, so a test that toggles rows gets its own run. */
let seq = 0
const freshId = () => `session-details-${++seq}`

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).replace('?archived=recent', '')
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[path]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/run-summaries') return jsonResponse([])
      return jsonResponse({})
    }),
  )
  return sent
}

function renderCard(record: ApiRun) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<RunActivityDock run={record} currentThread={reduceThread([])} />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const row = (key: string) => document.querySelector<HTMLElement>(`[data-slot="run-activity-${key}"]`)
/** Opens the card, then the named row; both are no-ops when memory already holds them open. */
/** The card starts folded on every viewport (hearsay-tools/cezarion#1601). */
function openCard(): void {
  const summary = screen.getByRole('button', { name: /^Session activity/ })
  if (summary.getAttribute('aria-expanded') !== 'true') fireEvent.click(summary)
}
function openRow(key: 'workflow' | 'usage' | 'workspace'): HTMLElement {
  openCard()
  const head = row(key)!.querySelector<HTMLButtonElement>(':scope > button')!
  if (head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
  return row(key)!
}
const metaOf = (key: string) => row(key)?.querySelector('[data-slot="run-activity-meta"]')?.textContent ?? ''

describe('Workspace — branch copy (#434)', () => {
  it('waits for the clipboard write before claiming success', async () => {
    stubFetch()
    let finishWrite!: () => void
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderCard(run('done', { id: freshId(), branch: 'cez/feature-434' }))
    openRow('workspace')
    fireEvent.click(screen.getByRole('button', { name: 'Copy branch name' }))
    expect(screen.queryByRole('button', { name: 'Copied branch name' })).toBeNull()
    await act(async () => { finishWrite() })
    expect(screen.getByRole('button', { name: 'Copied branch name' })).not.toBeNull()
  })

  it('copies the exact branch and resets the success confirmation after two seconds', async () => {
    stubFetch()
    vi.useFakeTimers()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    try {
      renderCard(run('done', { id: freshId(), branch: 'cez/feature-434' }))
      openRow('workspace')
      const copy = screen.getByRole('button', { name: 'Copy branch name' })
      await act(async () => { fireEvent.click(copy) })
      expect(writeText).toHaveBeenCalledWith('cez/feature-434')
      expect(screen.getByRole('button', { name: 'Copied branch name' })).toBe(copy)
      act(() => { vi.advanceTimersByTime(1999) })
      expect(screen.getByRole('button', { name: 'Copied branch name' })).toBe(copy)
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('button', { name: 'Copy branch name' })).toBe(copy)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a native focusable copy button', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), branch: 'cez/feature-434' }))
    const copy = within(openRow('workspace')).getByRole('button', { name: 'Copy branch name' })
    expect(copy.tagName).toBe('BUTTON')
    expect(copy.getAttribute('type')).toBe('button')
    copy.focus()
    expect(document.activeElement).toBe(copy)
  })

  it.each(['missing', 'denied'] as const)('shows the branch for manual copying when clipboard is %s', async (failure) => {
    stubFetch()
    vi.stubGlobal('navigator', failure === 'missing'
      ? { ...navigator, clipboard: undefined }
      : { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    renderCard(run('done', { id: freshId(), branch: 'cez/feature-434' }))
    openRow('workspace')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy branch name' })) })
    expect(screen.getByRole('status').textContent).toContain('cez/feature-434')
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('default')
    expect(screen.getByRole('button', { name: 'Copy branch name' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Copied branch name' })).toBeNull()
  })
})

describe('Workspace — tracker chips', () => {
  it.each([
    {
      name: 'both',
      refs: {
        referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534',
        referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/544',
      },
      pr: true,
      issue: true,
    },
    { name: 'PR only', refs: { referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534' }, pr: true, issue: false },
    { name: 'issue only', refs: { referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/544' }, pr: false, issue: true },
    { name: 'neither', refs: {}, pr: false, issue: false },
  ])('shows discovered tracker chips beside the branch ($name)', ({ refs, pr, issue }) => {
    stubFetch()
    renderCard(run('done', { id: freshId(), branch: 'cez/r1', ...refs }))
    const workspace = openRow('workspace')
    const prChip = workspace.querySelector('[data-slot="pr-chip"]')
    const issueChip = workspace.querySelector('[data-slot="issue-chip"]')
    expect(Boolean(prChip)).toBe(pr)
    expect(Boolean(issueChip)).toBe(issue)
    if (prChip) {
      expect(prChip.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/pull/534')
      expect(prChip.textContent).toContain('#534')
    }
    if (issueChip) {
      expect(issueChip.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/issues/544')
      expect(issueChip.textContent).toContain('Issue #544')
    }
  })

  // The conflict chip's one-click prompt, end to end: the forge says a PR will not merge, the
  // chip goes orange, and the panel it opens sends the agent the fix into this task's conversation.
  it('sends the resolve-conflicts prompt into this task’s own conversation', async () => {
    const sent = stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'acme' }),
      // #922: a URL-carrying chip only trusts the local status batch once the project's repo
      // base proves the PR is the project's own. The registry entry supplies that proof.
      '/api/v1/projects': () => jsonResponse({
        projects: [{ id: 'acme', name: 'acme', root: '/acme', addedAt: '2026-07-01T00:00:00Z', lastOpenedAt: '2026-07-01T00:00:00Z', source: 'local', status: 'ok', repoUrl: 'https://github.com/open-mercato/cezar' }],
      }),
      '/api/v1/p/acme/github/ref-status?prs=534': () =>
        jsonResponse({ available: true, prs: { 534: 'ready' }, issues: {}, conflicts: [534], recheckAfterMs: null }),
    })
    renderCard(run('running', {
      id: freshId(),
      branch: 'cez/r1',
      referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534',
    }))
    openRow('workspace')

    const chip = await waitFor(() => {
      const found = document.querySelector('[data-slot="pr-chip"][data-conflicting="true"]')
      if (!found) throw new Error('the chip has not learned about the conflict yet')
      return found as HTMLElement
    })
    fireEvent.focus(chip)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Resolve conflicts' })))

    const message = await waitFor(() => {
      const found = sent.find((request) => request.method === 'POST' && request.path.endsWith('/messages'))
      if (!found) throw new Error('nothing was sent')
      return found
    })
    expect(message.body).toMatchObject({ text: resolveConflictsPrompt(534) })
  })

  // #617 01b: on touch the sidebar's references are plain text and the whole row is the tap
  // target, which only holds because the task page carries them as real 44px links.
  it('gives its tracker chips a 44px target on a device that cannot hover', () => {
    stubFetch()
    renderCard(run('done', {
      id: freshId(),
      branch: 'cez/r1',
      pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534',
      referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/544',
    }))
    const chips = [...openRow('workspace').querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')]
    expect(chips).toHaveLength(2)
    for (const chip of chips) {
      expect(chip.className, chip.textContent ?? '').toContain('no-hover:min-h-[44px]')
      expect(chip.className, chip.textContent ?? '').toContain('no-hover:min-w-[44px]')
    }
  })

  it('shows every PR the task points at, not only the strongest one', () => {
    stubFetch()
    renderCard(run('done', {
      id: freshId(),
      branch: 'cez/r1',
      pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/5366',
      referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/4326',
      markerRefs: { pr: 5366 },
    }))
    const chips = [...openRow('workspace').querySelectorAll('[data-slot="pr-chip"]')]
    expect(chips.map((chip) => chip.getAttribute('href'))).toEqual([
      'https://github.com/open-mercato/cezar/pull/5366',
      'https://github.com/open-mercato/cezar/pull/4326',
    ])
  })

  // The registry knows every project's own repo, so a number-only chip is a real link here just
  // as it is on All tasks — the two pages must not disagree about the same reference.
  it('links a PR known only by number, using the project registry repo', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'boot-id', repo: {} }),
      '/api/v1/projects': () => jsonResponse({
        projects: [{ id: 'boot-id', name: 'cezar', root: '/home/me/cezar', repoUrl: 'https://github.com/open-mercato/cezar' }],
      }),
    })
    const id = freshId()
    renderCard(run('done', { id, branch: 'cez/r1', prNumber: 901, markerRefs: { pr: 901 } }))
    const workspace = openRow('workspace')
    await waitFor(() => {
      expect(workspace.querySelector('[data-slot="pr-chip"]')?.getAttribute('href')).toBe(`/p/boot-id/tasks/${id}/pr/901`)
    })
  })

  it('opens the item tab from an own-repo chip and keeps GitHub for a foreign one (#692)', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'boot-id', repo: {} }),
      '/api/v1/projects': () => jsonResponse({
        projects: [{ id: 'boot-id', name: 'cezar', root: '/home/me/cezar', repoUrl: 'https://github.com/open-mercato/cezar' }],
      }),
    })
    const id = freshId()
    renderCard(run('done', {
      id,
      branch: 'cez/r1',
      pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/801',
      referencedPullRequestUrl: 'https://github.com/someone/else/pull/5',
      referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/692',
    }))
    const workspace = openRow('workspace')
    await waitFor(() => {
      const hrefs = [...workspace.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')].map((chip) => chip.getAttribute('href'))
      expect(hrefs).toEqual([
        `/p/boot-id/tasks/${id}/pr/801`,
        'https://github.com/someone/else/pull/5',
        `/p/boot-id/tasks/${id}/issue/692`,
      ])
    })
    expect(workspace.querySelector('[data-slot="pr-chip"]')?.getAttribute('target')).toBeNull()
  })

  // #847: a forge whose PR URLs are not `…/pull/N` still gets its link beside a number-only chip.
  it('keeps a non-numeric PR link beside a chip known only by number', () => {
    stubFetch({ '/api/v1/health': () => jsonResponse({ repo: {} }) })
    renderCard(run('done', {
      id: freshId(),
      branch: 'cez/r1',
      pullRequestUrl: 'https://forge.example.com/o/r/merge_requests/spec-fix',
      prNumber: 42,
    }))
    const chips = [...openRow('workspace').querySelectorAll('[data-slot="pr-chip"]')]
    expect(chips).toHaveLength(2)
    expect(chips.map((chip) => chip.getAttribute('href'))).toContain('https://forge.example.com/o/r/merge_requests/spec-fix')
  })

  it('shows a PR known only by number, with no repository to link it to', () => {
    stubFetch({ '/api/v1/health': () => jsonResponse({ repo: {} }) })
    renderCard(run('done', {
      id: freshId(),
      branch: 'cez/r1',
      pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/5366',
      prNumber: 901,
    }))
    const chips = [...openRow('workspace').querySelectorAll('[data-slot="pr-chip"]')]
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('#5366'),
      expect.stringContaining('#901'),
    ])
    expect(chips[1]?.tagName).toBe('SPAN') // inert: nothing to link to
  })
})

describe('Workflow — automation provenance (#801)', () => {
  // Provenance is history, so the chip stays; it only LINKS while the capability is on.
  const automated = () => run('done', {
    id: freshId(),
    automation: {
      automationId: 'a-1',
      automationRevision: 1,
      receiptId: 'r-1',
      event: 'issue.opened',
      githubUrl: 'https://github.com/open-mercato/cezar/issues/801',
    },
  })
  const health = (automations: boolean) => () => jsonResponse({
    capabilities: {
      localHandoff: true, singleProject: false, automations,
      tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true,
    },
  })

  it('links the automation to its log while automations are on', async () => {
    stubFetch({ '/api/v1/health': health(true) })
    renderCard(automated())
    openRow('workflow')
    const link = await screen.findByRole('link', { name: 'Automation' })
    expect(link.getAttribute('href')).toBe('/automations/a-1/log')
  })

  it('degrades the automation to plain text while automations are off', async () => {
    stubFetch({ '/api/v1/health': health(false) })
    renderCard(automated())
    const workflow = openRow('workflow')
    await waitFor(() => expect(workflow.querySelector('[data-slot="automation-origin"]')).not.toBeNull())
    expect(workflow.textContent).toContain('Automation')
    expect(screen.queryByRole('link', { name: 'Automation' })).toBeNull()
  })
})

describe('Usage & agent — metrics', () => {
  it('reads input/output tokens and cost on the row', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), costUsd: 0.04 }))
    openRow('usage')
    expect(metaOf('usage')).toContain('IN 24.6k · OUT 2.4k')
    expect(metaOf('usage')).toContain('$0.04')
  })

  it('omits token and cost text when health disables token metrics', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({
        capabilities: { localHandoff: true, singleProject: false, tokenMetrics: false },
      }),
    })
    renderCard(run('done', { id: freshId(), costUsd: 0.04 }))
    openRow('usage')
    await waitFor(() => {
      expect(metaOf('usage')).not.toContain('IN 24.6k')
      expect(metaOf('usage')).not.toContain('$0.04')
    })
    expect(row('usage')!.querySelector('[data-slot="agent-details"]')).not.toBeNull()
  })

  it('lists tokens and cost in the opened row, so a phone that drops them from the summary still has them', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), costUsd: 0.04 }))
    expect(usageDetails()).toMatchObject({ Tokens: 'IN 24.6k · OUT 2.4k', Cost: '$0.04' })
  })

  it('includes both cost and tokens in the usage summary', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), costUsd: 0.04 }))
    openCard()
    const meta = row('usage')!.querySelector('[data-slot="run-activity-meta"]')!
    expect(meta.querySelector('[data-summary-item="cost"]')?.textContent).toBe('$0.04')
    expect(meta.querySelector('[data-summary-item="tokens"]')?.textContent).toContain('IN 24.6k · OUT 2.4k')
  })

  it('keeps the tokens when the run reported no cost', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), costUsd: undefined }))
    openCard()
    const meta = row('usage')!.querySelector('[data-slot="run-activity-meta"]')!
    expect(meta.querySelector('[data-summary-item="tokens"]')?.textContent).toBe('IN 24.6k · OUT 2.4k')
    expect(meta.querySelector('[data-summary-item="cost"]')).toBeNull()
  })

  it('shows a backend-reported zero cost and omits an unreported cost', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), costUsd: 0 }))
    openRow('usage')
    expect(metaOf('usage')).toContain('$0.00')

    cleanup()
    renderCard(run('done', { id: freshId(), costUsd: undefined }))
    openRow('usage')
    expect(metaOf('usage')).not.toContain('$0.00')
  })
})

/** Every line of the opened row, as `{ Tokens: …, Runner: 'codex', … }` — `dt` text to `dd` text. */
function usageDetails(): Record<string, string> {
  const dl = openRow('usage').querySelector('[data-slot="agent-details"]')!
  const out: Record<string, string> = {}
  for (const dt of dl.querySelectorAll('dt')) out[dt.textContent ?? ''] = dt.nextElementSibling?.textContent ?? ''
  return out
}

/** The agent lines alone, without the usage lines (`Tokens`, `Cost`) that lead the row. */
function agentDetails(): Record<string, string> {
  const { Tokens: _tokens, Cost: _cost, ...agent } = usageDetails()
  return agent
}

describe('Usage & agent — which agent ran (#416, #52, #411)', () => {
  it('lists runner, model and saved effort', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), runner: 'codex', model: 'gpt-5.2-codex', effort: 'high' }))
    expect(agentDetails()).toEqual({ Runner: 'codex', Model: 'gpt-5.2-codex', Effort: 'high' })
  })

  it('reads model and effort auto when the run pinned neither', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), runner: 'opencode' }))
    expect(agentDetails()).toEqual({ Runner: 'opencode', Model: 'auto', Effort: 'auto' })
  })

  it('shows the chosen model when a switch wrote the effective settings (#411)', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), runner: 'claude', model: 'claude-fable-5' }))
    expect(agentDetails()).toEqual({ Runner: 'claude', Model: 'claude-fable-5', Effort: 'auto' })
  })

  // #416: the record keeps only the runner the caller ASKED for; the run executes as
  // `input.runner ?? config.defaultRunner`, so a record without one names the project default.
  it('a run with no explicit runner names the active project config default, not boot health', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ defaultRunner: 'claude' }),
      '/api/v1/config': () => jsonResponse({ defaultRunner: 'codex', defaultModels: {} }),
    })
    renderCard(run('done', { id: freshId(), runner: undefined }))
    await waitFor(() => expect(agentDetails().Runner).toBe('codex'))
  })
})

/**
 * Which ACCOUNT a task ran under (spec 2026-07-29-agent-profiles), read from the step that
 * actually spawned, never from the composer override or the project's current selection.
 */
describe('Usage & agent — the account a task ran under', () => {
  const claude = (id: string, label: string, isDefault = false) => ({
    id, provider: 'claude', label, configDir: `~/.claude-${id}`, path: `/home/u/.claude-${id}`, exists: true, looksValid: true, isDefault, files: [],
  })
  const codex = (id: string, label: string, isDefault = false) => ({ ...claude(id, label, isDefault), provider: 'codex' })
  const withProfiles = (profiles: unknown[]) => stubFetch({
    '/api/v1/workspace/agent-profiles': () => jsonResponse({
      editable: true, profileCapableProviders: ['claude', 'codex'], selections: {}, defaults: {}, profiles,
    }),
  })
  const withAccounts = () => withProfiles([claude('default', 'Default', true), claude('klaudiusz', 'Klaudiusz')])
  const withOneAccount = () => withProfiles([claude('default', 'Default', true)])
  const account = () => row('usage')?.querySelector('[data-slot="agent-badge-account"]')?.textContent

  it('names the account the step recorded, by its label', async () => {
    withAccounts()
    renderCard(run('done', { id: freshId(), runner: 'claude', model: 'opus', steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })] }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('Klaudiusz'))
  })

  it('prefers what RAN over what the composer asked for', async () => {
    withAccounts()
    renderCard(run('done', {
      id: freshId(), runner: 'claude', agentProfile: 'default', steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
    }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('Klaudiusz'))
  })

  it('says nothing at all for a run from before accounts existed', async () => {
    const sent = withAccounts()
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1' })] }))
    openRow('usage')
    await waitFor(() => expect(sent.map((r) => r.path)).toContain('/api/v1/workspace/agent-profiles'))
    await act(async () => {})
    expect(account()).toBeUndefined()
  })

  it('still names an account that has since been removed', async () => {
    withAccounts()
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', profileId: 'deleted-one' })] }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('deleted-one (removed)'))
  })

  it('never claims (removed) for the discovered default, not even when the catalog cannot list it (#411)', async () => {
    const sent = stubFetch({
      '/api/v1/workspace/agent-profiles': () => jsonResponse({ editable: false, profileCapableProviders: [], selections: {}, defaults: {}, profiles: [] }),
    })
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', backend: 'claude', profileId: 'default' })] }))
    openRow('usage')
    await waitFor(() => expect(sent.map((r) => r.path)).toContain('/api/v1/workspace/agent-profiles'))
    await act(async () => {})
    expect(account()).toBeUndefined()
    expect(row('usage')!.textContent).not.toContain('(removed)')
  })

  it('names the default account when its backend has a choice (#411)', async () => {
    withAccounts()
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', backend: 'claude', profileId: 'default' })] }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('default'))
  })

  it('judges a recorded account against its own backend — a same-id row elsewhere is not it (#411)', async () => {
    withProfiles([claude('default', 'Default', true), codex('work', 'Work')])
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', backend: 'claude', profileId: 'work' })] }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('work (removed)'))
  })

  it('omits a lone account (#251)', async () => {
    const sent = withOneAccount()
    renderCard(run('done', {
      id: freshId(), runner: 'claude', model: 'opus', effort: 'high', steps: [step({ sessionId: 'sess-1', profileId: 'default' })],
    }))
    openRow('usage')
    await waitFor(() => expect(sent.map((r) => r.path)).toContain('/api/v1/workspace/agent-profiles'))
    await act(async () => {})
    // The effort pin and the single-account rule are independent — both hold at once.
    expect(agentDetails()).toEqual({ Runner: 'claude', Model: 'opus', Effort: 'high' })
  })

  it('keeps the account out while profiles are still loading — fail closed (#251)', () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).replace('?archived=recent', '') === '/api/v1/workspace/agent-profiles') return new Promise<Response>(() => {})
      return jsonResponse({})
    }))
    renderCard(run('done', { id: freshId(), runner: 'claude', model: 'opus', steps: [step({ sessionId: 'sess-1', profileId: 'default' })] }))
    expect(agentDetails()).toEqual({ Runner: 'claude', Model: 'opus', Effort: 'auto' })
  })

  it('still names a removed account once the runner is down to one login (#251)', async () => {
    withOneAccount()
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', profileId: 'work' })] }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('work (removed)'))
  })

  it('shows a known account its own backend has a choice for, even when the run runner does not (#251)', async () => {
    withProfiles([claude('default', 'Default', true), codex('default', 'Default', true), codex('work-laptop', 'Work Laptop')])
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', backend: 'codex', profileId: 'work-laptop' })] }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('Work Laptop'))
  })

  it('hides a lone account whose backend differs from the run runner (#251)', async () => {
    const sent = withProfiles([claude('default', 'Default', true), claude('work-desk', 'Work Desk'), codex('default', 'Default', true)])
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', backend: 'codex', profileId: 'default' })] }))
    openRow('usage')
    await waitFor(() => expect(sent.map((r) => r.path)).toContain('/api/v1/workspace/agent-profiles'))
    await act(async () => {})
    expect(account()).toBeUndefined()
  })

  it('falls back to the recorded id when the profiles query fails (#251)', async () => {
    stubFetch({ '/api/v1/workspace/agent-profiles': () => new Response('profiles unavailable', { status: 404 }) })
    renderCard(run('done', { id: freshId(), runner: 'claude', steps: [step({ sessionId: 'sess-1', profileId: 'work' })] }))
    openRow('usage')
    await waitFor(() => expect(account()).toBe('work'))
  })
})

describe('Usage & agent — the canonical model identity (#546)', () => {
  it('shows the provider/model the run actually resolved to, beside the asked-for model', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), runner: 'claude', model: 'opus', modelIdentity: 'anthropic/claude-opus-4-8' }))
    expect(agentDetails()).toMatchObject({ Model: 'opus', Identity: 'anthropic/claude-opus-4-8' })
  })

  it('says nothing for a run from before the identity was recorded', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), runner: 'claude', model: 'opus' }))
    expect(agentDetails().Identity).toBeUndefined()
  })

  it('omits the line when it would only repeat the model', () => {
    stubFetch()
    renderCard(run('done', { id: freshId(), runner: 'claude', model: 'anthropic/claude-opus-4-8', modelIdentity: 'anthropic/claude-opus-4-8' }))
    expect(agentDetails()).toEqual({ Runner: 'claude', Model: 'anthropic/claude-opus-4-8', Effort: 'auto' })
  })
})

describe('Workspace — compact tools (hearsay-tools/cezarion#1333 mockup)', () => {
  it('offers Open in… as one menu, plus worktree-path and resume-command copies', async () => {
    const sent = stubFetch({
      '/api/v1/open-targets': () => jsonResponse({ targets: [{ id: 'cli:opencode', label: 'OpenCode' }, { id: 'finder', label: 'Files' }] }),
    })
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderCard(run('failed', { id: freshId(), runner: 'opencode', branch: 'cez/x', worktreePath: '/tmp/wt' }))
    const workspace = openRow('workspace')
    // The targets stay behind one trigger, as the ··· menu shows them, so the row stays short.
    const trigger = await within(workspace).findByRole('button', { name: 'Open in…' })
    expect(within(workspace).queryByRole('button', { name: /OpenCode/ })).toBeNull()
    expect(workspace.querySelector('[data-slot="resume-command"] pre')).toBeNull()
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /OpenCode/ }))
    await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/open-in'))).toBe(true))

    fireEvent.click(within(workspace).getByRole('button', { name: 'Copy worktree path' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/tmp/wt'))
    fireEvent.click(within(workspace).getByRole('button', { name: 'Copy resume command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1'))
  })
})
