import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApplicationUpdateState, HealthResponse } from '@open-mercato/cezar-api-client'
import { ApiError, applyApplicationUpdate, restartApplication } from '@/api/client'
import { queryKeys } from '@/api/queries'

const RESTART_VERSION_KEY = 'cez:application-restart-from'
// Preparation can wait for npm (120 seconds), lock acquisition and recovery-copy I/O.
// These browser waits exceed the ordinary server work but cannot hold the UI forever.
const APPLY_WAIT_MS = 240_000
const RESTART_WAIT_MS = 30_000
const UNCERTAIN_RESPONSE = 'The response was lost; update status is unknown. Reconnect or check the current state before retrying.'

type ActiveOperation = {
  controller: AbortController
  initialState: ApplicationUpdateState | undefined
  initialCacheState: ApplicationUpdateState | undefined
  initialVersion: string | undefined
  kind: 'apply' | 'restart'
  reconciledRestart?: ApplicationUpdateState
  timer: ReturnType<typeof setTimeout>
  resolve: (state: ApplicationUpdateState | undefined) => void
}

function isAuthoritativeOutcome(operation: ActiveOperation, health: HealthResponse | undefined): health is HealthResponse & { applicationUpdate: ApplicationUpdateState } {
  const state = health?.applicationUpdate
  return Boolean(state && (state.status === 'error' || operation.kind === 'apply' && state.status === 'ready'
    || operation.kind === 'restart' && (state.status === 'restarting'
      || state.status === 'idle' && operation.initialVersion && health.version !== operation.initialVersion)))
}

