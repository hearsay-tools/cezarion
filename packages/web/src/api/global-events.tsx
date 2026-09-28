import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

import { trackSseReconcile } from '@/lib/cez-idle'
import { applyProviderStatusRow, parseProviderStatusEventRow } from '@/lib/provider-status'
import {
  applyRunDeleted,
  applyRunEvent,
  createUsageStore,
  EMPTY_USAGE,
  mergeRun,
  parseWorkspaceEvent,
  type GlobalEvent,
  type UsageStore,
} from './events'
import { runnerModelCatalogResponseSchema, apiPath, getApiScope } from '@open-mercato/cezar-api-client'
import { queryKeys, useHealthSubscription, workspaceQueryKeys } from './queries'
import type {
  ApiRun,
  HealthResponse,
  ProcessUsage,
  ProjectsResponse,
  ProviderStatusResponse,
  RunRecord,
} from '@open-mercato/cezar-api-client'

/**
 * The app's one connection to `GET /api/workspace/events`, and the two halves of the sync
 * doctrine (spec, "Architecture"): the stream is for immediacy, the REST endpoints are
 * authoritative, and on reconnect or a tab-visibility flip we refetch and reconcile.
 *
 * Immediacy is cache patching, not refetching: a live run emits a `run` event per step transition
 * and per token update, and invalidating the list on each would turn one agent into a request
 * flood against a server sharing this laptop's CPU with it. So events are folded into the cache
 * in place (events.ts), and the authoritative refetch happens exactly when we know we may have
 * missed something: at reconnect, and when a tab (or a phone that slept through an hour of the
 * run) comes back.
 *
 * Multi-project (spec, step 3.1): the one stream carries EVERY project's events, each stamped
 * with its owner. Run lists are patched by stamp (boot → `'default'`, else the registry id) so
 * a sidebar group never receives another project's row (#129). Todos, usage and detail stay
 * active-scope-only — the mounted scope's, or the boot project's when unscoped. One
 * connection for the whole workspace, not one per project: same per-origin socket-budget
 * argument as ever, and a project switch changes the filter, not the socket.
 *
 * Provider authentication is host-wide rather than project-owned. Its dedicated unstamped event
 * bypasses that project filter and patches only an already-fetched workspace cache.
 */

// Route-relative: `apiPath` adds the version (and would add the project scope, though this
// stream is workspace-level and never scoped).
const SSE_URL = apiPath('/workspace/events')

/** `EventSource.CLOSED`. Spelled as the literal so nothing here depends on the global's statics —
 *  the same reason the constructor is read off `globalThis` below. */
const CLOSED = 2

/** How long to wait before rebuilding a stream the browser gave up on. Long enough that a server
 *  restart isn't hammered while it boots, short enough that the cockpit is live again before the
 *  reader notices. Only reached in the permanent-failure case: an ordinary drop is EventSource's
 *  own retry, which we neither can nor should replace. */
const REOPEN_DELAY_MS = 3_000

/** Everything the stream is allowed to say. An unknown name never reaches `parseGlobalEvent`,
 *  because SSE only delivers named events to a matching listener in the first place. */
const EVENT_NAMES = ['run', 'run-deleted', 'todos', 'usage', 'ping'] as const

/**
 * The workspace-only names (server: `WorkspaceEventName`). Unlike the list above these are not
 * project-stamped and never patch a run cache — they are registry news, so they invalidate the
 * projects query (the sidebar grows/loses a group without a reload) and fan out to whoever
 * subscribed via `onWorkspaceEvent`.
 */
const WORKSPACE_EVENT_NAMES = ['project-added', 'project-removed', 'checkout-progress', 'automation-change'] as const

type WorkspaceEventName = (typeof WORKSPACE_EVENT_NAMES)[number]

const workspaceListeners = new Set<(name: WorkspaceEventName, payload: unknown) => void>()

/**
 * Subscribe to the workspace-level events on the one stream. Returns an unsubscribe.
 *
 * A module-level registry rather than a React context because the subscriber (the clone dialog,
 * step 4.3) is mounted far from the provider and cares about exactly one event id — a context
 * carrying every payload would re-render the whole tree on each `git clone` progress line.
 * Payloads are handed over RAW (parsed JSON, unvalidated): each listener knows the shape of the
 * event it asked for, and inventing a second parser here would only duplicate events.ts.
 */
