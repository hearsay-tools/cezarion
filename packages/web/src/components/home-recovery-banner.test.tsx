import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HomeRecoveryFile } from '@open-mercato/cezar-api-client/contract/home-recovery'
import { useHomeRecovery } from '@/api/home-recovery'
import { useHealth } from '@/api/queries'
import { HomeRecoveryBanner } from './home-recovery-banner'

const actions = vi.hoisted(() => ({
  import: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
  restore: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
  accept: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
}))
vi.mock('@/api/home-recovery', () => ({
  useHomeRecovery: vi.fn(), useImportHomeRecovery: () => actions.import, useRestoreHomeRecovery: () => actions.restore, useAcceptHomeRecovery: () => actions.accept,
}))
vi.mock('@/api/queries', () => ({ useHealth: vi.fn() }))

function state(files: HomeRecoveryFile[], status: 'ready' | 'pending' | 'error' = 'ready') {
  vi.mocked(useHomeRecovery).mockReturnValue({ data: { files }, isSuccess: status === 'ready',
    isError: status === 'error' } as ReturnType<typeof useHomeRecovery>)
}
function file(name: string, reason: HomeRecoveryFile['reason'] = 'reset', canRestore = true): HomeRecoveryFile {
  const common = { file: name, detectedAt: '2026-11-07T09:00:00.000Z', canRestore }
  return reason === 'legacy-change' ? { ...common, reason, canImport: true } : { ...common, reason }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const action of Object.values(actions)) { action.isPending = false; action.error = null }
  state([])
  vi.mocked(useHealth).mockReturnValue({ data: { capabilities: { localHandoff: true } } } as ReturnType<typeof useHealth>)
})
afterEach(cleanup)

it('shows no banner in a normal session and exposes the successful empty state', () => {
  const { container } = render(<HomeRecoveryBanner />)
  expect(container.querySelector('[data-slot="home-recovery-state"]')?.getAttribute('data-state')).toBe('ready')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(container.textContent).toBe('')
})

it('shows each reset with its approved copy and both recovery actions', () => {
  state([file('config.json'), file('agent-accounts.json')])
  render(<HomeRecoveryBanner />)
  const projects = screen.getByText('The project registry was reset. Restore the previous projects?').closest('[role="status"]')!
  const accounts = screen.getByText('The account list was reset. Restore the previous accounts?').closest('[role="status"]')!
  expect(screen.getAllByRole('status')).toHaveLength(2)
  expect(projects.getAttribute('aria-live')).toBe('polite')
  fireEvent.click(within(projects as HTMLElement).getByRole('button', { name: 'Restore' }))
  expect(actions.restore.mutate).toHaveBeenCalledWith({ file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' })
  fireEvent.click(within(accounts as HTMLElement).getByRole('button', { name: 'Accept as found' }))
  expect(actions.accept.mutate).toHaveBeenCalledWith({ file: 'agent-accounts.json', detectedAt: '2026-11-07T09:00:00.000Z' })
  expect(actions.restore.reset).toHaveBeenCalledTimes(2)
  expect(actions.accept.reset).toHaveBeenCalledTimes(2)
})

it('names the outside-written file and leaves accept available when no restore target is readable', () => {
  state([file('ui-state.json', 'outside-write', false)])
  render(<HomeRecoveryBanner />)
  expect(screen.getByText('ui-state.json changed outside Cezar. Restore the previous version or accept the file as found.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Accept as found' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Accept as found' }))
  expect(actions.accept.mutate).toHaveBeenCalledWith({ file: 'ui-state.json', detectedAt: '2026-11-07T09:00:00.000Z' })
})

it.each(['restore', 'accept'] as const)('disables both buttons while %s is in flight', action => {
  state([file('config.json')])
  actions[action].isPending = true
  render(<HomeRecoveryBanner />)
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
  for (const button of screen.getAllByRole('button')) {
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
  }
  expect(actions.restore.mutate).not.toHaveBeenCalled()
  expect(actions.accept.mutate).not.toHaveBeenCalled()
})

it.each(['restore', 'accept'] as const)('keeps a failed %s action error beside the available retry', action => {
  state([file('config.json')])
  actions[action].error = new Error('Saved version cannot be read')
  render(<HomeRecoveryBanner />)
  expect(screen.getByRole('alert').textContent).toBe('Saved version cannot be read')
  expect(screen.getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: 'Accept as found' }).hasAttribute('disabled')).toBe(false)
})

it.each(['pending', 'error'] as const)('does not invent a banner while the initial read is %s', status => {
  state([], status)
  const { container } = render(<HomeRecoveryBanner />)
  expect(container.querySelector('[data-slot="home-recovery-state"]')?.getAttribute('data-state')).toBe(status)
  expect(screen.queryByRole('status')).toBeNull()
  expect(container.textContent).toBe('')
})

it('shows remote incidents read-only with the host-operator instruction', () => {
  state([file('config.json'), file('remote-settings/4321.json', 'outside-write')])
  vi.mocked(useHealth).mockReturnValue({ data: { capabilities: { localHandoff: false, settingsAdmin: true } } } as ReturnType<typeof useHealth>)
  render(<HomeRecoveryBanner />)
  expect(screen.getAllByRole('status')).toHaveLength(2)
  expect(screen.getAllByText('Only the host operator can restore or accept this file.', { exact: false })).toHaveLength(2)
  expect(screen.queryByRole('button')).toBeNull()
  expect(actions.restore.mutate).not.toHaveBeenCalled()
  expect(actions.accept.mutate).not.toHaveBeenCalled()
})

it('keeps remote grants read-only even in the local cockpit and gives the host CLI command', () => {
  state([file('remote-settings/4321.json', 'outside-write')])
  render(<HomeRecoveryBanner />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('cez backup restore remote-settings/4321.json')).toBeTruthy()
  expect(screen.getByText('Only the host operator can restore or accept this file.', { exact: false })).toBeTruthy()
})

it.each(['pending', 'error'] as const)('keeps capability-dependent actions unset while health is %s', status => {
  state([file('config.json'), file('remote-settings/4321.json', 'outside-write')])
  vi.mocked(useHealth).mockReturnValue({ data: undefined, status } as ReturnType<typeof useHealth>)
  render(<HomeRecoveryBanner />)
  const rows = screen.getAllByRole('status')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.textContent).toBe('The project registry was reset. Restore the previous projects?')
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getAllByText('Only the host operator can restore or accept this file.', { exact: false })).toHaveLength(1)
  expect(screen.getByText('cez backup restore remote-settings/4321.json')).toBeTruthy()
})


