import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react'

import { API_PREFIX, getApiScope, setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'

/**
 * The React face of the project scope (multi-project spec, step 3.1): components read
 * `{projectId, apiBase}` from context; the module-level client seam (project-scope.ts) is kept
 * in sync by the provider. Step 3.2 mounts the provider from the `/p/:projectId` URL param —
 * until then nothing mounts it, the default below applies, and the app is byte-identical to the
 * single-project cockpit.
 */
export interface ProjectScope {
  /** The registered project id from the URL, or null when unscoped (the boot project). */
  projectId: string | null
  /** `/api/p/<id>` when scoped, `/api` when not — for the rare caller that builds URLs itself. */
  apiBase: string
}

const UNSCOPED: ProjectScope = { projectId: null, apiBase: API_PREFIX }

export const ProjectScopeContext = createContext<ProjectScope>(UNSCOPED)

/** The active scope. Outside a provider this is the unscoped default, not an error — that IS
 *  the boot project's normal state until 3.2 mounts the provider. */
export function useProjectScope(): ProjectScope {
  return useContext(ProjectScopeContext)
}

/**
 * Bind the module API scope before children derive query keys. Reassert after mount; reset only
 * on real unmount, never during a project-change cleanup.
 */
export function ProjectScopeProvider({
  projectId,
  children,
}: {
  projectId: string | null
  children: ReactNode
}) {
  if (getApiScope() !== projectId) setApiScope(projectId)

  useLayoutEffect(() => {
    setApiScope(projectId)
  }, [projectId])

  // Unmount only — see the note above on why this cannot be the cleanup of the effect above, and
  // why both are layout effects: destroys run before creates, so the re-created `[projectId]`
  // effect re-asserts the scope after this one nulled it, and the whole exchange happens in the
  // layout phase — before the passive effects where every request of the commit is made.
  useLayoutEffect(() => () => setApiScope(null), [])

  const value = useMemo<ProjectScope>(
    // Built from the same prefix the request path uses — the version is one fact, not two.
    () => (projectId === null ? UNSCOPED : { projectId, apiBase: `${API_PREFIX}/p/${encodeURIComponent(projectId)}` }),
    [projectId],
  )
  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>
}