export function onWorkspaceEvent(
  listener: (name: WorkspaceEventName, payload: unknown) => void,
): () => void {
  workspaceListeners.add(listener)
  return () => {
    workspaceListeners.delete(listener)
  }
}

/**
 * The cross-project index behind the global Tasks page, refreshed from ANY project's run news.
 *
 * Invalidated rather than patched, and debounced. Patching would mean synthesizing a
 * `RunIndexEntry` from a `RunRecord` — a slim row from a fat one, including the `usage` the server
 * attaches per poll — and inventing a row is exactly what the reducers in `events.ts` refuse to
 * do. Invalidation asks the authoritative endpoint instead, and costs nothing at all unless the
 * page is actually mounted: `invalidateQueries` refetches what is rendered and only marks the rest
 * stale.
 *
 * The debounce is what keeps that honest. One run emits many events (started, step, usage,
 * finished), and a workspace of forty projects emits them from everywhere at once; without it a
 * busy minute would be a refetch per event. One request per quiet moment is the whole point.
 */
const RUNS_INDEX_REFRESH_DEBOUNCE_MS = 400

/** Built per mount, not module-level: a pending timer holds the `queryClient` it will write to,
 *  and one that outlives its provider would invalidate a cache nobody is reading. `cancel` runs
 *  in the effect cleanup. */
function createRunsIndexRefresher(queryClient: QueryClient): {
  onEvent: (event: GlobalEvent) => void
  cancel: () => void
} {
  let pending: ReturnType<typeof setTimeout> | undefined
  return {
    onEvent(event) {
      if (event.type !== 'run' && event.type !== 'run-deleted') return
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
      }, RUNS_INDEX_REFRESH_DEBOUNCE_MS)
    },
    cancel() {
      clearTimeout(pending)
      pending = undefined
    },
  }
}

/**
 * Refetch the authoritative endpoints.
 *
 * These are the endpoints the stream can leave stale:
 * - runs: the summaries the stream patches (`invalidate(['runs'])` covers the list and every
 *   single-run query under it — that is what the hierarchical keys in queries.ts are for);
 * - todos: the inbox the `todos` event replaces;
 * - health: the repo/branch chip. Health is not on the stream — nothing server-side watches for a
 *   branch switch — so this reconcile alone only catches a switch across a reconnect or a tab
 *   coming back; a checkout in a foreground, connected tab is covered by `useHealth`'s own poll
 *   instead (#369). Invalidating it here too costs nothing extra and keeps this list a complete
 *   "everything the stream can leave stale" note;
 * - worktrees: run terminal transitions and reclaim operations change the resources panel;
 * - provider status: runtime authentication failures patch this workspace-wide cache live.
 *
 * `invalidateQueries` and not `refetchQueries`: it refetches what is actually rendered and marks
 * the rest stale for whenever it next mounts. A background tab with fifty cached runs should not
 * fetch fifty runs to come back.
 */
function isRunListQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[1] === 'runs' && queryKey[2] === 'list'
}

function reconcileCursorModels(queryClient: QueryClient): Promise<void> {
  const key = workspaceQueryKeys.models('cursor')
  // With no cached data, invalidation reuses an in-flight cold request. Cancel
  // it first so a completion missed during disconnect cannot leave the picker empty.
  return queryClient.cancelQueries({ queryKey: key }).then(() =>
    queryClient.invalidateQueries({ queryKey: key }),
  )
}

function reconcile(queryClient: QueryClient): void {
  trackSseReconcile(() => [
    queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    // Sidebar groups keep per-project list caches. `queryKeys.runs.all` is scope-led, so a
    // reconnect would otherwise leave an expanded non-active group's patched list stale (#129).
    queryClient.invalidateQueries({
      predicate: (query) => isRunListQueryKey(query.queryKey),
    }),
    // Events happened while we were disconnected, and the index is cross-project — nothing else
    // here covers it.
    queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex }),
    queryClient.invalidateQueries({ queryKey: queryKeys.todos }),
    queryClient.invalidateQueries({ queryKey: queryKeys.health }),
    // The worktree panel's list/total (#483) — a run finishing or a reclaim changes it.
    queryClient.invalidateQueries({ queryKey: queryKeys.worktrees }),
    queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus }),
    reconcileCursorModels(queryClient),
    // GitHub edits never enter this stream. Reconnect (including server restart) must
    // invalidate every project's list, leaving inactive caches stale until revisited.
    // Restrict this to list keys: comments/checks/search have separate cache policies.
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) => queryKey.length === 3 && queryKey[1] === 'github'
        && (queryKey[2] === null || typeof queryKey[2] === 'number'),
    }),
  ])
}

