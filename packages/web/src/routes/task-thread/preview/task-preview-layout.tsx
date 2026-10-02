import { useMemo } from 'react'
import { Outlet, useParams } from 'react-router'

import { useHealth, useRun } from '@/api/queries'

import { PreviewSplit } from './preview-split'
import { PreviewPaneContext, usePreviewPaneState, worktreeRemoved } from './preview-state'

/**
 * The layout every task tab sits in (#781). It owns the preview pane's state and the split, so
 * the header toggle shows on Session, Changes, Files, Commits and the issue and PR tabs alike,
 * and the pane survives switching between them.
 *
 * The tree is the same whether or not the pane exists: the tab's route keeps its place in it, so
 * turning the feature on, or opening the pane, never remounts the page the owner is reading.
 */
export function TaskPreviewLayout() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  const enabled = useHealth().data?.capabilities?.preview === true
  // One pane per task: another task starts with it closed. Only the pane state resets, so moving
  // between tasks never remounts the tab (the run header keeps its per-run state across it).
  const pane = usePreviewPaneState(id)
  const removed = run.data ? worktreeRemoved(run.data) : false
  const value = useMemo(() => ({ ...pane, worktreeRemoved: removed }), [pane, removed])
  return (
    <PreviewPaneContext.Provider value={enabled ? value : null}>
      <PreviewSplit run={enabled ? run.data : undefined} state={pane}>
        <Outlet />
      </PreviewSplit>
    </PreviewPaneContext.Provider>
  )
}
