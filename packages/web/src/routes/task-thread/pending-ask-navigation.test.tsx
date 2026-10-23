import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { AskCard } from './ask-card'
import { AskOriginMarker, firstAnswerControl, jumpLabel, pinnedAnswerControl, pinnedAskFocus } from './pending-ask-navigation'
import type { ThreadAsk } from './thread-state'
import { JumpToLatestPill } from './thread-scroller'

vi.mock('@/api/queries', () => ({
  useSendMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useContinueRun: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useProviderStatus: () => ({
    data: { providers: [{ provider: 'claude', status: 'connected', enabled: true }] },
    isSuccess: true,
  }),
}))

afterEach(cleanup)

const run: ApiRun = {
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

const ask = (overrides: Partial<ThreadAsk> = {}): ThreadAsk => ({
  kind: 'ask',
  id: 'q1',
  resolved: false,
  placement: 'pinned',
  questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'First' }, { label: 'Second' }] }],
  ...overrides,
})

const renderCard = (value: ThreadAsk, onShowOrigin?: () => void) => render(
  <MemoryRouter>
    <AskCard ask={value} run={run} {...(onShowOrigin ? { onShowOrigin } : {})} />
  </MemoryRouter>,
)

const card = () => document.querySelector<HTMLElement>('[data-slot="ask-card"]')!

describe('jumpLabel (#1495)', () => {
  it('names the pending questions', () => {
    expect(jumpLabel(0)).toBe('Jump to latest')
    expect(jumpLabel(1)).toBe('Jump to latest (1 question pending)')
    expect(jumpLabel(3)).toBe('Jump to latest (3 questions pending)')
  })
})

describe('firstAnswerControl (#1495)', () => {
  it('picks the first chip', () => {
    renderCard(ask(), () => {})
    expect(firstAnswerControl(card())).toBe(screen.getByRole('button', { name: 'First' }))
  })

  it('picks the textarea of an open question', () => {
    renderCard(ask({ questions: [{ header: 'Say', question: 'What next?' }] }))
    expect(firstAnswerControl(card()).tagName).toBe('TEXTAREA')
  })

  it('falls back to a routed card', () => {
    renderCard(ask({ routedToParent: true }))
    const routed = card()
    expect(routed.dataset.routed).toBe('parent')
    expect(firstAnswerControl(routed)).toBe(routed)
    expect(routed.tabIndex).toBe(-1)
  })

  it('finds only the pinned card under a root', () => {
    renderCard(ask({ placement: undefined }))
    expect(pinnedAnswerControl(document.body)).toBeNull()
    cleanup()
    renderCard(ask())
    expect(pinnedAnswerControl(document.body)).toBe(screen.getByRole('button', { name: 'First' }))
  })
})

describe('pinnedAskFocus (#1495)', () => {
  /** A pinned card inside the row the transcript renders for it, keyed by its ask id. */
  const renderPinned = (askId: string) => {
    const row = document.createElement('div')
    row.dataset.rowKey = `pending-ask:${askId}`
    document.body.append(row)
    render(<MemoryRouter><AskCard ask={ask({ id: askId })} run={run} /></MemoryRouter>, { container: row })
  }

  it('focuses only the pinned card of the ask it was made for', () => {
    renderPinned('q2')
    expect(pinnedAskFocus('q1', () => true)(document.body)).toBeNull()
    expect(pinnedAskFocus('q2', () => true)(document.body)).toBe(screen.getByRole('button', { name: 'First' }))
  })

  it('cancels once its ask is no longer pending', () => {
    renderPinned('q1')
    expect(pinnedAskFocus('q1', () => false)(document.body)).toBe(false)
  })
})

describe('pinned card and marker (#1495)', () => {
  it('pinned card shows the origin link and calls it', () => {
    const onShowOrigin = vi.fn()
    renderCard(ask(), onShowOrigin)
    expect(card().dataset.pinned).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Show where it was asked' }))
    expect(onShowOrigin).toHaveBeenCalledOnce()
  })

  it('an unpinned card has no origin link', () => {
    renderCard(ask({ placement: undefined }), () => {})
    expect(card().dataset.pinned).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Show where it was asked' })).toBeNull()
  })

  it('a routed pinned card keeps the origin link', () => {
    renderCard(ask({ routedToParent: true }), () => {})
    expect(card().dataset.pinned).toBe('true')
    expect(screen.getByRole('button', { name: 'Show where it was asked' })).toBeTruthy()
  })

  it('marker names the question and goes to it', () => {
    const onGoToQuestion = vi.fn()
    render(<AskOriginMarker onGoToQuestion={onGoToQuestion} />)
    expect(screen.getByText('Question asked here')).toBeTruthy()
    const go = screen.getByRole('button', { name: 'Go to the question' })
    expect(go.className).toContain('min-h-11')
    fireEvent.click(go)
    expect(onGoToQuestion).toHaveBeenCalledOnce()
  })
})

describe('JumpToLatestPill pending label (#1495)', () => {
  it('renders the pending label', () => {
    render(<JumpToLatestPill onJump={() => {}} pendingQuestions={2} />)
    const pill = screen.getByRole('button', { name: 'Jump to latest (2 questions pending)' })
    expect(pill.dataset.pendingQuestions).toBe('2')
  })

  it('calls onJump with no argument', () => {
    const onJump = vi.fn()
    render(<JumpToLatestPill onJump={onJump} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(onJump).toHaveBeenCalledWith()
  })
})
