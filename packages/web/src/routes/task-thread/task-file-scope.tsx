import { useMemo, type ReactNode } from 'react'
import { useInRouterContext, useParams } from 'react-router'
import { TaskFileContext } from './file-links'

export function TaskFileScope({ runId, children }: { runId: string; children: ReactNode }) {
  const routed = useInRouterContext()
  const value = useMemo(() => ({ runId }), [runId])
  return routed ? <ScopedTaskFiles runId={runId}>{children}</ScopedTaskFiles> : <TaskFileContext.Provider value={value}>{children}</TaskFileContext.Provider>
}
function ScopedTaskFiles({ runId, children }: { runId: string; children: ReactNode }) {
  // The project stamped into file links is the run's OWNER — the project whose `/p/:projectId`
  // route matched, the only store that can be serving the run being rendered (#925). Never the
  // ambient viewer scope (`useActiveProjectId`'s context-or-URL): a shell mounted above the
  // wrong provider or a soft navigation in flight can leave that naming a project that does not
  // own the run, and its links then 404 (`/p/squeal/tasks/<cezar-run>/…`). A route that names no
  // project stays unscoped on purpose: a flat link is resolvable by owner, a wrong one is not.
  const { projectId } = useParams<{ projectId?: string }>()
  const value = useMemo(() => ({ runId, ...(projectId ? { projectId } : {}) }), [runId, projectId])
  return <TaskFileContext.Provider value={value}>{children}</TaskFileContext.Provider>
}
