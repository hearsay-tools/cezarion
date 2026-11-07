import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPreview } from '@/components/task-status-groups'
import { TaskRow } from './global-tasks'
import type { GlobalTask } from '@/lib/global-tasks'

vi.mock('@/components/task-status-groups', async (original) => ({
  ...await original<typeof import('@/components/task-status-groups')>(),
  TaskPreview: vi.fn(() => <div>Preview</div>),
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('skips unchanged summaries even when the index projection wrapper is recreated', () => {
  const task: GlobalTask = { run: { id: 'one', projectId: 'boot', title: 'First title', status: RUN_STATUS.running, createdAt: '2026-11-06T10:00:00Z', archived: false, workflow: 'quick-task', workflowLabel: 'Quick task', tokensUsed: 0 }, project: undefined, projectName: 'Boot', tags: [] }
  const onArchive = vi.fn(), onSetRead = vi.fn(), toggleExpandedRun = vi.fn()
  const row = (value: GlobalTask) => <MemoryRouter><TooltipProvider><TaskRow task={value} summary rowIndex={2} now={Date.parse('2026-11-06T10:01:00Z')} showProject resourcesOpen toggleExpandedRun={toggleExpandedRun} onArchive={onArchive} onSetRead={onSetRead} busy={false} showCost automationName={undefined} /></TooltipProvider></MemoryRouter>
  const view = render(row(task))
  expect(TaskPreview).toHaveBeenCalledTimes(1)
  view.rerender(row({ ...task }))
  expect(TaskPreview).toHaveBeenCalledTimes(1)
  view.rerender(row({ ...task, run: { ...task.run, title: 'Updated title' } }))
  expect(TaskPreview).toHaveBeenCalledTimes(2)
})
