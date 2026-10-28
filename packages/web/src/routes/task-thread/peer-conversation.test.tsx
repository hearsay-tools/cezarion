import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'

import { SessionTranscript } from './session-transcript'
import { reduceThread } from './thread-state'

// The lookup a card makes for a peer the run list does not carry. Each test sets its answer.
type RunLookup = { data?: (Pick<ApiRun, 'id' | 'title'> & Partial<ApiRun>) | undefined; isPending: boolean; error: unknown }
const lookup = vi.hoisted(() => ({ answer: { data: undefined, isPending: true, error: null } as RunLookup, ids: [] as string[] }))
vi.mock('@/api/queries', async (original) => ({
  ...(await original<typeof import('@/api/queries')>()),
  useRun: (id: string | undefined) => { lookup.ids.push(id ?? ''); return lookup.answer },
}))

afterEach(() => {
  cleanup()
  lookup.answer = { data: undefined, isPending: true, error: null }
  lookup.ids = []
})

const self = '11111111-1111-4111-8111-111111111111'
const peer = '22222222-2222-4222-8222-222222222222'
const worker = '55555555-5555-4555-8555-555555555555'
const requestId = '33333333-3333-4333-8333-333333333333'
const replyId = '44444444-4444-4444-8444-444444444444'
const envelope = { requestHash: 'a'.repeat(64), state: 'accepted', createdAt: '2026-10-28T12:00:00.000Z' }
const peerRequest = { ...envelope, id: requestId, senderRunId: self, recipientRunId: peer, kind: 'request', relationship: 'peer', text: 'Is the schema frozen?' }
const peerReply = { ...envelope, id: replyId, senderRunId: peer, recipientRunId: self, kind: 'reply', relationship: 'peer', requestId, text: 'Frozen since Monday.', createdAt: '2026-10-28T12:01:00.000Z' }

function asEvents(events: object[]): RunEvent[] {
  return events.map((event, index) => {
    return { seq: index + 1, ts: '2026-10-28T12:00:00.000Z', ...event } as RunEvent
  })
}

function renderThread(events: object[], taskTitles: Record<string, string> = { [self]: 'Coordinator', [peer]: 'Schema task' }) {
  const entries = reduceThread(asEvents(events)).turns.flatMap((turn) => turn.items)
  return render(
    <MemoryRouter initialEntries={['/p/acme/tasks/current']}>
      <SessionTranscript runId={self} viewId="main" sections={[{ id: 'turn', entries }]} mode="document" taskTitles={taskTitles} />
    </MemoryRouter>,
  )
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="worker-conversation-card"]')]

