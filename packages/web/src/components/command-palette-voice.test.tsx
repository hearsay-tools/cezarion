import { summaryOf } from '@/test/run-summary-fixture'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, RunRecord, RunSummary, VoiceAnswer, VoiceDecision } from '@open-mercato/cezar-api-client'
import { CommandPalette } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { ThemeProvider } from '@/components/theme-provider'
import { resetVoiceStoreForTests, voiceStore } from '@/lib/voice/proposal-store'

const mocks = vi.hoisted(() => ({ voiceDecide: vi.fn(), reportVoiceOutcome: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  voiceDecide: mocks.voiceDecide,
  reportVoiceOutcome: mocks.reportVoiceOutcome,
}))

const fetchMock = vi.fn<typeof fetch>()

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  localStorage.clear()
  resetVoiceStoreForTests()
  mocks.voiceDecide.mockReset()
  mocks.reportVoiceOutcome.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
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
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function run(overrides: Partial<RunRecord> & { id: string; title: string }): RunSummary {
  return summaryOf({
    workflow: 'build',
    task: 'do the thing',
    status: 'failed',
    createdAt: '2026-07-14T10:00:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  })
}

function health(voice: boolean): HealthResponse {
  return {
    version: '0.0.0-test',
    projects: [],
    bootProject: 'default',
    repoRoot: '/repo',
    repo: { root: '/repo', branch: 'main' },
    checks: [],
    defaultRunner: 'claude',
    forge: null,
    capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false, preview: false, voice },
  }
}

/** Where did the palette send us? Rendered as a sibling so navigation is observable. */
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderPalette({ voice, runs = [], entry = '/' }: { voice: boolean; runs?: RunSummary[]; entry?: string }) {
  const routes: Record<string, unknown> = {
    '/api/v1/run-summaries': runs,
    '/api/v1/skills': [],
    '/api/v1/health': health(voice),
    '/api/v1/ui-state': {},
    '/api/v1/projects': { projects: [], bootProject: 'default', projectsDir: '/repos' },
  }
  fetchMock.mockImplementation(async (input) => {
    const path = String(input).replace('?archived=recent', '')
    if (!(path in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <ListViewProvider>
            <CommandPalette />
            <LocationProbe />
          </ListViewProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

/** Opens the palette and waits until health has loaded (the Inbox view row follows it). */
async function openPalette() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  const input = await screen.findByPlaceholderText(/Search projects, tasks/)
  await screen.findByText('Inbox')
  return input as HTMLInputElement
}

const content = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
const overlay = () => document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')

describe('palette voice mode', () => {
  it('renders no voice row when the capability is off', async () => {
    renderPalette({ voice: false, runs: [run({ id: 'a', title: 'Fix flaky shard' })] })
    const input = await openPalette()

    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: 'open the next failed task' } })
    const typed = content()?.outerHTML
    await act(() => vi.advanceTimersByTimeAsync(5000))
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(() => vi.advanceTimersByTimeAsync(5000))

    const html = content()?.outerHTML ?? ''
    // Nothing changes with time, and nothing of voice mode is on the page.
    expect(html).toBe(typed)
    expect(mocks.voiceDecide).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot^="voice-"]')).toBeNull()
    expect(document.querySelector('[data-voice-proposal]')).toBeNull()
    expect(screen.getByText('Nothing matches.')).toBeTruthy()
    expect(content()?.className).toContain('top-[10vh]')
    expect(overlay()?.className).toContain('bg-black/50')
  })

  it('renders the Will do row first when on', async () => {
    mocks.voiceDecide.mockResolvedValue({
      action: 'open',
      decisionId: '00000000-0000-4000-8000-000000000001',
      status: 'failed',
      position: 'next',
      confidence: 0.9,
    } satisfies VoiceDecision)
    renderPalette({ voice: true, runs: [run({ id: 'a', title: 'Fix flaky shard' })] })
    const input = await openPalette()

    fireEvent.change(input, { target: { value: 'open the next failed task' } })

    // bound: the 300 ms preview debounce runs on real timers here, under a loaded host.
    const row = await screen.findByText('Open “Fix flaky shard” — next failed', undefined, { timeout: 10_000 })
    expect(content()?.querySelector('[cmdk-item]')?.contains(row)).toBe(true)
    expect(row.closest('[cmdk-item]')?.getAttribute('data-slot')).toBe('voice-row')
    expect(screen.queryByText('Nothing matches.')).toBeNull()
    expect(mocks.voiceDecide).toHaveBeenCalledTimes(1)
    // bound: the debounce wait above may take up to 10 s on a loaded host.
  }, 20_000)

  it('a numbered candidate in the preview opens when clicked, before any Return', async () => {
    mocks.voiceDecide.mockResolvedValue({
      action: 'open',
      decisionId: '00000000-0000-4000-8000-000000000003',
      status: 'failed',
      position: 'next',
      confidence: 0.4,
      alternatives: [{ status: 'done', position: 1 }],
    } satisfies VoiceDecision)
    renderPalette({
      voice: true,
      runs: [run({ id: 'a', title: 'Alpha' }), run({ id: 'c', title: 'Charlie', status: 'done' })],
    })
    const input = await openPalette()

    fireEvent.change(input, { target: { value: 'open the next failed one' } })

    // bound: the 300 ms preview debounce runs on real timers here, under a loaded host.
    const second = await screen.findByText('Open “Charlie” — first done', undefined, { timeout: 10_000 })
    fireEvent.click(second)

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tasks/c'))
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000003', 'executed')
    // bound: the debounce wait above may take up to 10 s on a loaded host.
  }, 20_000)

  it('Enter opens the result selected below the Will do row', async () => {
    mocks.voiceDecide.mockResolvedValue({
      action: 'open',
      decisionId: '00000000-0000-4000-8000-000000000004',
      status: 'done',
      position: 1,
      confidence: 0.9,
    } satisfies VoiceDecision)
    renderPalette({
      voice: true,
      runs: [run({ id: 'a', title: 'Fix flaky shard' }), run({ id: 'b', title: 'Beta', status: 'done' })],
    })
    const input = await openPalette()

    fireEvent.change(input, { target: { value: 'fix flaky shard' } })
    // bound: the 300 ms preview debounce runs on real timers here, under a loaded host.
    await screen.findByText('Open “Beta” — first done', undefined, { timeout: 10_000 })
    const voiceRow = () => document.querySelector('[data-slot="voice-row"]')
    expect(voiceRow()?.getAttribute('data-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => expect(voiceRow()?.getAttribute('data-selected')).toBe('false'))
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/\/tasks\/a$/))
    expect(mocks.reportVoiceOutcome).not.toHaveBeenCalledWith('00000000-0000-4000-8000-000000000004', 'executed')
    // bound: the debounce wait above may take up to 10 s on a loaded host.
  }, 20_000)

  it('Enter right after a sentence commits it through the highlighted Will do row', async () => {
    mocks.voiceDecide.mockResolvedValue({
      action: 'open',
      decisionId: '00000000-0000-4000-8000-000000000005',
      status: 'done',
      position: 1,
      confidence: 0.9,
    } satisfies VoiceDecision)
    renderPalette({
      voice: true,
      runs: [run({ id: 'a', title: 'Fix flaky shard' }), run({ id: 'b', title: 'Beta', status: 'done' })],
    })
    const input = await openPalette()

    fireEvent.change(input, { target: { value: 'fix flaky shard' } })
    const row = document.querySelector('[data-slot="voice-row"]')
    expect(row?.textContent).toContain('Reading…')
    expect(row?.getAttribute('data-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tasks/b'))
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000005', 'executed')
  })

  it('docks the palette during a proposal', async () => {
    let applied: VoiceAnswer[] = []
    voiceStore.registerAskCard({
      runId: 'r1',
      requestId: 'ask_1',
      headers: ['Library'],
      read: () => ({ selections: {}, otherAnswers: {} }),
      apply: (answers) => {
        applied = answers
      },
      restore: () => {
        applied = []
      },
      unanswered: () => (applied.length > 0 ? [] : [0]),
      send: () => true,
    })
    mocks.voiceDecide.mockResolvedValue({
      action: 'answer',
      decisionId: '00000000-0000-4000-8000-000000000002',
      runId: 'r1',
      askRequestId: 'ask_1',
      answers: [{ question: 0, kind: 'option', labels: ['Vitest'] }],
      confidence: 0.9,
    } satisfies VoiceDecision)
    renderPalette({ voice: true, runs: [run({ id: 'r1', title: 'Pick a library', status: 'waiting' })], entry: '/tasks/r1' })
    const input = await openPalette()
    expect(content()?.hasAttribute('data-voice-proposal')).toBe(false)

    fireEvent.change(input, { target: { value: 'answer vitest to question one' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(content()?.getAttribute('data-voice-proposal')).toBe('true'))
    expect(content()?.className).not.toContain('top-[10vh]')
    // The card sits above the composer: an answer docks at the bottom.
    expect(content()?.className).toContain('bottom-[2vh]')
    expect(overlay()?.className).toContain('bg-transparent')
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(screen.getByText('Answer “Pick a library”: Library: Vitest')).toBeTruthy()

    // Esc closes the palette, which drops the proposal and reports it.
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(content()).toBeNull())
    expect(voiceStore.getProposal()).toBeUndefined()
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002', 'cancelled')
  })

  it('docks a tell at the top, away from the composer at the bottom', async () => {
    let draft = ''
    voiceStore.registerComposer({
      runId: 'r1',
      getDraft: () => draft,
      setDraft: (text) => {
        draft = text
        return true
      },
      clearVoiceDraft: (text) => {
        if (draft === text) draft = ''
        return draft === ''
      },
      submit: () => true,
    })
    mocks.voiceDecide.mockResolvedValue({
      action: 'tell',
      decisionId: '00000000-0000-4000-8000-000000000003',
      runId: 'r1',
      text: 'run the tests again',
      confidence: 0.9,
    } satisfies VoiceDecision)
    renderPalette({ voice: true, runs: [run({ id: 'r1', title: 'Say hello', status: 'waiting' })], entry: '/tasks/r1' })
    const input = await openPalette()

    fireEvent.change(input, { target: { value: 'tell it: run the tests again' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(content()?.getAttribute('data-voice-proposal')).toBe('true'))
    expect(draft).toBe('run the tests again')
    expect(content()?.className).toContain('top-[2vh]')
    expect(content()?.className).not.toContain('bottom-[2vh]')
    expect(document.activeElement).toBe(input)
  })
})
