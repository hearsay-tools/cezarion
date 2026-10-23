import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { resetVoiceStoreForTests, voiceStore } from '@/lib/voice/proposal-store'
import type { VoiceAnswer } from '@open-mercato/cezar-api-client'
import { AskCard } from './ask-card'
import type { ThreadAsk } from './thread-state'
import type { ApiRun, ProviderStatusResponse, StepState } from '@open-mercato/cezar-api-client'

const mutateAsync = vi.fn().mockResolvedValue({})
const continueAsync = vi.fn().mockResolvedValue({})
let providerStatus: ProviderStatusResponse
vi.mock('@/api/queries', () => ({
  useSendMessage: () => ({ mutateAsync, isPending: false }),
  useContinueRun: () => ({ mutateAsync: continueAsync, isPending: false }),
  useProviderStatus: () => ({ data: providerStatus, isSuccess: true }),
}))

beforeEach(() => resetVoiceStoreForTests())

afterEach(() => {
  cleanup()
  mutateAsync.mockClear().mockResolvedValue({})
  continueAsync.mockClear().mockResolvedValue({})
  providerStatus = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'not-installed', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  }
})

const activeRun: ApiRun = {
  id: 'r1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: 'waiting',
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'claude',
  steps: [],
}

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

/** The run the feature exists for: the session closed while the question was unanswered. */
const closedRun: ApiRun = {
  ...activeRun,
  status: 'done',
  steps: [step({ sessionId: 'sess-1' })],
}

const renderAsk = (ask: ThreadAsk, run: ApiRun = activeRun) => render(
  <MemoryRouter>
    <AskCard ask={ask} run={run} />
  </MemoryRouter>,
)

const singleAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_1',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which date library should I standardize on?',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable' },
        { label: 'Luxon', description: 'Immutable, tz-aware' },
      ],
    },
  ],
}

const multiAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_2',
  resolved: false,
  questions: [
    {
      header: 'Sections',
      question: 'Which settings sections?',
      multiSelect: true,
      options: [{ label: 'Profile' }, { label: 'Appearance' }, { label: 'Billing' }],
    },
  ],
}

const twoQuestionAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_3',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which library?',
      options: [{ label: 'date-fns' }, { label: 'Luxon' }],
    },
    {
      header: 'Style',
      question: 'Which style?',
      options: [{ label: 'ISO' }, { label: 'Relative' }],
    },
  ],
}

