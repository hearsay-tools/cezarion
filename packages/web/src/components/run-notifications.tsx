import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { useWorkspaceUiState } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import {
  diffRunTransitions,
  type RunNotificationState,
  normalizeNotifications,
  notificationSupport,
  shouldNotify,
  describeRunNotification,
} from '@/lib/notifications'

/**
 * The notification trigger (R6 Step 1.7, spec §"Cross-cutting"): browser `Notification` when a
 * run ENTERS `waiting`/`review`/failed while the tab is hidden.
 *
 * It watches the cached run list rather than opening its own listener on `/api/events`: the
 * global stream (api/global-events.tsx) already folds every `run` event into
 * the owning project’s run list, and the reconnect/visibility reconciliation refetches it — so one
 * cache subscription sees BOTH deliveries of the same truth. That second path is not a bonus,
 * it is the point: a hidden tab is exactly when the stream is most likely to have been frozen
 * (mobile background freeze, laptop lid), and the run that flipped to `waiting` while the socket
 * was dead arrives via the reconciling refetch, not via an event.
 *
 * Statuses are tracked UNCONDITIONALLY — before the enabled/hidden/permission gate — so flipping
 * the toggle on later, or refocusing the tab, never replays transitions that already happened:
 * the gate decides whether a transition becomes a notification, never whether it was observed.
 *
 * Renders nothing. Mounted once in app.tsx, beside the providers, for the app's whole life.
 */
export function RunNotifications() {
  const queryClient = useQueryClient()
  // The toggle, straight from the GLOBAL ui-state (step 3.5 moved the section there — the
  // notifying browser is one browser whichever project is open). Read through the same query
  // AppearanceProvider keeps warm — no extra fetch, and a PUT from Settings updates this cache
  // entry, so the gate flips without any coupling between the two components.
  const uiState = useWorkspaceUiState()
  const enabled = normalizeNotifications(uiState.data?.notifications).enabled

  // A ref, not an effect dependency: re-running the effect on toggle flips would rebuild the
  // cache subscription and lose the status map — the whole "never replay" guarantee.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    const cache = queryClient.getQueryCache()
    const lists = new Map<string, ReadonlyMap<string, RunNotificationState>>()
    const known = new Map<string, RunNotificationState>()
    const isRunList = (key: readonly unknown[]) =>
      key.length === 3 && typeof key[0] === 'string' && key[1] === 'runs' && key[2] === 'list'

    // Retain other projects' history, but forget tasks once no cached list contains them.
    const prune = () => {
      const retained = new Set([...lists.values()].flatMap(states => [...states.keys()]))
      for (const id of known.keys()) if (!retained.has(id)) known.delete(id)
    }
    const observe = (hash: string, runs: readonly ApiRun[], seed = false): void => {
      const previous = lists.get(hash)
      const { statuses } = diffRunTransitions(new Map(), runs)
      // Compare within each alias first: a token tick on an old alias must not rewind the
      // shared history. First sightings seed silently from the latest loaded snapshot.
      const changed = runs.filter(run => {
        const before = previous?.get(run.id)
        const after = statuses.get(run.id)!
        return before !== undefined &&
          (before.status !== after.status || before.wantsAttention !== after.wantsAttention)
      })
      const { entering, statuses: updates } = diffRunTransitions(known, changed)
      for (const [id, state] of statuses) if (!previous?.has(id)) known.set(id, state)
      for (const [id, state] of updates) known.set(id, state)
      lists.set(hash, statuses)
      prune()
      if (seed) return
      if (entering.length === 0) return
      const gate = {
        enabled: enabledRef.current,
        hidden: document.visibilityState === 'hidden',
        permission: notificationSupport(),
      }
      if (!shouldNotify(gate)) return
      for (const run of entering) fireRunNotification(run)
    }

    // Seed every project already loaded, silently, including aliases with different snapshots.
    for (const query of cache.getAll().sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)) {
      if (isRunList(query.queryKey) && Array.isArray(query.state.data)) {
        observe(query.queryHash, query.state.data as ApiRun[], true)
      }
    }

    return cache.subscribe((event) => {
      if (!isRunList(event.query.queryKey)) return
      if (event.type === 'removed') {
        lists.delete(event.query.queryHash)
        prune()
      } else if (event.type === 'updated' && event.action.type === 'success' && Array.isArray(event.query.state.data)) {
        observe(event.query.queryHash, event.query.state.data as ApiRun[])
      }
    })
  }, [queryClient])

  return null
}

/** The impure sliver: construct the `Notification`. Guarded and try/caught because both failure
 *  modes are real — no constructor at all (tests, old WebViews), and a constructor that THROWS
 *  on page-context construction (Chrome on Android insists on a ServiceWorker). A notification
 *  is a courtesy; it must never take the message loop down with it. */
function fireRunNotification(run: ApiRun): void {
  const N = globalThis.Notification
  if (typeof N !== 'function') return
  const content = describeRunNotification(run)
  try {
    new N(content.title, { body: content.body, tag: content.tag })
  } catch {
    // Degrade silently — the dot in the quick-list still tells the truth.
  }
}
