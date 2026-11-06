import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TitleEditInput } from '@/components/editable-title'
import { run, setOverviewDesktop } from '@/routes/tasks-overview.testkit'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from '@/api/query-client'
import { MemoryRouter } from 'react-router'
import { TasksOverview } from '@/routes/tasks-overview'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import { TaskTitleEditorProvider, useTaskTitleEditor } from './task-title-editor'

afterEach(cleanup)

function Row({ task, onRender }: { task: RunSummary; onRender?: (id: string) => void }) {
  onRender?.(task.id)
  const editor = useTaskTitleEditor(task)
  return <div>
    <button onClick={editor.begin}>Rename {task.id}</button>
    {editor.editing ? <TitleEditInput editor={editor} /> : null}
  </div>
}

it('starts a repeated edit from the current archived-page summary', () => {
  const saved = vi.fn()
  function Page() {
    const [task, setTask] = useState(run({ id: 'older', title: 'Old title', archived: true }))
    return <TasksOverview runs={[]} view="archived" onViewChange={vi.fn()} onArchiveFinished={vi.fn()} onMarkAllRead={vi.fn()}
      archivedPages={{ runs: [task], query: '', hasMore: false, loading: false, onLoadMore: vi.fn() }}
      onRename={(id, title) => { saved(id, title); setTask({ ...task, title }) }} />
  }
  setOverviewDesktop(true)
  render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><Page /></MemoryRouter></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Saved title' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task title' }), { key: 'Enter' })
  expect(saved).toHaveBeenCalledExactlyOnceWith('older', 'Saved title')
  fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
  expect((screen.getByRole('textbox', { name: 'Task title' }) as HTMLInputElement).value).toBe('Saved title')
})

it('does not render other title cells when the selected row draft changes', () => {
  const tasks = [run({ id: 'editing' }), run({ id: 'untouched' })]
  const commits = vi.fn()
  render(<TaskTitleEditorProvider runs={tasks} onRename={vi.fn()}>
    {tasks.map((task) => <Row key={task.id} task={task} onRender={commits} />)}
  </TaskTitleEditorProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Rename editing' }))
  commits.mockClear()
  fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Draft' } })
  expect(commits.mock.calls.map(([id]) => id)).toContain('editing')
  expect(commits.mock.calls.map(([id]) => id)).not.toContain('untouched')
})

it('drops a removed task draft instead of restoring it when the task returns', () => {
  const task = run({ id: 'removed', title: 'Current title' })
  const saved = vi.fn()
  function Page() {
    const [tasks, setTasks] = useState([task])
    return <TaskTitleEditorProvider runs={tasks} onRename={saved}>
      <button onClick={() => setTasks([])}>Remove task</button>
      <button onClick={() => setTasks([task])}>Restore task</button>
      {tasks.map((row) => <Row key={row.id} task={row} />)}
    </TaskTitleEditorProvider>
  }
  render(<Page />)
  fireEvent.click(screen.getByRole('button', { name: 'Rename removed' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Abandoned draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove task' }))
  expect(screen.queryByRole('textbox', { name: 'Task title' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Restore task' }))
  expect(screen.queryByRole('textbox', { name: 'Task title' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Rename removed' }))
  expect((screen.getByRole('textbox', { name: 'Task title' }) as HTMLInputElement).value).toBe('Current title')
  expect(saved).not.toHaveBeenCalled()
})
