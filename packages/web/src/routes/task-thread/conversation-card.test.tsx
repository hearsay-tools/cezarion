import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'
import { WorkerConversationGroup } from './conversation-card'
import type { ThreadConversationMessage } from './thread-state'

const at = '2026-10-30T12:00:00.000Z'
const message = (extra: Partial<ThreadConversationMessage> = {}): ThreadConversationMessage => ({
  kind: 'conversation', id: 'event-1', messageId: 'message-1', text: 'Check the parser',
  senderRunId: 'parent', recipientRunId: 'worker', messageKind: 'request', delivery: 'delivered',
  ...extra,
})
function show(messages: ThreadConversationMessage[]) {
  return render(<MemoryRouter><WorkerConversationGroup runId="parent" taskTitles={{ worker: 'Worker', other: 'Other' }} block={{
    kind: 'worker-conversation', id: 'block', batches: [{
      id: 'batch', kind: messages[0]?.messageKind ?? 'request', text: 'Check the parser', senderRunId: 'parent', messages,
    }],
  }} /></MemoryRouter>)
}
afterEach(cleanup)

it('shows every recorded envelope field in the inspection details', () => {
  show([message({ relationship: 'peer', requestId: 'request-1', outcome: { status: 'replied', replyId: 'reply-1' },
    state: 'accepted', createdAt: at, deliveredAt: at, recordedAt: at, resumed: true, deadline: at, requestHash: 'hash-1' })])
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  const rows = [...document.querySelectorAll('dl > div')].filter(row => row.querySelector('dt'))
  expect(rows.map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])).toEqual([
    ['Message: ', 'message-1'], ['Sender: ', 'parent'], ['Recipient: ', 'worker'], ['Relationship: ', 'peer'],
    ['Delivery: ', 'Delivered'], ['Request: ', 'request-1'], ['Reply: ', 'reply-1'], ['State: ', 'accepted'],
    ['Created: ', at], ['Opening turn completed: ', at], ['Event recorded: ', at],
    ['Continuation: ', 'Requested by parent with this instruction'], ['Deadline: ', at], ['Hash: ', 'hash-1'],
  ])
})

it('omits absent envelope fields and labels an ordinary delivery acknowledgement', () => {
  show([message({ deliveredAt: at })])
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  const rows = [...document.querySelectorAll('dl > div')].filter(row => row.querySelector('dt'))
  expect(rows.map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])).toEqual([
    ['Message: ', 'message-1'], ['Sender: ', 'parent'], ['Recipient: ', 'worker'], ['Delivery: ', 'Delivered'],
    ['Delivery acknowledged: ', at],
  ])
})

it('shows a first-send label only for a batch and links each distinct recipient once in its heading', () => {
  show([message({ createdAt: at }), message({ id: 'event-2', messageId: 'message-2', recipientRunId: 'other', createdAt: at }),
    message({ id: 'event-3', messageId: 'message-3', createdAt: at })])
  expect(screen.getByText('First sent')).toBeTruthy()
  expect(screen.getAllByRole('link', { name: /SENT to/ }).map(link => link.getAttribute('href'))).toEqual(['/tasks/worker', '/tasks/other'])
  expect(screen.getAllByRole('link', { name: /^(Worker|Other)$/ }).map(link => link.getAttribute('href'))).toEqual(['/tasks/worker', '/tasks/other', '/tasks/worker'])
  fireEvent.click(screen.getByRole('button', { name: 'Show message' }))
  expect(screen.getByText('Check the parser')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Hide message' }))
  expect(screen.queryByText('Check the parser')).toBeNull()
})

it.each([undefined, 'invalid', at])('renders a single message with timestamp %s without a batch label', createdAt => {
  show([message(createdAt === undefined ? {} : { createdAt })])
  expect(screen.queryByText('First sent')).toBeNull()
  expect(document.querySelectorAll('time')).toHaveLength(createdAt === at ? 1 : 0)
  expect(screen.queryByText(/outside loaded history/)).toBeNull()
})

it('renders an empty batch without inventing a recipient or timestamp', () => {
  show([])
  expect(screen.queryByRole('link')).toBeNull()
  expect(document.querySelector('time')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show message' }))
  expect(screen.getByText('Check the parser')).toBeTruthy()
})
