import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { ArchiveOnMergeField, TasksSection } from './archive-on-merge-field'
import { useConfig, useWorkspaceConfig } from '@/api/queries'
import { putConfig, putWorkspaceConfig } from '@/api/client'

vi.mock('@/api/queries', async importOriginal => ({ ...await importOriginal<object>(), useConfig: vi.fn(), useWorkspaceConfig: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<object>(), putConfig: vi.fn(), putWorkspaceConfig: vi.fn() }))
const config = { archiveOnMerge: null, effectiveArchiveOnMerge: false, archiveOnMergeSource: 'default' }
function mount(global = false) {
  vi.mocked(useConfig).mockReturnValue({ isPending: false, isError: false, data: config } as ReturnType<typeof useConfig>)
  vi.mocked(useWorkspaceConfig).mockReturnValue({ isPending: false, isError: false, data: config } as ReturnType<typeof useWorkspaceConfig>)
  return render(<QueryClientProvider client={createQueryClient()}>{global ? <TasksSection /> : <ArchiveOnMergeField />}</QueryClientProvider>)
}
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('shows effective inheritance and saves explicit project false and reset', async () => {
  vi.mocked(putConfig).mockResolvedValue(config as Awaited<ReturnType<typeof putConfig>>)
  mount()
  expect(screen.getByText(/Currently disabled.*default/i)).not.toBeNull()
  fireEvent.change(screen.getByLabelText('Archive tasks after PRs merge'), { target: { value: 'disabled' } })
  await waitFor(() => expect(putConfig).toHaveBeenCalledWith({ archiveOnMerge: false }))
  await waitFor(() => expect((screen.getByLabelText('Archive tasks after PRs merge') as HTMLSelectElement).disabled).toBe(false))
  fireEvent.change(screen.getByLabelText('Archive tasks after PRs merge'), { target: { value: 'inherit' } })
  await waitFor(() => expect(putConfig).toHaveBeenLastCalledWith({ archiveOnMerge: null }))
})
it('saves global preference and reports a failed write without changing selection', async () => {
  vi.mocked(putWorkspaceConfig).mockRejectedValue(new Error('disk is read-only'))
  mount(true)
  fireEvent.change(screen.getByLabelText('Archive tasks after PRs merge'), { target: { value: 'enabled' } })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk is read-only'))
  expect((screen.getByLabelText('Archive tasks after PRs merge') as HTMLSelectElement).value).toBe('inherit')
  expect(putWorkspaceConfig).toHaveBeenCalledWith({ archiveOnMerge: true })
})
it('disables the control until a save settles', async () => {
  vi.mocked(putConfig).mockReturnValue(new Promise(() => {}))
  mount()
  fireEvent.change(screen.getByLabelText('Archive tasks after PRs merge'), { target: { value: 'enabled' } })
  await waitFor(() => expect((screen.getByLabelText('Archive tasks after PRs merge') as HTMLSelectElement).disabled).toBe(true))
  expect(screen.getByRole('status').textContent).toContain('Saving')
})
it('renders loading and load failure explicitly', () => {
  vi.mocked(useWorkspaceConfig).mockReturnValue({ isPending: true } as ReturnType<typeof useWorkspaceConfig>)
  const client = createQueryClient()
  const result = render(<QueryClientProvider client={client}><TasksSection /></QueryClientProvider>)
  expect(screen.getByRole('status').textContent).toContain('Loading')
  vi.mocked(useWorkspaceConfig).mockReturnValue({ isPending: false, isError: true, error: new Error('offline') } as ReturnType<typeof useWorkspaceConfig>)
  result.rerender(<QueryClientProvider client={client}><TasksSection /></QueryClientProvider>)
  expect(screen.getByRole('alert').textContent).toContain('offline')
})
