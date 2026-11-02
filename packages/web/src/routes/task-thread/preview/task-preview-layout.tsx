import { lazy, Suspense, useMemo, type ReactNode } from 'react'
import { Outlet, useLocation, useParams } from 'react-router'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import { useHealth, useRun } from '@/api/queries'

import { useReportSource } from '../report-source'
import { ReportCardSourcesContext, useConversationReport } from '../report-selection'

import { PreviewSplit } from './preview-split'
import { PreviewPaneContext, usePreviewPaneState, worktreeRemoved, type PreviewPaneState } from './preview-state'
import { useAgentPageLive } from './use-agent-page-live'

const ReportReader = lazy(() => import('../../task-git/report-reader').then(module => { return { default: module.ReportReader } }))

/** A stable split keeps the conversation mounted while reports and live preview share the pane.
 * Reports work at shipped defaults; only live preview reads the opt-in event stream. */
export function TaskPreviewLayout() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  const location = useLocation()
  const enabled = useHealth().data?.capabilities?.preview === true
  // One pane per task: another task starts from its own saved pane (hearsay-tools/cezarion#2077),
  // else closed. Only the pane state resets, so moving between tasks never remounts the tab (the
  // run header keeps its per-run state across it).
  const removed = run.data ? worktreeRemoved(run.data) : false
  const pane = usePreviewPaneState(id, removed)
  const report = useConversationReport(id)
  const source = useReportSource(id, report.selection?.artifactId, report.sourceRunId)
  const reader = report.selection ? <Suspense fallback={<p role="status">Loading report…</p>}>
    <ReportReader key={`${id}:${report.selection.artifactId}`} runId={source.data ?? id ?? ''}
      selection={{ artifactId: report.selection.artifactId }} fragment={location.hash} onBack={report.close} variant="pane" sourceLookup={source} />
  </Suspense> : undefined
  const content = enabled ? <PreviewProvider id={id} run={run.data} pane={pane} removed={removed} report={reader}><Outlet /></PreviewProvider>
    : <PreviewSplit run={run.data} state={{ ...pane, open: false }} report={reader}><Outlet /></PreviewSplit>
  return <ReportCardSourcesContext.Provider value={report.registry}>{content}</ReportCardSourcesContext.Provider>
}


/** Only with the feature on does the task view read its events for the agent's page. */
function PreviewProvider({ id, run, pane, removed, children, report }: {
  id: string | undefined
  run: ApiRun | undefined
  pane: PreviewPaneState
  removed: boolean
  children: ReactNode
  report: ReactNode
}) {
  const agentLive = useAgentPageLive(id)
  const value = useMemo(() => ({ ...pane, worktreeRemoved: removed, agentLive }), [pane, removed, agentLive])
  return (
    <PreviewPaneContext.Provider value={value}>
      <PreviewSplit run={run} state={pane} report={report}>
        {children}
      </PreviewSplit>
    </PreviewPaneContext.Provider>
  )
}
