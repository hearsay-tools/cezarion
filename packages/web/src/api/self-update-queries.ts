import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { SelfUpdateStatus, UpdateChannel } from '@open-mercato/cezar-api-client'
import { liveRefetchInterval } from '@/lib/live-refetch'
import {
  applySelfUpdate,
  getSelfUpdate,
  getSelfUpdateDevelopment,
  refreshSelfUpdate,
  setSelfUpdateChannel,
} from './self-update-client'

/** cezar's own updater via `GET /api/v1/workspace/self-update`: workspace-level, like the
 *  `workspace` keys in `./queries`. */
export const selfUpdateQueryKeys = {
  status: ['workspace', 'self-update'] as const,
  development: ['workspace', 'self-update', 'development'] as const,
}

/** cezar's own update state (self-update PoC). Polls fast while an install job runs so the
 *  dialog's log follows npm, and sits idle otherwise — the health chip carries the "update
 *  available" signal on its own. `enabled` gates the fetch to the open dialog. */
export function useSelfUpdate(enabled = true) {
  return useQuery({
    queryKey: selfUpdateQueryKeys.status,
    queryFn: ({ signal }) => getSelfUpdate({ signal }),
    enabled,
    refetchInterval: liveRefetchInterval((query: { state: { data?: SelfUpdateStatus | undefined } }) => (query.state.data?.job?.status === 'running' ? 1_000 : false)),
  })
}

/** The development channel's worktrees and PR builds — fetched only while that channel's
 *  panel is on screen (a git call per worktree plus a GitHub round trip). */
export function useSelfUpdateDevelopment(enabled = true) {
  return useQuery({
    queryKey: selfUpdateQueryKeys.development,
    queryFn: ({ signal }) => getSelfUpdateDevelopment({ signal }),
    enabled,
    staleTime: 30_000,
  })
}

export function useRefreshSelfUpdateDevelopment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => getSelfUpdateDevelopment({ refresh: true }),
    onSuccess: (state) => queryClient.setQueryData(selfUpdateQueryKeys.development, state),
  })
}

export function useRefreshSelfUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => refreshSelfUpdate(),
    onSuccess: (state) => queryClient.setQueryData(selfUpdateQueryKeys.status, state),
  })
}

export function useSetSelfUpdateChannel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (channel: UpdateChannel) => setSelfUpdateChannel(channel),
    onSuccess: (state) => queryClient.setQueryData(selfUpdateQueryKeys.status, state),
  })
}

export function useApplySelfUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (version: string) => applySelfUpdate(version),
    onSuccess: (state) => queryClient.setQueryData(selfUpdateQueryKeys.status, state),
  })
}