describe('AskCard', () => {
  it('renders the header, question and each option with its description', () => {
    renderAsk(singleAsk)
    expect(screen.getByText('Library')).toBeTruthy()
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /date-fns/ })).toBeTruthy()
    expect(screen.getByText('Tree-shakeable')).toBeTruthy()
  })

  it('wraps schema-valid unbroken question and option text inside the card', () => {
    const question = 'q'.repeat(400)
    const label = 'l'.repeat(60)
    const description = 'd'.repeat(280)
    renderAsk({
      ...singleAsk,
      questions: [{ header: 'Limits', question, options: [{ label, description }, { label: 'Other' }] }],
    })

    expect(screen.getByText(question).className).toContain('break-words')
    expect(screen.getByText(label).className).toContain('break-words')
    expect(screen.getByText(description).className).toContain('break-words')
  })

  it('a single single-select question sends "header: label" on one tap (no Send button)', () => {
    renderAsk(singleAsk)
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
  })

  it('multiple questions: one Send posts every answer in one combined message', () => {
    renderAsk(twoQuestionAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    // Answering only the first question does NOT send, and does not resolve.
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(send.disabled).toBe(true)
    expect(mutateAsync).not.toHaveBeenCalled()
    // Both answered → one combined message.
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns\nStyle: Relative' })
  })

  it('combines a chip answer and per-question Other text in one message', () => {
    renderAsk(twoQuestionAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    const styleQuestion = screen.getByRole('group', { name: 'Which style?' })

    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(within(styleQuestion).getByRole('button', { name: 'Other' }))
    const answer = within(styleQuestion).getByRole('textbox', { name: 'Your answer' })
    expect(send.disabled).toBe(true)

    fireEvent.change(answer, { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
    fireEvent.change(answer, { target: { value: 'A short custom style' } })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    expect(mutateAsync).toHaveBeenCalledWith({
      text: 'Library: date-fns\nStyle: A short custom style',
    })
  })

  it('a single single-select question sends Other text with an explicit Send', () => {
    renderAsk(singleAsk)

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'A custom library' },
    })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: A custom library' })
  })

  it('a multi-select question accepts Other text without a chip selection', () => {
    renderAsk(multiAsk)

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'Only the account summary' },
    })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Sections: Only the account summary' })
  })

  it('keeps a custom answer in the field when delivery fails', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('temporary failure'))
    renderAsk(twoQuestionAsk)
    const styleQuestion = screen.getByRole('group', { name: 'Which style?' })

    fireEvent.click(within(styleQuestion).getByRole('button', { name: 'Other' }))
    const answer = within(styleQuestion).getByRole('textbox', { name: 'Your answer' })
    fireEvent.change(answer, { target: { value: 'A short custom style' } })
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect((await screen.findByRole('alert')).textContent).toBe('temporary failure')
    expect(answer).toHaveProperty('value', 'A short custom style')
  })

  it('multi-select: Send is disabled until options are picked, then sends the comma-joined labels', () => {
    renderAsk(multiAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Profile/ }))
    fireEvent.click(screen.getByRole('button', { name: /Billing/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Sections: Profile, Billing' })
  })

  it('a resolved ask collapses to a compact answered summary with no option buttons', () => {
    renderAsk({ ...singleAsk, resolved: true, answer: 'Library: date-fns' })
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.getByText('Library: date-fns').className).toContain('break-words')
    expect(screen.queryByRole('button', { name: /date-fns/ })).toBeNull()
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }, 'Claude Code is disabled. Enable it in Settings → Agents → Providers.'],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }, 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.'],
  ] as const)('disables Ask submissions when its active provider is %s', (_case, claude, reason) => {
    providerStatus = {
      providers: [
        claude,
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }

    renderAsk(singleAsk)

    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})

// The question outlives its session: an idle timeout, a cezar restart, Finish or a cancel
// closes the session with the card still unanswered. Before this, every tap posted to
// `POST /messages` and died on its `409 session closed` — silently.
describe('AskCard — answering after the session has ended', () => {
  it('a closed run resumes instead of replying, with the same answer text', async () => {
    renderAsk(singleAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    // No runner override: answering a question must not silently switch the run's engine.
    expect(continueAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('says the session reopens, on both the one-tap and the combined-Send shapes', () => {
    const { unmount } = renderAsk(singleAsk, closedRun)
    expect(screen.getByText('The session has ended — your answer reopens it and goes to the agent.')).toBeTruthy()
    unmount()
    renderAsk(twoQuestionAsk, closedRun)
    expect(screen.getByRole('button', { name: 'Send answer & reopen' })).toBeTruthy()
    expect(screen.getByText('the session has ended — sending reopens it')).toBeTruthy()
  })

  // The resume affordance must be identifiable without reading copy — and must NOT be claimed
  // by a live run's ordinary "pick one or more" hint, which sits in the same slot position.
  it('marks the delivery seam on the card, and only names the resume hint when resuming', () => {
    const { unmount } = renderAsk(twoQuestionAsk, activeRun)
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('data-delivery')).toBe('live')
    expect(document.querySelector('[data-slot="ask-resume-hint"]')).toBeNull()
    expect(document.querySelector('[data-slot="ask-hint"]')).toBeTruthy()
    unmount()
    renderAsk(twoQuestionAsk, closedRun)
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('data-delivery')).toBe('resume')
    expect(document.querySelector('[data-slot="ask-resume-hint"]')).toBeTruthy()
  })

  it('combined Send on a closed run resumes once with every answer', async () => {
    renderAsk(twoQuestionAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer & reopen' }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect(continueAsync).toHaveBeenCalledWith({
      text: 'Library: date-fns\nStyle: Relative',
    })
  })

  it('a stale record that still claims a live session falls back to a resume on 409', async () => {
    // The cockpit's cached record says `waiting`; the server has already closed the session.
    mutateAsync.mockRejectedValueOnce(new ApiError(409, 'session closed'))
    renderAsk(singleAsk, { ...activeRun, steps: [step({ sessionId: 'sess-1' })] })
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect(continueAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('waits for idle teardown before retrying the continuation, without accepting a duplicate tap', async () => {
    mutateAsync.mockRejectedValueOnce(new ApiError(409, 'session closed'))
    let resolveContinuation: ((value: { continued: true }) => void) | undefined
    const continuation = new Promise<{ continued: true }>((resolve) => {
      resolveContinuation = resolve
    })
    continueAsync
      .mockRejectedValueOnce(new ApiError(409, 'run is still active'))
      .mockReturnValueOnce(continuation)
    renderAsk(singleAsk, { ...activeRun, steps: [step({ sessionId: 'sess-1' })] })

    const option = screen.getByRole('button', { name: /date-fns/ })
    fireEvent.click(option)
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect((option as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(option)

    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(2))
    expect(continueAsync).toHaveBeenNthCalledWith(1, { text: 'Library: date-fns' })
    expect(continueAsync).toHaveBeenNthCalledWith(2, { text: 'Library: date-fns' })
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    resolveContinuation?.({ continued: true })
    await waitFor(() => expect((option as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not silently switch to another connected provider when the run provider is unavailable', () => {
    providerStatus = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }

    renderAsk(singleAsk, closedRun)

    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.',
      ),
    ).toBeTruthy()
    expect(continueAsync).not.toHaveBeenCalled()
  })

  it('a refused delivery is shown on the card instead of being dropped', async () => {
    continueAsync.mockRejectedValueOnce(new ApiError(409, 'no agent session to resume'))
    renderAsk(singleAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('no agent session to resume')
  })

  it('a closed run that never recorded a session says so and stays inert', () => {
    renderAsk(singleAsk, { ...closedRun, steps: [step()] })
    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'This session has ended and no agent session was recorded, so the answer cannot be delivered.',
      ),
    ).toBeTruthy()
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(continueAsync).not.toHaveBeenCalled()
  })
})

// hearsay-tools/cezarion#1234: a question without options is open; the user types the answer.
const openAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_open',
  resolved: false,
  questions: [{ header: 'Name', question: 'What should the command be called?' }],
}

describe('AskCard — open questions', () => {
  it('shows a text field instead of choices and sends "header: text"', () => {
    renderAsk(openAsk)
    const question = screen.getByRole('group', { name: 'What should the command be called?' })
    // No chips and no Other toggle: the field is the answer.
    expect(within(question).queryByRole('button')).toBeNull()
    const answer = within(question).getByRole('textbox', { name: 'Your answer' })
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(document.querySelector('[data-slot="ask-hint"]')?.textContent).toBe('enter your answer above — or type a reply below')
    fireEvent.change(answer, { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
    fireEvent.change(answer, { target: { value: 'cez ask' } })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Name: cez ask' })
  })

  it('beside a choice question, one Send answers both', () => {
    renderAsk({ ...openAsk, questions: [singleAsk.questions[0]!, openAsk.questions[0]!] })
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    // The card is not one-tap any more: the chip only selects.
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'cez ask' } })
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns\nName: cez ask' })
  })

  it('routed to the parent, it says the parent answers in words', () => {
    renderAsk({ ...openAsk, routedToParent: true, parentRunId: '11111111-2222-4333-8444-555555555555' })
    expect(screen.getByText('What should the command be called?')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('[data-slot="ask-open-routed"]')?.textContent).toBe('Open question: answered in words, with no options.')
  })
})

describe('AskCard for a worker question routed to its parent (#505)', () => {
  const parentId = '11111111-2222-4333-8444-555555555555'
  it('renders the question read-only with a link to the parent task', () => {
    renderAsk({ ...singleAsk, routedToParent: true, parentRunId: parentId })
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    expect(screen.getByText('date-fns')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /date-fns/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'parent task' }).getAttribute('href')).toContain(`/tasks/${parentId}`)
    cleanup()
    render(
      <MemoryRouter initialEntries={['/p/acme/tasks/worker']}>
        <AskCard ask={{ ...singleAsk, routedToParent: true, parentRunId: parentId }} run={activeRun} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'parent task' }).getAttribute('href')).toBe(`/p/acme/tasks/${parentId}`)
    expect(document.querySelector('[data-slot="ask-routed-hint"]')?.textContent).toContain('Routed to parent')
  })

  it('shows the chips again once the question falls back to the human', () => {
    renderAsk({ ...singleAsk, routedToParent: false, parentRunId: parentId })
    expect(screen.getByRole('button', { name: /date-fns/ })).toBeTruthy()
    expect(document.querySelector('[data-slot="ask-routed-hint"]')).toBeNull()
  })

  it('says the parent answered it', () => {
    renderAsk({ ...singleAsk, resolved: true, answeredBy: 'parent' })
    expect(screen.getByText('Answered by parent')).toBeTruthy()
  })

  // hearsay-tools/cezarion#1260: a question Finish closed was never answered.
  it('says Finish closed a question nobody answered', () => {
    renderAsk({ ...singleAsk, resolved: true, closed: 'finish' })
    expect(screen.getByText('Closed when the task finished')).toBeTruthy()
    expect(screen.queryByText('Answered')).toBeNull()
  })
})

