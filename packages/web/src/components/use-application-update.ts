import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { applyApplicationUpdate, restartApplication } from '@/api/client'
import { queryKeys } from '@/api/queries'

const RESTART_VERSION_KEY = 'cez:application-restart-from'

/** Owns transient mutation feedback while health remains the authoritative durable state. */
export function useApplicationUpdate(health: HealthResponse | undefined, reloadDocument: () => void = () => window.location.reload()) {
  const queryClient = useQueryClient()
  const pending = React.useRef(false)
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

  const run = React.useCallback(async (operation: typeof applyApplicationUpdate) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await operation()
      reconcile(response.state)
      return response.state
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.')
      return undefined
    } finally {
      pending.current = false
      setBusy(false)
    }
  }, [reconcile])

  const apply = React.useCallback(async () => { await run(applyApplicationUpdate) }, [run])
  const restart = React.useCallback(async () => {
    if (pending.current) return
    const version = health?.version
    const acknowledged = await run(restartApplication)
    // Only keep a reload marker when the server has acknowledged the restart.
    if (version && acknowledged?.status === 'restarting') {
      try { window.sessionStorage.setItem(RESTART_VERSION_KEY, version) } catch { /* degraded private storage */ }
      setRestartFrom(version)
    }
  }, [health?.version, run])

  return { apply, restart, busy, error, offline }
}