/**
 * The project whose events this cockpit currently applies: the mounted scope, or — unscoped —
 * the boot project `GET /api/health` names (`bootProject`, additive field). Undefined only in
 * the unscoped moments before health's first answer; stamped events are dropped then, which is
 * harmless by the doctrine — the authoritative queries are fetching right at that moment, and
 * the reducers refuse to invent caches from stream messages anyway.
 */
function activeProject(queryClient: QueryClient): string | undefined {
  return getApiScope() ?? bootProjectOf(queryClient)
}

function bootProjectOf(queryClient: QueryClient): string | undefined {
  // Registry first: sidebar groups key boot as `'default'` from `projects.bootProject`, and
  // that cache is workspace-led. Health is scope-led, so a mounted non-boot project reads a
  // different entry than the unscoped bootstrap — fall back to `'default'` health last.
  const registry = queryClient.getQueryData<ProjectsResponse>(workspaceQueryKeys.projects)
  const fromRegistry = registry?.bootProject
  if (typeof fromRegistry === 'string' && fromRegistry !== '') return fromRegistry
  return (
    queryClient.getQueryData<HealthResponse>(queryKeys.health)?.bootProject ??
    queryClient.getQueryData<HealthResponse>(['default', 'health'])?.bootProject
  )
}

/** Sidebar groups key the boot project as `'default'` (`useProjectRuns(..., boot)`); every other
 *  group uses its registry id. A stamped run must land in that same entry, not in whatever
 *  scope is currently mounted (#129). */
function runListCacheKey(project: string, bootProject: string | undefined): readonly [string, 'runs', 'list'] {
  return [project === bootProject ? 'default' : project, 'runs', 'list'] as const
}

/** Archive cascades can send dozens of full records before a frame paints. Keep their list writes
 * together while detail/permission handling stays immediate. Keys are captured at receipt time:
 * changing project scope before the frame must not move an earlier project's update. */
