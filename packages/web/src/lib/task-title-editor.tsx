import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import { useTitleEditor, type TitleEditor } from '@/components/editable-title'
import { runTitle } from '@/lib/task-groups'

type TaskTitleEditing = {
  runId: string | undefined
  editor: TitleEditor
  begin: (run: RunSummary) => void
}

const TaskTitleEditingContext = createContext<TaskTitleEditing | null>(null)

/** Own the draft above the responsive rows, which unmount at a breakpoint. */
export function TaskTitleEditorProvider({ children, runs, onRename }: {
  children: ReactNode
  runs: readonly RunSummary[]
  onRename: (id: string, title: string) => void
}) {
  const [run, setRun] = useState<RunSummary>()
  const currentRun = runs.find((candidate) => candidate.id === run?.id) ?? run
  const editor = useTitleEditor(currentRun ? runTitle(currentRun) : '', (next) => {
    if (run) onRename(run.id, next)
  })
  useEffect(() => {
    if (run) editor.begin()
    // Selecting another run starts its editor after its title reaches the shared machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])
  const begin = (next: RunSummary) => {
    if (next.id === run?.id) editor.begin()
    else setRun(next)
  }
  return <TaskTitleEditingContext value={{ runId: run?.id, editor, begin }}>{children}</TaskTitleEditingContext>
}

export function useTaskTitleEditor(run: RunSummary): TitleEditor {
  const state = useContext(TaskTitleEditingContext)
  if (!state) throw new Error('Task title editor needs its page provider')
  return { ...state.editor, editing: state.runId === run.id && state.editor.editing, begin: () => state.begin(run) }
}
