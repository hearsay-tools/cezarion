import * as React from 'react'

import { useQueryClient } from '@tanstack/react-query'

import { useProjects, useRunsIndex } from '@/api/queries'
import { runsIndexSync } from '@/api/runs-index-sync'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { canPersistProjectOrder, orderProjects } from '@/lib/project-order'
import { signalsByProject, type ProjectSignal } from '@/lib/project-signal'
import { useProjectOrder } from '@/lib/use-project-order'

export type WorkspaceSignals = {
  /** The registry in the user's order (`lib/project-order.ts`): registry order until they drag. */
  projects: readonly ProjectListEntry[]
  /** Null while the runs index has not loaded: activity is then unknown, not idle. */
  signals: ReadonlyMap<string, ProjectSignal> | null
  /** The workspace ui-state has loaded, so a reorder can be written without dropping its siblings,
   *  and the registry fits the stored order whole (`canPersistProjectOrder`). */
  canReorder: boolean
  /** Persist a full order (every id on screen, in its new order). */
  onReorder: (ids: readonly string[]) => void
}

/**
 * The registry plus every project's four counts, read once for the whole shell. The desktop rail
 * and the mobile menu button and drawer all render from this one result, so they cannot disagree,
 * and the registry-change refresh below runs once, not once per surface. The hand-picked project
 * order (hearsay-tools/cezarion#438) is applied here for the same reason: one place, every surface.
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
  const registered = useProjects().data?.projects
  const { order, canReorder: uiStateLoaded, setOrder } = useProjectOrder()
  const canReorder = uiStateLoaded && registered !== undefined && canPersistProjectOrder(registered.length)
  const projects = React.useMemo(() => (registered ? orderProjects(registered, order) : undefined), [registered, order])
  const index = useRunsIndex().data
  const signals = React.useMemo(() => (index ? signalsByProject(index.runs) : null), [index])

  // The stream patches the index row by row, and none of its frames fire when the registry
  // changes. A project registered (or cloned) with runs already on disk would show no signal until
  // its next run event, so a NEW id asks for a fenced reconciliation. A removed id only drops its
  // rows: that needs no request (hearsay-tools/cezarion#2729). Keyed on the id set so a rename or
  // a `lastOpenedAt` bump does nothing; a reorder changes no membership either.
  const registry = registered?.map((project) => project.id).sort().join('\n')
  const seenRegistry = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (registry === undefined) return
    const previous = seenRegistry.current
    seenRegistry.current = registry
    // The first sighting is the index's own initial fetch; only a later change needs work.
    if (previous === undefined || previous === registry) return
    const before = new Set(previous.split('\n'))
    const after = new Set(registry.split('\n'))
    const sync = runsIndexSync(queryClient)
    for (const id of before) if (!after.has(id)) sync.dropProject(id)
    const added = [...after].filter((id) => !before.has(id))
    for (const id of added) sync.restoreProject(id)
    if (added.length > 0) void sync.reconcile({ hold: true })
  }, [queryClient, registry])

  return React.useMemo(
    () => (projects ? { projects, signals, canReorder, onReorder: setOrder } : null),
    [projects, signals, canReorder, setOrder],
  )
}
