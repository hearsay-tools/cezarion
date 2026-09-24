import { useMemo, type ReactNode } from 'react'
import { useInRouterContext } from 'react-router'
import { useActiveProjectId } from '@/lib/project-router'
import { TaskFileContext } from './file-links'

export function TaskFileScope({ runId, children }: { runId: string; children: ReactNode }) {
  const routed = useInRouterContext()
  const value = useMemo(() => ({ runId }), [runId])
  return routed ? <ScopedTaskFiles runId={runId}>{children}</ScopedTaskFiles> : <TaskFileContext.Provider value={value}>{children}</TaskFileContext.Provider>
}
function ScopedTaskFiles({ runId, children }: { runId: string; children: ReactNode }) {
  const projectId = useActiveProjectId()
  const value = useMemo(() => ({ runId, ...(projectId ? { projectId } : {}) }), [runId, projectId])
  return <TaskFileContext.Provider value={value}>{children}</TaskFileContext.Provider>
}
