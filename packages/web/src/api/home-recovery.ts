import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { homeRecoveryReaderSchema, type HomeFile, type HomeRecovery, type HomeRecoveryAction } from '@open-mercato/cezar-api-client/contract/home-recovery'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { ApiError, cez, init, unwrap, type ReadOptions } from './client'
import { onLiveReconcile } from './live-coordinator'
import { pageIsActive, subscribePageActivity, usePageActive } from './live-visibility'
import { queryKeys, workspaceQueryKeys } from './queries'
import { subscribeTopic } from './ws'

export const HOME_RECOVERY_QUERY_KEY = ['workspace', 'home-recovery'] as const

function parseRecovery(value: unknown): HomeRecovery {
  const parsed = homeRecoveryReaderSchema.safeParse(value)
  if (!parsed.success) throw new ApiError(200, 'the cezar server answered /home/recovery with an unexpected body')
  return parsed.data
}

export async function getHomeRecovery(opts?: ReadOptions): Promise<HomeRecovery> {
  return parseRecovery(await unwrap(await cez.api.v1.home.recovery.$get({}, init(opts)), '/home/recovery'))
}

/** Readers share one workspace cache. Only the root controller below owns live demand. */
export function useHomeRecovery() {
  const active = usePageActive()
  return useQuery({ queryKey: HOME_RECOVERY_QUERY_KEY, queryFn: ({ signal }) => getHomeRecovery({ signal }),
    enabled: active, staleTime: Infinity, retry: false })
}

/** Call once at the root, beside health's controller. Hidden and remote documents hold no topic. */
export function useHomeRecoverySubscription(): void {
  const client = useQueryClient()
  useEffect(() => {
    let mounted = true
    const lifetime = new AbortController()
    let releaseTopic: (() => void) | undefined
    const refresh = async (signal?: AbortSignal) => {
      if (!pageIsActive()) return
      await client.fetchQuery({ queryKey: HOME_RECOVERY_QUERY_KEY,
        queryFn: ({ signal: querySignal }) => getHomeRecovery({ signal: AbortSignal.any(
          [querySignal, lifetime.signal, ...(signal ? [signal] : [])]) }), staleTime: 0, retry: false })
    }
    const fold = (value: unknown) => {
      let snapshot: HomeRecovery
      try { snapshot = parseRecovery(value) }
      catch { void refresh().catch(() => {}); return }
      void client.cancelQueries({ queryKey: HOME_RECOVERY_QUERY_KEY, exact: true }).then(() => {
        if (mounted && pageIsActive()) client.setQueryData(HOME_RECOVERY_QUERY_KEY, snapshot)
      })
    }
    const follow = () => {
      const local = client.getQueryData<HealthResponse>(queryKeys.health)?.capabilities?.localHandoff === true
      if (local && pageIsActive() && !releaseTopic) releaseTopic = subscribeTopic('home:recovery', fold)
      else if ((!local || !pageIsActive()) && releaseTopic) { releaseTopic(); releaseTopic = undefined }
    }
    follow()
    const releaseCache = client.getQueryCache().subscribe(follow)
    const releaseActivity = subscribePageActivity(active => {
      follow()
      if (active) void refresh().catch(() => {})
      else void client.cancelQueries({ queryKey: HOME_RECOVERY_QUERY_KEY, exact: true })
    })
    // The shared coordinator supplies finite reads when topic delivery is unavailable.
    const releaseReconcile = onLiveReconcile(signal => refresh(signal))
    return () => { mounted = false; lifetime.abort(); releaseReconcile(); releaseActivity(); releaseCache(); releaseTopic?.() }
  }, [client])
}

function invalidateHomeConsumers(client: QueryClient, file: HomeFile): void {
  const keys = file === 'config.json' ? [workspaceQueryKeys.projects, workspaceQueryKeys.config, workspaceQueryKeys.runsIndex]
    : file === 'agent-accounts.json' ? [workspaceQueryKeys.agentProfiles, workspaceQueryKeys.providerStatus]
      : file === 'ui-state.json' ? [workspaceQueryKeys.uiState] : []
  for (const queryKey of keys) void client.invalidateQueries({ queryKey })
}

function useRecoveryAction(action: 'restore' | 'accept' | 'import') {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (incident: HomeRecoveryAction) => parseRecovery(await unwrap(
      await cez.api.v1.home.recovery[action].$post({ json: incident }), `/home/recovery/${action}`)),
    onSuccess: async (snapshot, incident) => {
      await client.cancelQueries({ queryKey: HOME_RECOVERY_QUERY_KEY, exact: true })
      client.setQueryData(HOME_RECOVERY_QUERY_KEY, snapshot)
      invalidateHomeConsumers(client, incident.file)
    },
  })
}

export const useRestoreHomeRecovery = () => useRecoveryAction('restore')
export const useAcceptHomeRecovery = () => useRecoveryAction('accept')
export const useImportHomeRecovery = () => useRecoveryAction('import')