describe('AskCard voice proposals', () => {
  const voiceAsk: ThreadAsk = {
    kind: 'ask',
    id: 'ask_voice',
    resolved: false,
    questions: [
      { header: 'Library', question: 'Which test library?', options: [{ label: 'Vitest' }, { label: 'Jest' }] },
      { header: 'Build', question: 'Which build tool?', options: [{ label: 'Vite' }, { label: 'esbuild' }] },
    ],
  }
  const propose = (decisionId: string, ...answers: VoiceAnswer[]) =>
    act(() => voiceStore.propose({ kind: 'answer', decisionId, runId: 'r1', askRequestId: voiceAsk.id, answers }))
  const card = () => document.querySelector('[data-slot="ask-card"]') as HTMLElement
  const pressed = (name: RegExp) => screen.getByRole('button', { name }).getAttribute('aria-pressed')

  it('voice fills chips and Other and shows the prompt', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    renderAsk(voiceAsk)
    expect(document.querySelector('[data-slot="ask-voice-prompt"]')).toBeNull()
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] }, { question: 1, kind: 'other', text: 'use both' })

    expect(pressed(/Vitest/)).toBe('true')
    expect(pressed(/Jest/)).toBe('false')
    const build = screen.getByRole('group', { name: 'Which build tool?' })
    expect(within(build).getByRole('button', { name: 'Other' }).getAttribute('aria-pressed')).toBe('true')
    expect((within(build).getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).value).toBe('use both')
    expect(card().getAttribute('data-voice-proposal')).toBe('true')
    expect(screen.getByRole('group', { name: 'Which test library?' }).getAttribute('data-voice-filled')).toBe('true')
    expect(build.getAttribute('data-voice-filled')).toBe('true')
    expect(document.querySelector('[data-slot="ask-voice-prompt"]')?.textContent).toBe(
      'Send these answers? Say “yes, confirmed” or press Return.',
    )
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    // Nothing is sent until the proposal is confirmed.
    expect(mutateAsync).not.toHaveBeenCalled()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('cancel restores a manual choice made before voice', () => {
    renderAsk(voiceAsk)
    fireEvent.click(screen.getByRole('button', { name: /Jest/ }))
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] }, { question: 1, kind: 'option', labels: ['Vite'] })
    expect(pressed(/Vitest/)).toBe('true')
    expect(pressed(/Jest/)).toBe('false')
    act(() => voiceStore.cancel())
    expect(pressed(/Jest/)).toBe('true')
    expect(pressed(/Vitest/)).toBe('false')
    expect(pressed(/Vite$/)).toBe('false')
    expect(card().getAttribute('data-voice-proposal')).toBeNull()
    expect(document.querySelector('[data-slot="ask-voice-prompt"]')).toBeNull()
    expect(document.querySelector('[data-voice-filled]')).toBeNull()
  })

  it('a replacing proposal keeps the first snapshot', () => {
    renderAsk(voiceAsk)
    fireEvent.click(screen.getByRole('button', { name: /Jest/ }))
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] })
    propose('d2', { question: 1, kind: 'option', labels: ['Vite'] })
    act(() => voiceStore.cancel())
    expect(pressed(/Jest/)).toBe('true')
    expect(pressed(/Vite$/)).toBe('false')
  })

  it('confirm sends one combined message', async () => {
    renderAsk(voiceAsk)
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] }, { question: 1, kind: 'other', text: 'use both' })
    let result: ReturnType<typeof voiceStore.confirm> | undefined
    act(() => {
      result = voiceStore.confirm()
    })
    expect(result).toEqual({ ok: true })
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: Vitest\nBuild: use both' })
    expect(voiceStore.getProposal()).toBeUndefined()
    expect(card().getAttribute('data-voice-proposal')).toBeNull()
    expect(document.querySelector('[data-voice-filled]')).toBeNull()
  })

  it('confirm refuses a card with an unanswered question and keeps the proposal', () => {
    renderAsk(voiceAsk)
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] })
    let result: ReturnType<typeof voiceStore.confirm> | undefined
    act(() => {
      result = voiceStore.confirm()
    })
    expect(result).toEqual({ ok: false, unanswered: [{ index: 1, header: 'Build' }] })
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(voiceStore.getProposal()).toBeDefined()
    expect(document.querySelector('[data-slot="ask-voice-prompt"]')).not.toBeNull()
  })

  it('confirm sends what the card shows after a manual change', async () => {
    renderAsk(voiceAsk)
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] }, { question: 1, kind: 'option', labels: ['Vite'] })
    fireEvent.click(screen.getByRole('button', { name: /Jest/ }))
    act(() => {
      voiceStore.confirm()
    })
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: Jest\nBuild: Vite' })
  })

  it('confirm after a manual fill of a missing question sends', async () => {
    renderAsk(voiceAsk)
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] })
    fireEvent.click(screen.getByRole('button', { name: /esbuild/ }))
    let result: ReturnType<typeof voiceStore.confirm> | undefined
    act(() => {
      result = voiceStore.confirm()
    })
    expect(result).toEqual({ ok: true })
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: Vitest\nBuild: esbuild' }))
  })

  it('a one-question card is not sent on apply', () => {
    renderAsk(singleAsk)
    act(() => {
      voiceStore.propose({
        kind: 'answer',
        decisionId: 'd1',
        runId: 'r1',
        askRequestId: singleAsk.id,
        answers: [{ question: 0, kind: 'option', labels: ['date-fns'] }],
      })
    })
    expect(pressed(/date-fns/)).toBe('true')
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="ask-voice-prompt"]')).not.toBeNull()
    act(() => {
      voiceStore.confirm()
    })
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
  })

  it('a refused confirm keeps the proposal, its marks and the snapshot', () => {
    providerStatus = {
      providers: [{ provider: 'claude', status: 'not-installed', enabled: true }],
    }
    renderAsk(voiceAsk)
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] }, { question: 1, kind: 'option', labels: ['Vite'] })
    let result: ReturnType<typeof voiceStore.confirm> | undefined
    act(() => {
      result = voiceStore.confirm()
    })
    expect(result).toEqual({ ok: false, reason: 'busy' })
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    expect(card().getAttribute('data-voice-proposal')).toBe('true')
    expect(document.querySelector('[data-slot="ask-voice-prompt"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-voice-filled]')).toHaveLength(2)
    // The snapshot survived: cancel puts the card back to empty.
    act(() => voiceStore.cancel())
    expect(card().getAttribute('data-voice-proposal')).toBeNull()
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
  })

  it('a chip tapped during a voice proposal on a one-question card is not sent until confirm', async () => {
    renderAsk(singleAsk)
    act(() => {
      voiceStore.propose({
        kind: 'answer',
        decisionId: 'd1',
        runId: 'r1',
        askRequestId: singleAsk.id,
        answers: [{ question: 0, kind: 'option', labels: ['date-fns'] }],
      })
    })
    fireEvent.click(screen.getByRole('button', { name: /Luxon/ }))
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(pressed(/Luxon/)).toBe('true')
    expect(pressed(/date-fns/)).toBe('false')
    act(() => {
      expect(voiceStore.confirm()).toEqual({ ok: true })
    })
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: Luxon' })
  })

  // A virtualized thread unmounts offscreen rows while the question stays open (final review, T6).
  it('a remount of the same open question keeps the voice answers and merges the next sentence', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    renderAsk(voiceAsk)
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] })
    cleanup()
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    expect(voiceStore.lastDrop()).toBeUndefined()
    let result: ReturnType<typeof voiceStore.confirm> | undefined
    act(() => {
      result = voiceStore.confirm()
    })
    expect(result).toEqual({ ok: false, reason: 'no-target' })
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })

    scrollIntoView.mockClear()
    renderAsk(voiceAsk)
    expect(pressed(/Vitest/)).toBe('true')
    expect(card().getAttribute('data-voice-proposal')).toBe('true')
    expect(screen.getByRole('group', { name: 'Which test library?' }).getAttribute('data-voice-filled')).toBe('true')
    expect(document.querySelector('[data-slot="ask-voice-prompt"]')).not.toBeNull()
    // Coming back into view is not a new proposal: the card does not pull the scroll to itself.
    expect(scrollIntoView).not.toHaveBeenCalled()

    propose('d2', { question: 1, kind: 'option', labels: ['Vite'] })
    expect(pressed(/Vitest/)).toBe('true')
    expect(pressed(/Vite$/)).toBe('true')
    act(() => {
      result = voiceStore.confirm()
    })
    expect(result).toEqual({ ok: true })
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: Vitest\nBuild: Vite' }))
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('cancel after a remount puts back the choice made before voice', () => {
    renderAsk(voiceAsk)
    fireEvent.click(screen.getByRole('button', { name: /Jest/ }))
    propose('d1', { question: 0, kind: 'option', labels: ['Vitest'] })
    cleanup()
    renderAsk(voiceAsk)
    expect(pressed(/Vitest/)).toBe('true')
    act(() => voiceStore.cancel())
    expect(pressed(/Jest/)).toBe('true')
    expect(pressed(/Vitest/)).toBe('false')
    expect(card().getAttribute('data-voice-proposal')).toBeNull()
  })

  it('a routed card registers no target', () => {
    renderAsk({ ...voiceAsk, routedToParent: true, parentRunId: '11111111-2222-4333-8444-555555555555' })
    expect(
      voiceStore.propose({
        kind: 'answer',
        decisionId: 'd1',
        runId: 'r1',
        askRequestId: voiceAsk.id,
        answers: [{ question: 0, kind: 'option', labels: ['Vitest'] }],
      }),
    ).toEqual({ ok: false, reason: 'no-card' })
  })

  it('a resolved card registers no target', () => {
    renderAsk({ ...voiceAsk, resolved: true })
    expect(
      voiceStore.propose({
        kind: 'answer',
        decisionId: 'd1',
        runId: 'r1',
        askRequestId: voiceAsk.id,
        answers: [{ question: 0, kind: 'option', labels: ['Vitest'] }],
      }),
    ).toEqual({ ok: false, reason: 'no-card' })
  })
})