/** Owns transient mutation feedback while health remains the authoritative durable state. */
export function useApplicationUpdate(health: HealthResponse | undefined, reloadDocument: () => void = () => window.location.reload()) {
  const queryClient = useQueryClient()
  const active = React.useRef<ActiveOperation | null>(null)
  const healthRef = React.useRef(health)
  healthRef.current = health
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [offline, setOffline] = React.useState(() => !navigator.onLine)
  const seenVersion = React.useRef(health?.version ?? null)
  const reloading = React.useRef(false)
  const [restartFrom, setRestartFrom] = React.useState(() => {
    try { return window.sessionStorage.getItem(RESTART_VERSION_KEY) } catch { return null }
  })

  React.useEffect(() => {
    const sync = () => setOffline(!navigator.onLine)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync) }
  }, [])

  React.useEffect(() => {
    if (health?.applicationUpdate?.status === 'ready' || health?.applicationUpdate?.status === 'restarting') setError(null)
  }, [health?.applicationUpdate?.status])

  React.useEffect(() => {
    if (!health?.version) return
    if (!seenVersion.current) seenVersion.current = health.version
    const changed = seenVersion.current !== health.version
    const confirmedRestart = Boolean(restartFrom && health.version !== restartFrom)
    if (changed || confirmedRestart || restartFrom && health.applicationUpdate?.status === 'error') {
      try { window.sessionStorage.removeItem(RESTART_VERSION_KEY) } catch { /* private storage may be unavailable */ }
      setRestartFrom(null)
    }
    if ((changed || confirmedRestart) && !reloading.current) {
      reloading.current = true
      reloadDocument()
    }
  }, [health?.version, health?.applicationUpdate?.status, restartFrom, reloadDocument])

  const reconcile = React.useCallback((state: NonNullable<HealthResponse['applicationUpdate']>) => {
    queryClient.setQueryData<HealthResponse>(queryKeys.health, (current) => current ? { ...current, applicationUpdate: state } : current)
  }, [queryClient])

  const finish = React.useCallback((operation: ActiveOperation, outcome: { state?: ApplicationUpdateState; source: 'health' | 'response' | 'failure' | 'timeout'; cause?: unknown }) => {
    if (active.current !== operation) return // An aborted request may still resolve much later.
    if (operation.reconciledRestart && (outcome.source === 'timeout'
      || outcome.source === 'failure' && outcome.cause instanceof ApiError && outcome.cause.status === 0)) {
      outcome = { source: 'health', state: operation.reconciledRestart }
    }
    active.current = null
    clearTimeout(operation.timer)
    if (outcome.source !== 'response') operation.controller.abort()
    setBusy(false)
    if (outcome.source === 'response' && outcome.state) reconcile(outcome.state)
    if (outcome.source === 'timeout') setError(UNCERTAIN_RESPONSE)
    else if (outcome.source === 'failure') setError(outcome.cause instanceof Error ? outcome.cause.message : 'The request failed.')
    else setError(null)
    if (outcome.source === 'failure' && operation.kind === 'restart') {
      try { window.sessionStorage.removeItem(RESTART_VERSION_KEY) } catch { /* degraded private storage */ }
      setRestartFrom(null)
    }
    if (outcome.source === 'timeout' || outcome.source === 'failure') {
      // One reconciliation through the existing health query; the root subscription remains
      // responsible for subsequent state changes. Never automatically replay a mutation.
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
    }
    operation.resolve(outcome.state)
  }, [queryClient, reconcile])

  React.useEffect(() => {
    const operation = active.current
    const state = health?.applicationUpdate
    if (!operation) return
    if ((state === operation.initialState && health?.version === operation.initialVersion)
      || !isAuthoritativeOutcome(operation, health)) return
    if (operation.kind === 'restart' && state?.status === 'restarting') {
      // Health can publish before helper arming completes. Release the UI, but
      // retain the POST until its acknowledgement, deadline or unmount. The
      // server owns the restart even if that transport subsequently disconnects.
      operation.reconciledRestart = state
      setBusy(false)
      setError(null)
      operation.resolve(state)
      return
    }
    finish(operation, { source: 'health', state })
  }, [health?.applicationUpdate, health?.version, finish])

  React.useEffect(() => () => {
    const operation = active.current
    if (!operation) return
    active.current = null
    clearTimeout(operation.timer)
    operation.controller.abort()
    operation.resolve(undefined)
  }, [])

  const run = React.useCallback((kind: ActiveOperation['kind'], request: typeof applyApplicationUpdate): Promise<ApplicationUpdateState | undefined> => {
    if (active.current) return Promise.resolve(undefined)
    const controller = new AbortController()
    const initialState = healthRef.current?.applicationUpdate
    const initialVersion = healthRef.current?.version
    const initialCacheState = queryClient.getQueryData<HealthResponse>(queryKeys.health)?.applicationUpdate
    setBusy(true)
    setError(null)
    return new Promise((resolve) => {
      const operation: ActiveOperation = {
        controller, initialState, initialCacheState, initialVersion, kind, resolve,
        timer: setTimeout(() => finish(operation, { source: 'timeout' }), kind === 'apply' ? APPLY_WAIT_MS : RESTART_WAIT_MS),
      }
      active.current = operation
      void request(controller.signal).then((response) => {
        if (active.current !== operation) return
        // A health publication that won the race is authoritative even if React has not
        // rendered it yet. Do not let an older HTTP response move Ready back to idle/error.
        const cachedHealth = queryClient.getQueryData<HealthResponse>(queryKeys.health)
        const latestHealth = healthRef.current
        const authoritative = cachedHealth?.applicationUpdate !== initialCacheState && isAuthoritativeOutcome(operation, cachedHealth)
          ? cachedHealth.applicationUpdate
          : latestHealth?.applicationUpdate !== initialState && isAuthoritativeOutcome(operation, latestHealth)
            ? latestHealth.applicationUpdate : undefined
        finish(operation, authoritative
          ? { source: 'health', state: authoritative }
          : { source: 'response', state: response.state })
      }, (cause: unknown) => finish(operation, { source: 'failure', cause }))
    })
  }, [finish, queryClient])

  const apply = React.useCallback(async () => { await run('apply', applyApplicationUpdate) }, [run])
  const restart = React.useCallback(async () => {
    if (active.current) return
    const version = healthRef.current?.version
    const acknowledged = await run('restart', restartApplication)
    // Only keep a reload marker when the server has acknowledged the restart.
    if (version && acknowledged?.status === 'restarting') {
      try { window.sessionStorage.setItem(RESTART_VERSION_KEY, version) } catch { /* degraded private storage */ }
      setRestartFrom(version)
    }
  }, [run])

  return { apply, restart, busy, error, offline }
}