function createRunListBatcher(queryClient: QueryClient) {
  const pending = new Map<string, {
    key: readonly [string, 'runs', 'list']; baseList: ApiRun[] | undefined
    baseQuery: object | undefined; baseUpdateCount: number | undefined; runs: Map<string, RunRecord>
  }>()
  type Reconciliation = {
    key: readonly [string, 'runs', 'list']; phase: 'needs-start' | 'awaiting-fetch' | 'fetching'
    dirty: boolean
  }
  const needsReconcile = new Map<string, Reconciliation>()
  const startRecovery = (key: readonly [string, 'runs', 'list']): void => {
    const entry = needsReconcile.get(JSON.stringify(key))
    if (!entry) return
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
    const previousRequest = query?.promise
    entry.phase = 'awaiting-fetch'
    entry.dirty = false
    // The first GET must start after the discarded archive. An already-running request may have
    // captured the old list; TanStack cancels and replaces it for an active query.
    void queryClient.invalidateQueries({ queryKey: key, exact: true })
    // Query.fetch can silently replace a running request without dispatching a new `fetch`
    // action when fetchStatus and metadata stay the same. The promise identity still changes.
    if (query?.promise && query.promise !== previousRequest) entry.phase = 'fetching'
  }
  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (!needsReconcile.size || event.type !== 'updated') return
    const cacheKey = JSON.stringify(event.query.queryKey)
    const entry = needsReconcile.get(cacheKey)
    if (!entry) return
    if (event.action.type === 'setState') {
      // Cancelling the last observer can revert to a manual SSE write's fresh-looking snapshot.
      // Preserve the obligation without fetching a list that nobody is observing.
      if (!event.query.state.isInvalidated) {
        void queryClient.invalidateQueries({ queryKey: entry.key, exact: true, refetchType: 'none' })
      }
      return
    }
    if (event.action.type === 'fetch') {
      if (entry.phase === 'awaiting-fetch') entry.phase = 'fetching'
      entry.dirty = false
      return
    }
    if (event.action.type !== 'success') return
    if (!event.action.manual) {
      // A response from a pre-event GET cannot satisfy this obligation. Only a fetch that began
      // after the first recovery invalidation can clear it.
      if (entry.phase === 'fetching' && !entry.dirty) needsReconcile.delete(cacheKey)
      else startRecovery(entry.key)
      return
    }
    if (entry.phase === 'needs-start') return // the current live event finishes before first recovery
    if (entry.phase === 'fetching') entry.dirty = true
    // A reconciliation fetch may already be in flight. Keep it and its eventual authoritative
    // result instead of cancelling/restarting a GET for every live worker event. If a write
    // overlaps it, success starts one trailing fetch: that snapshot may predate this write.
    void queryClient.invalidateQueries({ queryKey: entry.key, exact: true }, { cancelRefetch: false })
  })
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (deferReconcile = false): Array<readonly [string, 'runs', 'list']> => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    const reconcileKeys: Array<readonly [string, 'runs', 'list']> = []
    for (const { key, baseList, baseQuery, baseUpdateCount, runs } of pending.values()) {
      // A successful write during the wait may be older or newer than the archive event. Even
      // when REST returns the original row, structural sharing can retain the same list object.
      // The query identity also catches removal followed by recreation with the same data.
      const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
      if (query !== baseQuery || query?.state.dataUpdateCount !== baseUpdateCount || query?.state.data !== baseList) {
        reconcileKeys.push(key)
        needsReconcile.set(JSON.stringify(key), { key, phase: 'needs-start', dirty: false })
        continue
      }
      queryClient.setQueryData<ApiRun[]>(key, list => {
        let next = list
        for (const run of runs.values()) next = applyRunEvent(next, run)
        return next
      })
    }
    pending.clear()
    if (!deferReconcile) {
      for (const key of reconcileKeys) startRecovery(key)
    }
    return reconcileKeys
  }

  const keysFor = (project: string): Array<readonly [string, 'runs', 'list']> => {
    const stamped = runListCacheKey(project, bootProjectOf(queryClient))
    const scoped = project === activeProject(queryClient) ? queryKeys.runs.list() : undefined
    return scoped && JSON.stringify(scoped) !== JSON.stringify(stamped) ? [stamped, scoped] : [stamped]
  }

  return {
    onEvent(project: string, event: Extract<GlobalEvent, { type: 'run' | 'run-deleted' }>): void {
      const keys = keysFor(project)
      // Batch only the first archive transition. Archived workers remain live and can continue
      // changing status or title without changing archivedAt; those updates still land now.
      const firstArchive = event.type === 'run' && event.run.archived && keys.every(key =>
        !queryClient.getQueryData<ApiRun[]>(key)?.find(row => row.id === event.run.id)?.archived)
      if (firstArchive && event.type === 'run') {
        for (const key of keys) {
          const cacheKey = JSON.stringify(key)
          let entry = pending.get(cacheKey)
          if (!entry) {
            const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
            entry = {
              key, baseList: query?.state.data as ApiRun[] | undefined,
              baseQuery: query, baseUpdateCount: query?.state.dataUpdateCount, runs: new Map(),
            }
            pending.set(cacheKey, entry)
          }
          entry.runs.set(event.run.id, event.run)
        }
        if (timer === undefined) {
          timer = setTimeout(() => { flush() }, 50)
          if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => { flush() })
        }
        return
      }
      // A newer live update or deletion must win over an archived record still in the queue.
      const reconcileAfterWrite = flush(true)
      for (const key of keys) {
        if (event.type === 'run') queryClient.setQueryData<ApiRun[]>(key, list => applyRunEvent(list, event.run))
        else queryClient.setQueryData<ApiRun[]>(key, list => applyRunDeleted(list, event.id))
      }
      // Start recovery only after the current event's manual write. A pre-event GET must be
      // replaced once; subsequent SSE writes keep that new request in flight.
      for (const key of reconcileAfterWrite) startRecovery(key)
    },
    flush,
    cancel(): void {
      unsubscribe()
      needsReconcile.clear()
    },
  }
}

/** Keep permission unknown immediately, but fetch only after the event burst settles.
 * Per-mount timers retain the original scoped key and are cancelled on cleanup. */
function createRunDetailRefresher(queryClient: QueryClient) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    refresh(id: string): void {
      const key = queryKeys.runs.detail(id)
      if (!queryClient.getQueryState(key)) return
      const cacheKey = JSON.stringify(key)
      clearTimeout(pending.get(cacheKey))
      // Invalidation alone reuses an initial in-flight request. Cancel it now so a
      // pre-event response cannot restore permission during the debounce window.
      // Keep TanStack's default revert: a cancelled fetch restores the last successful
      // query state (or pending on first load), instead of surfacing a cancellation error.
      // setQueryData updates the revert snapshot, so the event patch above survives too.
      void queryClient.cancelQueries({ queryKey: key })
      pending.set(cacheKey, setTimeout(() => {
        pending.delete(cacheKey)
        void queryClient.invalidateQueries({ queryKey: key })
      }, 400))
    },
    cancel(): void {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    },
  }
}

