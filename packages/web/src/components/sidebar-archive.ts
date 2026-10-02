import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { queryScope } from '@open-mercato/cezar-api-client'
import type { ArchiveFinishedScope, RunRecord } from '@open-mercato/cezar-api-client'
import { archiveProjectFinished, archiveProjectRun, archiveRun, archiveFinished, pinProjectRun, pinRun } from '@/api/client'
import { toast } from '@/components/ui/toaster'
import { runTitle } from '@/lib/task-groups'

/**
 * Archiving from the sidebar (#780): the row button, the group sweeps and the mobile swipe all
 * land here, so the toast copy and the Undo rule exist once.
 */

/** `Archived "<title>"` for one row, `Archived N tasks` for a sweep. */
export function archivedToastMessage(input: { title: string } | { count: number }): string {
  if ('title' in input) return `Archived "${input.title}"`
  return `Archived ${input.count} ${input.count === 1 ? 'task' : 'tasks'}`
}

/**
 * Undo: unarchive every id, then re-pin each one that was pinned. The pin has to come after the
 * unarchive because the server refuses to pin an archived run. Ids run in parallel, the two calls
 * per id in sequence, and every call settles; failures show ONE danger toast with the server's
 * own message. `projectId` is the one captured when the archive happened — the user may be
 * standing in another project by the time they press Undo.
 */
export async function undoArchive(
  projectId: string | undefined,
  ids: readonly string[],
  pinnedIds: readonly string[],
): Promise<void> {
  const pinned = new Set(pinnedIds)
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      await (projectId === undefined ? archiveRun(id, false) : archiveProjectRun(projectId, id, false))
      if (pinned.has(id)) await (projectId === undefined ? pinRun(id, true) : pinProjectRun(projectId, id, true))
    }),
  )
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) toast(failed.reason instanceof Error ? failed.reason.message : 'Could not undo the archive.', { tone: 'danger' })
}

/**
 * The sidebar's archive actions for one project's list. `projectId`/`cacheScope` are the pair
 * `usePinRun` takes: the request goes to the row's own project, and the invalidated cache is the
 * one that project's list is stored under (`'default'` for the boot project).
 */
export function useSidebarArchive(projectId: string | undefined, cacheScope: string | undefined) {
  const queryClient = useQueryClient()
  const [sweeping, setSweeping] = React.useState<ArchiveFinishedScope | null>(null)

  const refresh = (scope: string) => queryClient.invalidateQueries({ queryKey: [scope, 'runs'] as const })
  const offerUndo = (message: string, scope: string, ids: readonly string[], pinnedIds: readonly string[]) =>
    toast(message, {
      action: {
        label: 'Undo',
        onAction: () => void undoArchive(projectId, ids, pinnedIds).finally(() => void refresh(scope)),
      },
    })

  const archiveOne = (run: RunRecord) => {
    // Captured before the request: navigation during the round trip must not retarget either half.
    const scope = cacheScope ?? queryScope()
    const wasPinned = Boolean(run.pinned)
    void (projectId === undefined ? archiveRun(run.id, true) : archiveProjectRun(projectId, run.id, true)).then(
      () => {
        void refresh(scope)
        offerUndo(archivedToastMessage({ title: runTitle(run) }), scope, [run.id], wasPinned ? [run.id] : [])
      },
      (error: Error) => toast(error.message, { tone: 'danger' }),
    )
  }

  const sweep = (scopeOfSweep: ArchiveFinishedScope) => {
    const scope = cacheScope ?? queryScope()
    setSweeping(scopeOfSweep)
    void (projectId === undefined ? archiveFinished(scopeOfSweep) : archiveProjectFinished(projectId, scopeOfSweep))
      .then(
        ({ ids, pinnedIds }) => {
          void refresh(scope)
          // The count is what the server took, not what was on screen: a run that finished a
          // moment ago may be in it, and Undo restores it too.
          if (ids.length > 0) offerUndo(archivedToastMessage({ count: ids.length }), scope, ids, pinnedIds)
        },
        (error: Error) => toast(error.message, { tone: 'danger' }),
      )
      .finally(() => setSweeping(null))
  }

  return { archiveOne, sweep, sweeping }
}