describe('peer conversation cards (hearsay-tools/cezarion#1992)', () => {
  it('names the peer by title, links its thread and marks the card as a peer card', () => {
    renderThread([{ type: 'conversation-message', message: peerRequest, delivery: 'delivered' }])
    const [card] = cards()
    expect(card!.getAttribute('data-relationship')).toBe('peer')
    expect(card!.getAttribute('data-direction')).toBe('outbound')
    expect(within(card!).getByText('Peer').getAttribute('data-slot')).toBe('conversation-relationship')
    expect(within(card!).getByRole('link', { name: 'SENT to Schema task' }).getAttribute('href')).toBe(`/p/acme/tasks/${peer}`)
    expect(card!.className).toContain('border-message-peer-border')
    expect(card!.className).not.toContain('message-outbound')
    expect(card!.className).not.toContain('message-inbound')
  })

  it('renders a request, its reply and its outcome in thread order, both as peer cards', () => {
    renderThread([
      { type: 'conversation-message', message: peerRequest, delivery: 'delivered' },
      { type: 'text', text: 'Waiting on the peer.' },
      { type: 'conversation-message', message: peerReply, delivery: 'delivered' },
      { type: 'request-outcome', outcome: { requestId, status: 'replied', replyId, observedAt: peerReply.createdAt } },
    ])
    expect(cards().map((card) => [card.getAttribute('data-kind'), card.getAttribute('data-direction'), card.getAttribute('data-relationship')])).toEqual([
      ['request', 'outbound', 'peer'],
      ['reply', 'inbound', 'peer'],
    ])
    expect(within(cards()[0]!).getByText('Replied').getAttribute('data-slot')).toBe('conversation-outcome')
    expect(within(cards()[1]!).getByRole('link', { name: 'RECEIVED from Schema task' })).toBeTruthy()
    const order = [...document.querySelectorAll('[data-slot="worker-conversation-card"], [data-slot="assistant-message"]')].map((node) => node.getAttribute('data-slot'))
    expect(order[0]).toBe('worker-conversation-card')
    expect(order.at(-1)).toBe('worker-conversation-card')
  })

  it('shows the deleted outcome on its request card', () => {
    renderThread([
      { type: 'conversation-message', message: peerRequest, delivery: 'delivered' },
      { type: 'request-outcome', outcome: { requestId, status: 'deleted', observedAt: '2026-10-28T12:05:00.000Z' } },
    ])
    expect(within(cards()[0]!).getByText('Recipient deleted').getAttribute('data-slot')).toBe('conversation-outcome')
  })

  it('looks up a peer the run list does not carry and links it once it loads', () => {
    lookup.answer = { data: { id: peer, title: 'Archived schema task' }, isPending: false, error: null }
    renderThread([{ type: 'conversation-message', message: peerRequest, delivery: 'delivered' }], { [self]: 'Coordinator' })
    expect(lookup.ids).toContain(peer)
    expect(screen.getByRole('link', { name: 'SENT to Archived schema task' }).getAttribute('href')).toBe(`/p/acme/tasks/${peer}`)
  })

  it('does not look up a peer the run list already names', () => {
    renderThread([{ type: 'conversation-message', message: peerRequest, delivery: 'delivered' }])
    expect(lookup.ids).toEqual([])
  })

  it.each([
    ['is still loading', { data: undefined, isPending: true, error: null }, 'Peer task'],
    ['was deleted', { data: undefined, isPending: false, error: new ApiError(404, 'Run not found') }, 'Deleted task'],
    ['cannot be read', { data: undefined, isPending: false, error: new ApiError(0, 'offline') }, 'Task unavailable'],
  ] as const)('reads honestly when the peer %s: its name, with no link', (_case, answer, name) => {
    lookup.answer = answer
    renderThread([{ type: 'conversation-message', message: peerRequest, delivery: 'delivered' }], { [self]: 'Coordinator' })
    const [card] = cards()
    expect(within(card!).queryByRole('link')).toBeNull()
    expect(within(card!).getByText(name)).toBeTruthy()
    expect(card!.textContent).not.toContain(peer)
  })

  it('names the peer, not "Task", on the link to a request or reply in the same thread', () => {
    renderThread([
      { type: 'conversation-message', message: peerRequest, delivery: 'delivered' },
      { type: 'conversation-message', message: peerReply, delivery: 'delivered' },
    ])
    expect(within(cards()[1]!).getByRole('button', { name: /View request to Schema task/ })).toBeTruthy()
    expect(within(cards()[0]!).getByRole('button', { name: /View reply from Schema task/ })).toBeTruthy()
  })

  it('explains a peer that cannot be resumed with the peer wording, not the parent-worker one', () => {
    renderThread([{ type: 'conversation-message', message: { ...peerRequest, state: 'continuation-required' }, delivery: 'not-delivered' }])
    const [card] = cards()
    expect(card!.textContent).toContain('Only its human can continue it')
    expect(card!.textContent).not.toContain('owned worker')
  })

  it('keeps the parent-worker resume guidance on a worker card', () => {
    renderThread([{ type: 'conversation-message', message: { ...peerRequest, relationship: undefined, recipientRunId: worker, state: 'continuation-required' }, delivery: 'not-delivered' }],
      { [self]: 'Coordinator', [worker]: 'Worker' })
    expect(cards()[0]!.textContent).toContain('A parent can resume its owned worker')
  })

  it('keeps the instruction the server sent for an undelivered peer message', () => {
    renderThread([{ type: 'conversation-message', message: { ...peerRequest, state: 'continuation-required', instruction: 'Not delivered: task is done. Only its human can continue it.' }, delivery: 'not-delivered' }])
    expect(screen.getByText('Not delivered: task is done. Only its human can continue it.')).toBeTruthy()
  })

  it('keeps a worker card a worker card, beside a peer card', () => {
    renderThread([
      { type: 'conversation-message', message: { ...peerRequest, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', recipientRunId: worker, relationship: undefined }, delivery: 'delivered' },
      { type: 'conversation-message', message: peerRequest, delivery: 'delivered' },
    ], { [self]: 'Coordinator', [peer]: 'Schema task', [worker]: 'Worker' })
    const [workerCard, peerCard] = cards()
    expect(workerCard!.getAttribute('data-relationship')).toBe('family')
    expect(workerCard!.className).toContain('message-outbound')
    expect(within(workerCard!).queryByText('Peer')).toBeNull()
    expect(peerCard!.getAttribute('data-relationship')).toBe('peer')
  })

  it('R1: a peer message beside an open question is a peer card, never a user message', () => {
    renderThread([
      { type: 'ask.requested', requestId: 'ask_1', questions: [{ header: 'Proceed?', question: 'Proceed?', options: [] }] },
      { type: 'agent-input', input: {
        id: replyId, text: 'Wave 2 is merged.', parentRunId: peer, createdAt: peerReply.createdAt,
        conversation: { senderRunId: peer, recipientRunId: self, kind: 'progress', relationship: 'peer' },
        // An `AgentInput` origin, not a wait source.
        // ast-grep-ignore: test-enum-literal-tsx
        source: 'agent',
      } },
    ])
    expect(document.querySelector('[data-slot="user-bubble"]')).toBeNull()
    const [card] = cards()
    expect(card!.getAttribute('data-relationship')).toBe('peer')
    expect(within(card!).getByText('Peer')).toBeTruthy()
    fireEvent.click(within(card!).getByRole('button', { name: 'Details' }))
    expect(within(card!).getByText('Relationship:', { exact: false })).toBeTruthy()
  })
})
