import { useMemo, type ReactNode } from 'react'
import { useInRouterContext, useParams } from 'react-router'
import { TaskFileContext } from './file-links'

export function TaskFileScope({ runId, children }: { runId: string; children: ReactNode }) {
  const routed = useInRouterContext()
  const value = useMemo(() => ({ runId }), [runId])
  return routed ? <ScopedTaskFiles runId={runId}>{children}</ScopedTaskFiles> : <TaskFileContext.Provider value={value}>{children}</TaskFileContext.Provider>
}
function ScopedTaskFiles({ runId, children }: { runId: string; children: ReactNode }) {
  // File links use the run’s route owner, never ambient viewer scope.
  // A route without a project stays unscoped so owner resolution remains possible.
  const { projectId } = useParams<{ projectId?: string | undefined }>()
  const value = useMemo(() => ({ runId, ...(projectId ? { projectId } : {}) }), [runId, projectId])
  return <TaskFileContext.Provider value={value}>{children}</TaskFileContext.Provider>
}
