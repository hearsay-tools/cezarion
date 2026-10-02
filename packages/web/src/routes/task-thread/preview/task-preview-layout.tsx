import { Outlet, useParams } from 'react-router'

import { useHealth, useRun } from '@/api/queries'

import { PreviewSplit } from './preview-split'
import { PreviewPaneContext, usePreviewPaneState } from './preview-state'

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
  // One pane per task: another task starts with it closed.
  return <TaskPreviewScope key={id} id={id} />
}

function TaskPreviewScope({ id }: { id: string | undefined }) {
  const run = useRun(id)
  const enabled = useHealth().data?.capabilities?.preview === true
  const pane = usePreviewPaneState()
  return (
    <PreviewPaneContext.Provider value={enabled ? pane : null}>
      <PreviewSplit run={enabled ? run.data : undefined} state={pane}>
        <Outlet />
      </PreviewSplit>
    </PreviewPaneContext.Provider>
  )
}