/**
 * The relationships readers (`useRunRelationships`, `useWorkersVerdict` on every activity dock)
 * ask `GET /runs/:id/relationships`, and a live worker emits a `run` event per token tick.
 * Invalidating every mounted relationships query on each of those was a refetch storm against a
 * one-core serve (#659). Three rules replace the blanket:
 *
 * - only the entries the event can change: the run's own, and its parent's when the run is a
 *   worker — a parent's answer is its workers' records, a worker's answer is its parent id;
 * - only when the event moves something the answer carries — status, step, activity or
 *   delegation metadata. A token tick or a rename changes none of them and is dropped at the
 *   door, judged against the last record this stream saw for that run rather than against a
 *   cache the sidebar stamp may already have overwritten;
 * - at most one refetch per entry per quiet window, on the runs-index refresher's cadence and
 *   with the same hold-then-fire shape, so a run that never goes quiet still refreshes.
 *
 * A deleted run refreshes the parent it was last seen under. One the stream never saw has no
 * known parent, and that rare case keeps the old whole-family refresh, debounced under one key.
 * Reconnect is untouched: `reconcile` invalidates `runs.all`, which these keys sit under.
 */
const RELATIONSHIPS_REFRESH_DEBOUNCE_MS = 400

function relationshipsShapeOf(run: RunRecord): string {
  return JSON.stringify([run.status, run.currentStepId, run.activity, run.delegation])
}

function createRelationshipsRefresher(queryClient: QueryClient): {
  onRun: (run: RunRecord) => void
  onDeleted: (id: string) => void
  cancel: () => void
} {
  const seen = new Map<string, { shape: string; parentRunId?: string }>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  /** `exact` keys refresh only when a reader has ever asked — an entry nobody holds has
   *  nothing to refetch. The prefix key of the family fallback matches nothing exactly. */
  const schedule = (key: readonly unknown[], exact: boolean): void => {
    if (exact && !queryClient.getQueryState(key)) return
    const cacheKey = JSON.stringify(key)
    if (pending.has(cacheKey)) return
    pending.set(cacheKey, setTimeout(() => {
      pending.delete(cacheKey)
      void queryClient.invalidateQueries({ queryKey: key })
    }, RELATIONSHIPS_REFRESH_DEBOUNCE_MS))
  }
  return {
    onRun(run) {
      const parentRunId = run.delegation?.role === 'worker' ? run.delegation.parentRunId : undefined
      const shape = relationshipsShapeOf(run)
      const previous = seen.get(run.id)
      seen.set(run.id, parentRunId === undefined ? { shape } : { shape, parentRunId })
      if (previous?.shape === shape) return
      schedule(queryKeys.runs.relationships(run.id), true)
      if (parentRunId !== undefined) schedule(queryKeys.runs.relationships(parentRunId), true)
    },
    onDeleted(id) {
      const previous = seen.get(id)
      seen.delete(id)
      // Gone server-side, like its detail and diff below: a reader left on it gets the 404.
      queryClient.removeQueries({ queryKey: queryKeys.runs.relationships(id) })
      if (previous?.parentRunId !== undefined) schedule(queryKeys.runs.relationships(previous.parentRunId), true)
      else schedule([...queryKeys.runs.all, 'relationships'], false)
    },
    cancel() {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      seen.clear()
    },
  }
}

type RelationshipsRefresher = ReturnType<typeof createRelationshipsRefresher>

/** Fold one stream message into the cache. The reducers it calls are pure and table-tested in
 *  events.ts; this is only the wiring from an event to the cache it belongs in. */