// hearsay-tools/cezarion#1458: the agent's draft or findings, as Markdown above the questions.
describe('AskCard context', () => {
  const context = 'The plan has **two** steps.\n\n- parse\n- render'

  it('renders the context as Markdown in a focusable region before the first question', () => {
    renderAsk({ ...singleAsk, context })
    const region = screen.getByRole('region', { name: 'Context' })
    expect(region.getAttribute('data-slot')).toBe('ask-context')
    expect(region.tabIndex).toBe(0)
    expect(within(region).getByText('two').closest('[data-streamdown="strong"]')).not.toBeNull()
    expect(within(region).getAllByRole('listitem')).toHaveLength(2)
    const question = screen.getByText('Which date library should I standardize on?')
    expect(region.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders it on a card routed to the parent too', () => {
    renderAsk({ ...singleAsk, context, routedToParent: true, parentRunId: '11111111-2222-4333-8444-555555555555' })
    expect(within(screen.getByRole('region', { name: 'Context' })).getByText('two').closest('[data-streamdown="strong"]')).not.toBeNull()
  })

  it('shows no context region for an ask without one, or once it is answered', () => {
    renderAsk(singleAsk)
    expect(screen.queryByRole('region', { name: 'Context' })).toBeNull()
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    cleanup()
    renderAsk({ ...singleAsk, context, resolved: true, answer: 'Library: Luxon' })
    expect(screen.queryByRole('region', { name: 'Context' })).toBeNull()
  })
})
