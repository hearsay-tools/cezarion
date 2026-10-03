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
 * With the feature on, the tree is the same whether or not the pane is open: the tab's route
 * keeps its place in it, so opening or closing the pane never remounts the page the owner is
 * reading. With the feature off (the default) the tab renders bare, with no split around it, so
 * the default task view lays out exactly as it did before live preview existed. With the flag on,
 * a cold load that renders before health arrives wraps the tab once when it does; the tab's data
 * comes from the query cache, so that one remount costs a render, not a fetch.
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
  if (!enabled) return <Outlet />
  return (
    <PreviewPaneContext.Provider value={value}>
      <PreviewSplit run={run.data} state={pane}>
        <Outlet />
      </PreviewSplit>
    </PreviewPaneContext.Provider>
  )
}
