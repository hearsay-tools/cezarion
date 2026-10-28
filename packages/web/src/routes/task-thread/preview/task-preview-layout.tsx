import { useMemo, type ReactNode } from 'react'
import { Outlet, useParams } from 'react-router'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import { useHealth, useRun } from '@/api/queries'

import { PreviewSplit } from './preview-split'
import { PreviewPaneContext, usePreviewPaneState, worktreeRemoved, type PreviewPaneState } from './preview-state'
import { useAgentPageLive } from './use-agent-page-live'

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
  // One pane per task: another task starts from its own saved pane (hearsay-tools/cezarion#2077),
  // else closed. Only the pane state resets, so moving between tasks never remounts the tab (the
  // run header keeps its per-run state across it).
  const pane = usePreviewPaneState(id)
  if (!enabled) return <Outlet />
  return (
    <PreviewProvider id={id} run={run.data} pane={pane}>
      <Outlet />
    </PreviewProvider>
  )
}

/** Only with the feature on does the task view read its events for the agent's page. */
function PreviewProvider({ id, run, pane, children }: { id: string | undefined; run: ApiRun | undefined; pane: PreviewPaneState; children: ReactNode }) {
  const removed = run ? worktreeRemoved(run) : false
  const agentLive = useAgentPageLive(id)
  // A saved pane does not come back on a task whose worktree is gone; the saved state stays, for a
  // Continue that restores the worktree. The toggle still opens the pane on purpose.
  const shown = useMemo(() => (removed && pane.request?.restored ? { ...pane, open: false } : pane), [pane, removed])
  const value = useMemo(() => ({ ...shown, worktreeRemoved: removed, agentLive }), [shown, removed, agentLive])
  return (
    <PreviewPaneContext.Provider value={value}>
      <PreviewSplit run={run} state={shown}>
        {children}
      </PreviewSplit>
    </PreviewPaneContext.Provider>
  )
}
