import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { PermissionCard } from './permission-card'
import type { ThreadPermission } from './thread-state'

const decide = vi.fn().mockResolvedValue({ delivered: true })
vi.mock('@/api/permissions', () => ({ usePermissionDecision: () => ({ mutateAsync: decide }) }))
afterEach(() => { cleanup(); decide.mockReset().mockResolvedValue({ delivered: true }); vi.restoreAllMocks() })
const permission: ThreadPermission = {
  kind: 'permission', id: 'permission:a', requestId: 'a', status: 'pending', title: 'Run this command?', details: `curl https://example.test/${'long/'.repeat(100)}\nFull command details`,
  options: [
    { id: 'once', label: 'Allow once', kind: 'allow_once' }, { id: 'always', label: 'Allow for session', kind: 'allow_always' },
    { id: 'reject', label: 'Reject once', kind: 'reject_once' }, { id: 'never', label: 'Reject always', kind: 'reject_always' },
    { id: 'rule', label: 'Allow this exact command with a very long descriptive rule', kind: 'allow_always' },
  ],
}
const card = (extra: Partial<ThreadPermission> = {}, sessionOpen = true) => <PermissionCard permission={{ ...permission, ...extra }} runId="r1" sessionOpen={sessionOpen} />

describe('PermissionCard', () => {
  it('shows full details and every offered option with wrapping and 44px targets', () => {
    render(card())
    expect(screen.getByText(permission.details!, { normalizer: text => text })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(5)
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11')
      expect(button.className).toContain('whitespace-normal')
    }
    expect(screen.queryByRole('textbox')).toBeNull()
  })
  it('submits the exact IDs, disables concurrent clicks, and shows the delivered choice', async () => {
    let deliver!: () => void
    decide.mockImplementationOnce(() => new Promise(resolve => { deliver = () => resolve({ delivered: true }) }))
    render(card())
    fireEvent.click(screen.getByRole('button', { name: 'Reject once' }))
    expect(decide).toHaveBeenCalledWith({ requestId: 'a', optionId: 'reject' })
    expect(screen.getByRole('status').textContent).toContain('Sending')
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    deliver()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Reject once'))
    expect(decide).toHaveBeenCalledTimes(1)
  })
  it('shows a delivery error and allows retry of an offered choice', async () => {
    decide.mockRejectedValueOnce(new ApiError(503, 'Provider unavailable'))
    render(card())
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Provider unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Decision sent'))
  })
  it('expires a stale 409 without starting a continuation or retrying', async () => {
    decide.mockRejectedValueOnce(new ApiError(409, 'Approval expired'))
    render(card())
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('expired'))
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(/Continue|reopen/)).toBeNull()
  })
  it('disables all choices offline and restores them after reconnect', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(card())
    expect(screen.getByRole('status').textContent).toContain('Offline')
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(true)
    online.mockReturnValue(true)
    fireEvent(window, new Event('online'))
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('shows expired disabled choices when the session closes, even with a stale pending request', () => {
    const { rerender } = render(card())
    rerender(card({}, false))
    expect(screen.getByRole('status').textContent).toContain('expired')
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(decide).not.toHaveBeenCalled()
  })
  it('renders the resolved choice and keeps it disabled', () => {
    render(card({ status: 'resolved', optionId: 'always' }, false))
    expect(screen.getByRole('status').textContent).toContain('Allow for session')
    expect((screen.getByRole('button', { name: 'Allow for session' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
