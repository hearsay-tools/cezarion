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

const TOAST_TITLE_MAX = 60

/** `Archived "<title>"` for one row, `Archived N tasks` for a sweep. A long title is cut so the
 *  toast stays a line or two; the row's own title tooltip carries the rest. */
export function archivedToastMessage(input: { title: string } | { count: number }): string {
  if ('title' in input) {
    const title = input.title.length > TOAST_TITLE_MAX ? `${input.title.slice(0, TOAST_TITLE_MAX - 1)}…` : input.title
    return `Archived "${title}"`
  }
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

/** True when focus has nowhere useful to be: nothing, <body>, or a node that left the page. */
function focusIsLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/** Runs `then` once `el` has left the page (the list drops a row over SSE a moment after the
 *  request answers), or at once if it already has. Gives up after a few seconds. */
function afterRemoval(el: Element, then: () => void): void {
  if (!el.isConnected) return then()
  const observer = new MutationObserver(() => {
    if (el.isConnected) return
    observer.disconnect()
    clearTimeout(giveUp)
    then()
  })
  const giveUp = setTimeout(() => observer.disconnect(), 5000)
  observer.observe(document.body, { childList: true, subtree: true })
}

function focusTarget(el: Element | null | undefined, fallback?: Element | null): void {
  if (!focusIsLost()) return
  const target = el?.isConnected ? el : fallback?.isConnected ? fallback : null
  if (!(target instanceof HTMLElement)) return
  if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) target.tabIndex = -1
  target.focus({ preventScroll: true })
}

/**
 * Keyboard focus survives an archive: the row (or sweep button) the user was on is about to
 * disappear, and focus would drop to <body>. Remember the next row's link in the same bucket,
 * else the previous one, else the list container, and put focus there once the element is gone
 * — but only if nothing else has taken it by then.
 */
function keepFocusAfterRemoval(from: Element | null, pickTarget: (from: Element) => Element | null, container: Element | null): () => void {
  if (!from) return () => {}
  const target = pickTarget(from)
  return () => afterRemoval(from, () => focusTarget(target, container))
}

function rowElement(runId: string): Element | null {
  const active = document.activeElement?.closest('[data-slot="task-row"]')
  if (active?.getAttribute('data-run-id') === runId) return active
  return Array.from(document.querySelectorAll('[data-slot="task-row"]')).find((row) => row.getAttribute('data-run-id') === runId) ?? null
}

const linkOf = (row: Element | undefined) => row?.querySelector('a') ?? null

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

  // A second click before the first answers would send a second archive and a second toast.
  const inFlight = React.useRef(new Map<string, Promise<boolean>>())

  /** Resolves whether the run was archived, so a swiped row can snap back on a failure. A repeat
   *  while the first request is in flight gets that request's promise: it follows the real outcome. */
  const archiveOne = (run: RunRecord): Promise<boolean> => {
    const pending = inFlight.current.get(run.id)
    if (pending) return pending
    // Captured before the request: navigation during the round trip must not retarget either half.
    const scope = cacheScope ?? queryScope()
    const wasPinned = Boolean(run.pinned)
    const row = rowElement(run.id)
    const restoreFocus = keepFocusAfterRemoval(
      row,
      (el) => {
        const rows = Array.from(el.closest('[data-slot="quick-list-bucket"]')?.querySelectorAll('[data-slot="task-row"]') ?? [])
        const at = rows.indexOf(el)
        return linkOf(rows[at + 1] ?? rows[at - 1])
      },
      row?.closest('[data-slot="quick-list-bucket"]')?.parentElement ?? null,
    )
    const request = (projectId === undefined ? archiveRun(run.id, true) : archiveProjectRun(projectId, run.id, true))
      .then(
        () => {
          void refresh(scope)
          offerUndo(archivedToastMessage({ title: runTitle(run) }), scope, [run.id], wasPinned ? [run.id] : [])
          restoreFocus()
          return true
        },
        (error: Error) => {
          toast(error.message, { tone: 'danger' })
          return false
        },
      )
      .finally(() => inFlight.current.delete(run.id))
    inFlight.current.set(run.id, request)
    return request
  }

  const sweep = (scopeOfSweep: ArchiveFinishedScope) => {
    const scope = cacheScope ?? queryScope()
    setSweeping(scopeOfSweep)
    const active = document.activeElement
    const button = active?.matches('[data-action="archive-group"]') ? active : null
    const restoreFocus = keepFocusAfterRemoval(
      button,
      (el) => linkOf(el.closest('[data-slot="quick-list-bucket"]')?.nextElementSibling?.querySelector('[data-slot="task-row"]') ?? undefined),
      button?.closest('[data-slot="quick-list-bucket"]')?.parentElement ?? null,
    )
    void (projectId === undefined ? archiveFinished(scopeOfSweep) : archiveProjectFinished(projectId, scopeOfSweep))
      .then(
        ({ ids, pinnedIds }) => {
          void refresh(scope)
          // The count is what the server took, not what was on screen: a run that finished a
          // moment ago may be in it, and Undo restores it too.
          if (ids.length > 0) offerUndo(archivedToastMessage({ count: ids.length }), scope, ids, pinnedIds)
          restoreFocus()
        },
        (error: Error) => toast(error.message, { tone: 'danger' }),
      )
      .finally(() => setSweeping(null))
  }

  return { archiveOne, sweep, sweeping }
}
