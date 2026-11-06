import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import { useTitleEditor, type TitleEditor } from '@/components/editable-title'
import { runTitle } from '@/lib/task-groups'

/** Publish only to the old and new editing rows, never to every mounted title. */
function createTitleStore(begin: (run: RunSummary) => void) {
  const listeners = new Map<string, Set<() => void>>()
  const selectionListeners = new Set<() => void>()
  let selected: { id: string; editor: TitleEditor } | undefined
  return {
    begin,
    editingId: () => selected?.id ?? null,
    subscribeSelection(listener: () => void) {
      selectionListeners.add(listener)
      return () => { selectionListeners.delete(listener) }
    },
    snapshot: (id: string) => selected?.id === id ? selected.editor : null,
    subscribe(id: string, listener: () => void) {
      let row = listeners.get(id)
      if (!row) { row = new Set(); listeners.set(id, row) }
      row.add(listener)
      return () => { row.delete(listener); if (!row.size) listeners.delete(id) }
    },
    publish(id: string | undefined, editor: TitleEditor) {
      const previous = selected?.id
      selected = id && editor.editing ? { id, editor } : undefined
      if (previous !== selected?.id) for (const listener of selectionListeners) listener()
      for (const changed of new Set([previous, selected?.id])) {
        if (changed) for (const listener of listeners.get(changed) ?? []) listener()
      }
    },
  }
}
const TaskTitleEditingContext = createContext<ReturnType<typeof createTitleStore> | null>(null)
const inactiveEditor: TitleEditor = { editing: false, draft: '', begin() {}, setDraft() {}, commit() {}, cancel() {} }

/** Own the draft above responsive rows; the context itself stays stable while typing. */
export function TaskTitleEditorProvider({ children, runs, onRename }: {
  children: ReactNode
  runs: readonly RunSummary[]
  onRename: (id: string, title: string) => void
}) {
  const [selection, setSelection] = useState<{ run: RunSummary }>()
  const [store] = useState(() => createTitleStore((run) => setSelection({ run })))
  const run = runs.find((candidate) => candidate.id === selection?.run.id)
  const editor = useTitleEditor(run ? runTitle(run) : '', (next) => {
    if (run) onRename(run.id, next)
  })
  useEffect(() => {
    if (selection) editor.begin()
    // A new selection, including the same id, starts from the current row summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])
  useEffect(() => {
    if (selection && !run) { editor.cancel(); setSelection(undefined) }
  }, [selection, run, editor])
  useLayoutEffect(() => { store.publish(run?.id, editor) }, [store, run?.id, editor])
  return <TaskTitleEditingContext value={store}>{children}</TaskTitleEditingContext>
}

export function useTaskTitleEditor(run: RunSummary): TitleEditor {
  const store = useContext(TaskTitleEditingContext)
  if (!store) throw new Error('Task title editor needs its page provider')
  const subscribe = useCallback((listener: () => void) => store.subscribe(run.id, listener), [store, run.id])
  const snapshot = useCallback(() => store.snapshot(run.id), [store, run.id])
  const editor = useSyncExternalStore(subscribe, snapshot) ?? inactiveEditor
  return { ...editor, begin: () => store.begin(run) }
}

const noSelection = () => null
function noSubscription() { return noUnsubscribe }
function noUnsubscribe() { return undefined }
/** Lists pin an active draft independently of keyboard focus. No provider on global rows. */
export function useTaskEditingRunId(): string | null {
  const store = useContext(TaskTitleEditingContext)
  return useSyncExternalStore(store?.subscribeSelection ?? noSubscription, store?.editingId ?? noSelection)
}
