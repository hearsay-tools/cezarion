import * as React from 'react'

import { useQueryClient } from '@tanstack/react-query'

import { useHealth, useProjects, useRunsIndex, workspaceQueryKeys } from '@/api/queries'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { signalsByProject, type ProjectSignal } from '@/lib/project-signal'

export type WorkspaceSignals = {
  projects: readonly ProjectListEntry[]
  /** Null while the runs index has not loaded: activity is then unknown, not idle. */
  signals: ReadonlyMap<string, ProjectSignal> | null
  /** Ids of the projects whose runs index hit its per-project cap. */
  truncated: ReadonlySet<string>
  /** `capabilities.singleProject` (`CEZ_SINGLE_PROJECT=1`). Never inferred from the project count. */
  singleProject: boolean
}

/**
 * The registry plus every project's four counts, read once for the whole shell. The desktop rail
 * and the mobile menu button and drawer all render from this one result, so they cannot disagree,
 * and the registry-change refresh below runs once, not once per surface.
 *
 * Every mark reads the SSE-patched workspace runs index — the current project's too. No WebSocket
 * topic: remote mode opens no browser WebSocket, and a WS-driven signal would go stale in hosted
 * cockpits. The index is observed at every width: the rail is `md`-up but the drawer's rows and
 * the menu button's pills are the phone's answer to "which project needs me".
 *
 * Null until the registry answers, so a shell without a QueryClient answer renders no project UI.
 */
export function useWorkspaceSignals(): WorkspaceSignals | null {
  const queryClient = useQueryClient()
  const projects = useProjects().data?.projects
  const index = useRunsIndex().data
  const singleProject = useHealth().data?.capabilities.singleProject === true
  const signals = React.useMemo(() => (index ? signalsByProject(index.runs) : null), [index])
  const truncated = React.useMemo(() => new Set(index?.truncated ?? []), [index?.truncated])

  // The index is refreshed by run events and reconnects, and none of those fire when the registry
  // changes. A project registered (or cloned, or removed) with runs already on disk would show no
  // signal until the next run event, so a change in WHICH projects exist asks for a fresh index.
  // Keyed on the id set so a rename or a `lastOpenedAt` bump does not refetch.
  const registry = projects?.map((project) => project.id).join('\n')
  const seenRegistry = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (registry === undefined) return
    // The first sighting is the index's own initial fetch; only a later change needs a refresh.
    if (seenRegistry.current !== undefined && seenRegistry.current !== registry) {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
    }
    seenRegistry.current = registry
  }, [queryClient, registry])

  return React.useMemo(
    () => (projects ? { projects, signals, truncated, singleProject } : null),
    [projects, signals, truncated, singleProject],
  )
}