function applyGlobalEvent(
  queryClient: QueryClient,
  usage: UsageStore,
  event: GlobalEvent,
  refreshRunDetail: (id: string) => void,
  relationships: Pick<RelationshipsRefresher, 'onRun' | 'onDeleted'>,
): void {
  switch (event.type) {
    case 'run': {
      // A changed worker may be absent from the visible list. Refresh this project's mounted
      // relationship readers without discarding their last successful data (#659: only the
      // entries this run can change, only on a change they carry, and debounced).
      relationships.onRun(event.run)
      // The stamped list handler patches both the owner key and any active-scope alias.
      // Only a detail cache that exists: `setQueryData` would happily create one, leaving an entry
      // for a run nobody opened — and, worse, one built from a summary rather than from
      // `GET /api/runs/:id`, which the next reader would then be served as if it were fetched.
      const key = queryKeys.runs.detail(event.run.id)
      if (queryClient.getQueryData(key) !== undefined) {
        queryClient.setQueryData<ApiRun>(key, (previous) => mergeRun(previous, event.run))
        // The stream drops the old verdict; only a fresh detail response may permit Finish.
      }
      refreshRunDetail(event.run.id)
      if (event.run.delegation?.role === 'worker') {
        const parentKey = queryKeys.runs.detail(event.run.delegation.parentRunId)
        queryClient.setQueryData<ApiRun>(parentKey, previous => {
          if (!previous) return previous
          const { finishBlocked: _stale, ...run } = previous
          return run
        })
        refreshRunDetail(event.run.delegation.parentRunId)
      }
      // The Changes tab stops polling once a run leaves the active set (queries.ts:
      // refetchInterval only lives while active), so end-of-run writes would otherwise wait
      // for the next SSE reconnect's reconcile(). Invalidate the changes cache on the run event
      // itself — but only when one already exists, so a background tab that never opened the
      // Changes view doesn't fetch a diff nobody is looking at (same stance as the detail guard).
      const changesKey = queryKeys.runs.changes(event.run.id)
      if (queryClient.getQueryData(changesKey) !== undefined) {
        void queryClient.invalidateQueries({ queryKey: changesKey })
      }
      // A terminal transition can reclaim (or re-materialize) a worktree (#483); keep the
      // panel live. invalidateQueries only refetches while the panel is actually mounted.
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
      return
    }
    case 'run-deleted': {
      relationships.onDeleted(event.id)
      // The stamped list handler removes the row from both list aliases first.
      // Removed, not set to undefined: the run is gone server-side, so its detail and diff caches
      // are garbage. Anything still mounted on them refetches and gets the server's 404 — the
      // truth — instead of rendering a record that no longer exists.
      queryClient.removeQueries({ queryKey: queryKeys.runs.detail(event.id) })
      queryClient.removeQueries({ queryKey: queryKeys.runs.diff(event.id) })
      // Its worktree goes with it — refresh the panel (#483).
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
      return
    }
    case 'todos':
      // A complete array every time (the server re-reads the file), so it replaces outright and
      // may seed a cache no one fetched yet — unlike `run`, this payload *is* the whole answer.
      queryClient.setQueryData(queryKeys.todos, event.items)
      return
    case 'usage':
      usage.set(event.usage)
      return
    case 'ping':
      // A keep-alive. It says the socket is open, which we already know by receiving it.
      return
  }
}

/**
 * Hold one EventSource open for as long as this is mounted.
 *
 * Called once, by `GlobalEventsProvider`. One connection per app and not per component: browsers
 * cap concurrent connections per origin (6 on HTTP/1.1, which is what a local Hono server speaks),
 * and a handful of components each opening their own stream would spend that budget on duplicate
 * copies of the same messages and then stall every other request behind them.
 */
