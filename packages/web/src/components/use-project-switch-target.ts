import * as React from 'react'

import { useProjects, useRunsIndex } from '@/api/queries'
import { projectSwitchTarget, readStoredProjectLocation } from '@/lib/last-location'

/**
 * The one resolver behind every "switch to project X" control (the rail, expanded and collapsed,
 * and the ⌘K Projects group): X's remembered page, or X's home. Storage is read when the resolver is called
 * (the rail renders it on every navigation, the palette on selection), so there is no subscription.
 */
export function useProjectSwitchTarget(indexEnabled = true): (projectId: string) => string {
  const registry = useProjects().data
  const index = useRunsIndex(indexEnabled).data
  return React.useCallback(
    (projectId: string) => {
      const runIds = index
        ? new Set(index.runs.filter((run) => run.projectId === projectId).map((run) => run.id))
        : undefined
      return projectSwitchTarget(projectId, readStoredProjectLocation(projectId), { registry, runIds })
    },
    [registry, index],
  )
}