it('offers Import and Ignore for a legacy change and explains the conflict winner', () => {
  state([file('config.json', 'legacy-change')])
  render(<HomeRecoveryBanner />)
  expect(screen.getByRole('status').textContent).toContain('Old-home changes win')
  fireEvent.click(screen.getByRole('button', { name: 'Import changes from the old home' }))
  expect(actions.import.mutate).toHaveBeenCalledWith({ file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' })
  fireEvent.click(screen.getByRole('button', { name: 'Ignore' }))
  expect(actions.accept.mutate).toHaveBeenCalledWith({ file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' })
})

it('keeps legacy changes read-only for remote sessions', () => {
  state([file('config.json', 'legacy-change')])
  vi.mocked(useHealth).mockReturnValue({ data: { capabilities: { localHandoff: false } } } as ReturnType<typeof useHealth>)
  render(<HomeRecoveryBanner />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('Only the host operator can import or ignore this file.')).toBeTruthy()
})

it.each([true, false])('gives host CLI actions for legacy grants with canImport=%s', canImport => {
  state([{ ...file('remote-settings/4321.json', 'legacy-change'), reason: 'legacy-change', canImport }])
  render(<HomeRecoveryBanner />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText(canImport ? 'Only the host operator can import or ignore this file.' : 'Only the host operator can ignore this file.', { exact: false })).toBeTruthy()
  expect(screen.getByText('cez backup ignore remote-settings/4321.json')).toBeTruthy()
  expect(screen.queryByText('cez backup import remote-settings/4321.json') !== null).toBe(canImport)
  expect(screen.queryByText('cez backup restore remote-settings/4321.json')).toBeNull()
})

it('offers only Ignore when a legacy file cannot be imported', () => {
  state([{ ...file('config.json', 'legacy-change'), reason: 'legacy-change', canImport: false }])
  render(<HomeRecoveryBanner />)
  expect(screen.queryByRole('button', { name: 'Import changes from the old home' })).toBeNull()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Ignore' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Ignore' }))
  expect(actions.accept.mutate).toHaveBeenCalledWith({ file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' })
  expect(actions.import.mutate).not.toHaveBeenCalled()
})