export function useGlobalEvents(usage: UsageStore, url: string = SSE_URL): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    // jsdom has no EventSource, and neither would a prerender. Read it off `globalThis` so the
    // check and the construction see the same binding (`vi.stubGlobal` is what the tests install).
    const Source = globalThis.EventSource
    if (typeof Source !== 'function') return

    let source: EventSource | null = null
    const runsIndexRefresher = createRunsIndexRefresher(queryClient)
    const runDetailRefresher = createRunDetailRefresher(queryClient)
    const runListBatcher = createRunListBatcher(queryClient)
    const relationshipsRefresher = createRelationshipsRefresher(queryClient)
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    let everOpened = false
    let disposed = false
    let providerStatusRefetching = false
    let providerStatusDirty = false

    const refetchUncachedProviderStatus = (): void => {
      providerStatusRefetching = true
      providerStatusDirty = false
      const key = workspaceQueryKeys.providerStatus
      void queryClient.cancelQueries({ queryKey: key, exact: true })
        .then(() => queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'active' }))
        .finally(() => {
          if (disposed || !providerStatusDirty) {
            providerStatusRefetching = false
            return
          }
          // Coalesce every valid event received during this replacement into one trailing fetch.
          // A further event during that fetch marks dirty again, so no status requests overlap.
          refetchUncachedProviderStatus()
        })
    }

    const reopenLater = (): void => {
      if (disposed || reopenTimer !== undefined) return
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined
        if (!disposed) connect()
      }, REOPEN_DELAY_MS)
    }

    const connect = (): void => {
      source?.close()
      // Remote cockpits commonly sit behind HTTP Basic Auth. EventSource supports an explicit
      // credentials mode (unlike WebSocket), so keep every automatic reconnect authenticated.
      source = new Source(url, { withCredentials: true })

      source.addEventListener('open', () => {
        // Not the first one: at boot the queries are fetching anyway, and invalidating them here
        // would only ask the same questions twice. Every later open is a *re*connect — we were
        // disconnected, events happened without us, and the cache is now a guess.
        if (everOpened) {
          runListBatcher.flush()
          reconcile(queryClient)
        }
        if (!everOpened) {
          // Discovery can finish between the cold HTTP read and SSE connection.
          // Cancel that read and reconcile once after the completion listener is attached.
          const key = workspaceQueryKeys.models('cursor')
          void queryClient.cancelQueries({ queryKey: key }).then(() => {
            if (!disposed) void queryClient.invalidateQueries({ queryKey: key })
          })
        }
        everOpened = true
      })

      for (const name of EVENT_NAMES) {
        source.addEventListener(name, (event) => {
          const parsed = parseWorkspaceEvent(name, (event as MessageEvent<string>).data)
          if (!parsed) return
          // The cross-project index first, and BEFORE the scope filter below — it is the one
          // cache that spans every project, so another project's news is exactly what it is news
          // for. Dropping those events left the global Tasks page entirely poll-driven: a title
          // the namer had rewritten stayed stale until the next tick, and the tick does not run
          // in a background tab, so coming back to one showed yesterday's rows until a reload.
          runsIndexRefresher.onEvent(parsed.event)
          // Run lists are per-project sidebar caches, so a stamped run patches its OWNER's
          // list even when that project is not the mounted scope (#129). Todos/usage/detail
          // stay active-scope-only: those caches are the current project's, and the
          // reconcile-on-switch (3.2's provider swap) refetches the rest.
          // `ping` (project null) always passes — liveness is not project-owned.
          if (parsed.project !== null && (parsed.event.type === 'run' || parsed.event.type === 'run-deleted')) {
            runListBatcher.onEvent(parsed.project, parsed.event)
          }
          if (parsed.project !== null && parsed.project !== activeProject(queryClient)) return
          applyGlobalEvent(queryClient, usage, parsed.event, runDetailRefresher.refresh, relationshipsRefresher)
        })
      }

      for (const name of WORKSPACE_EVENT_NAMES) {
        source.addEventListener(name, (event) => {
          let payload: unknown
          try {
            payload = JSON.parse((event as MessageEvent<string>).data)
          } catch {
            return
          }
          // A registry mutation changes the sidebar for every open tab, not just the one that
          // clicked. `checkout-progress` is deliberately NOT in this branch: a clone emits a
          // line every few hundred ms, and re-listing the registry on each would turn one clone
          // into a request flood (the dialog's own success handler invalidates once, at the end).
          if (name !== 'checkout-progress' && name !== 'automation-change') {
            void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
          }
          for (const listener of [...workspaceListeners]) listener(name, payload)
        })
      }

      source.addEventListener('model-catalog', (event) => {
        let payload: unknown
        try { payload = JSON.parse((event as MessageEvent<string>).data) } catch { return }
        const result = runnerModelCatalogResponseSchema.safeParse(payload)
        if (!result.success || result.data.runner !== 'cursor') return
        const key = workspaceQueryKeys.models('cursor')
        void queryClient.cancelQueries({ queryKey: key })
        queryClient.setQueryData(key, result.data)
      })

      source.addEventListener('provider-status', (event) => {
        let payload: unknown
        try {
          payload = JSON.parse((event as MessageEvent<string>).data)
        } catch {
          return
        }
        const row = parseProviderStatusEventRow(payload)
        if (!row) return
        const key = workspaceQueryKeys.providerStatus
        const response = queryClient.getQueryData<ProviderStatusResponse>(key)
        const updated = applyProviderStatusRow(response, row)
        if (updated !== undefined) {
          queryClient.setQueryData(key, updated)
          return
        }
        // An additive row cannot safely seed the complete provider cache. Discard an old
        // initial fetch and replace it after the server emitted this latch. Further valid rows
        // while that replacement is in flight coalesce into one trailing fetch.
        if (providerStatusRefetching) {
          providerStatusDirty = true
          return
        }
        refetchUncachedProviderStatus()
      })

      source.addEventListener('error', () => {
        // An ordinary drop leaves the stream CONNECTING and the browser retries it on its own —
        // touching that would just race its backoff. CLOSED means it gave up for good, which is
        // what a restarting server produces (the request is answered with a non-2xx while it
        // boots). Nothing would ever reopen it, so the cockpit would sit there looking live and
        // showing yesterday's state.
        if (source?.readyState === CLOSED) reopenLater()
      })
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      // The phone-in-a-pocket case: mobile browsers freeze background tabs, so the stream may have
      // been dead for an hour with no error handler ever running. Whatever is on screen right now
      // is what the reader is about to trust, so ask the server before they read it.
      runListBatcher.flush()
      reconcile(queryClient)
      if (!source || source.readyState === CLOSED) {
        // Don't make them wait out a backoff that started while they were away.
        clearTimeout(reopenTimer)
        reopenTimer = undefined
        connect()
      }
    }

    const onPageHide = (): void => {
      // Full navigation away. React never unmounts for those — the document goes to the
      // back/forward cache still holding this socket, and six cached documents exhaust the
      // browser's per-origin connection pool: the *next* page load then hangs waiting for a
      // free socket. Close eagerly; pageshow reopens if the document ever comes back.
      clearTimeout(reopenTimer)
      reopenTimer = undefined
      runListBatcher.flush()
      source?.close()
    }

    const onPageShow = (event: PageTransitionEvent): void => {
      // Only a bfcache restore (`persisted`) finds this document alive with its stream closed
      // by onPageHide; on a normal load this effect just ran and the stream is fresh.
      if (!event.persisted) return
      reconcile(queryClient)
      connect()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    connect()

    return () => {
      disposed = true
      clearTimeout(reopenTimer)
      runListBatcher.flush()
      runListBatcher.cancel()
      runsIndexRefresher.cancel()
      runDetailRefresher.cancel()
      relationshipsRefresher.cancel()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      // Explicit: an EventSource keeps its socket (and its retry loop) alive on its own, so a
      // dropped reference leaks a connection per remount, and StrictMode remounts every effect.
      source?.close()
      source = null
    }
  }, [queryClient, usage, url])
}

