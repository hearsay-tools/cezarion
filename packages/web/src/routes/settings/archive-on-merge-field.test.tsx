import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { ArchiveOnMergeField, TasksSection } from './archive-on-merge-field'
import { useConfig, useWorkspaceConfig } from '@/api/queries'
import { putConfig, putWorkspaceConfig } from '@/api/client'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { queryKeys } from '@/api/queries'

vi.mock('@/api/queries', async importOriginal => ({ ...await importOriginal<object>(), useConfig: vi.fn(), useWorkspaceConfig: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<object>(), putConfig: vi.fn(), putWorkspaceConfig: vi.fn() }))
const config = {
  archiveOnMerge: null, effectiveArchiveOnMerge: false, archiveOnMergeSource: 'default',
  baseBranch: null, defaultRunner: 'claude', systemPrompt: null, defaultModels: {}, modelsLocked: false,
  maxParallel: 2, memoryLimitMb: null, worktreeRetention: 10, liveTitleUpdates: null,
  reviewGate: null, worktreeSetup: null, worktreeSetupIssue: null,
} satisfies Awaited<ReturnType<typeof putConfig>>
function mount(global = false) {
  vi.mocked(useConfig).mockReturnValue({ isPending: false, isError: false, data: config } as ReturnType<typeof useConfig>)
  vi.mocked(useWorkspaceConfig).mockReturnValue({ isPending: false, isError: false, data: {
    archiveOnMerge: config.archiveOnMerge, effectiveArchiveOnMerge: config.effectiveArchiveOnMerge, archiveOnMergeSource: config.archiveOnMergeSource,
  } } as ReturnType<typeof useWorkspaceConfig>)
  return render(<QueryClientProvider client={createQueryClient()}>{global ? <TasksSection /> : <ArchiveOnMergeField />}</QueryClientProvider>)
}
afterEach(() => { cleanup(); vi.resetAllMocks(); setApiScope(null) })
it('shows effective inheritance and saves explicit project false and reset', async () => {
  vi.mocked(putConfig).mockResolvedValue(config as Awaited<ReturnType<typeof putConfig>>)
  mount()
  expect(screen.getByText(/Currently disabled.*default/i)).not.toBeNull()
  fireEvent.change(screen.getByLabelText('Archive tasks after PRs merge'), { target: { value: 'disabled' } })
  await waitFor(() => expect(putConfig).toHaveBeenCalledWith({ archiveOnMerge: false }, 'default'))
  await waitFor(() => expect((screen.getByLabelText('Archive tasks after PRs merge') as HTMLSelectElement).disabled).toBe(false))
  fireEvent.change(screen.getByLabelText('Archive tasks after PRs merge'), { target: { value: 'inherit' } })
  await waitFor(() => expect(putConfig).toHaveBeenLastCalledWith({ archiveOnMerge: null }, 'default'))
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
it('keeps a delayed project save in its originating cache after switching projects', async () => {
  setApiScope('a')
  const originKey = queryKeys.config
  const client = createQueryClient()
  vi.mocked(useConfig).mockReturnValue({ isPending: false, isError: false, data: config } as ReturnType<typeof useConfig>)
  let finish!: (value: Awaited<ReturnType<typeof putConfig>>) => void
  vi.mocked(putConfig).mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<QueryClientProvider client={client}><ArchiveOnMergeField /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('Archive tasks after PRs merge'), { target: { value: 'enabled' } })
  setApiScope('b')
  const destinationKey = queryKeys.config
  client.setQueryData(destinationKey, { ...config, baseBranch: 'b' })
  const saved = { ...config, archiveOnMerge: true, baseBranch: 'a' }
  finish(saved)
  await waitFor(() => expect(client.getQueryData(originKey)).toEqual(saved))
  expect(client.getQueryData(destinationKey)).toEqual({ ...config, baseBranch: 'b' })
  expect(putConfig).toHaveBeenCalledWith({ archiveOnMerge: true }, 'a')
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