const UsageContext = createContext<UsageStore | null>(null)

/**
 * Mounts the global stream and publishes the live usage map.
 *
 * Must sit inside `QueryClientProvider` (it patches that cache) and be rendered exactly once.
 */
export function GlobalEventsProvider({ children }: { children: ReactNode }) {
  // One store per provider instance, created lazily: a module-level singleton would let one test's
  // ticks bleed into the next, and StrictMode's double-invoked render still yields exactly one.
  const [usage] = useState(createUsageStore)
  useGlobalEvents(usage)
  // The ONE session-long `health` topic subscription (queries.ts): here, at the root that is
  // mounted for the app's whole life, so health stays live continuously instead of flapping with
  // the lifecycles of the ~15 `useHealth` readers below.
  useHealthSubscription()
  return <UsageContext.Provider value={usage}>{children}</UsageContext.Provider>
}

/**
 * The live `{runId → usage}` map. Re-renders the caller on each ~2 s tick and nothing else.
 *
 * Empty outside a provider rather than a throw: "no samples yet" is a real, expected state (it is
 * what every idle cockpit reports), so a component rendered without the stream sees the same
 * nothing it would see before the first tick instead of crashing a tree over telemetry.
 */
export function useUsage(): Record<string, ProcessUsage> {
  const store = useContext(UsageContext)
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.get : getEmptyUsage,
    getEmptyUsage,
  )
}

/**
 * One run's live sample.
 *
 * Selected inside the store subscription rather than by reading the whole map, so a row only
 * re-renders when its own sample is replaced: a tick that carries nothing about this run (it
 * finished, it never had a process) leaves the selected value `undefined` — identical, so React
 * bails out — while `useUsage()` would hand it a new map object every tick.
 */
export function useRunUsage(runId: string | undefined): ProcessUsage | undefined {
  const store = useContext(UsageContext)
  const get = store ? store.get : getEmptyUsage
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (runId ? get()[runId] : undefined),
    () => undefined,
  )
}

const noopSubscribe = (): (() => void) => () => undefined
const getEmptyUsage = (): Record<string, ProcessUsage> => EMPTY_USAGE
