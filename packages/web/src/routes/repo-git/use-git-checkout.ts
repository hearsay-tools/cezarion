import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { createRepoBranch, pullRepo, putConfig } from '@/api/client'
import type { HealthResponse, RepoInfo, RepoPullConfirmation, RepoResponse } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

/**
 * The checkout block's three actions (issue 06 §3): pull the checked-out branch (`POST
 * /repo/pull`, with its risk confirmation), switch or create a branch (`POST /repo/branch`) and
 * pick the agents' base branch (`PUT /config`). `scope` is EXPLICIT, the way the rest of the Git
 * sidebar reads its data: the sidebar renders above the `ProjectScopeProvider`, and a pull can
 * outlive navigation to another project, so every request and every refresh names the project
 * the block was drawn for.
 */
export function useGitCheckout(scope: string, info: RepoInfo) {
  const queryClient = useQueryClient()
  const repoKey = [scope, 'repo'] as const
  const healthKey = [scope, 'health'] as const
  const [confirmation, setConfirmation] = useState<RepoPullConfirmation | null>(null)
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: repoKey }),
      queryClient.invalidateQueries({ queryKey: healthKey }),
    ])

  const pullMutation = useMutation({
    mutationFn: (input: { branch: string; confirm?: true }) => pullRepo(input, scope),
  })

  const pull = async (confirm = false) => {
    const branch = confirmation?.branch ?? info.branch
    try {
      const result = await pullMutation.mutateAsync(confirm ? { branch, confirm: true } : { branch })
      if ('risks' in result) {
        setConfirmation(result)
        return
      }
      setConfirmation(null)
      toast(result.summary)
      await refresh()
    } catch (error) {
      setConfirmation(null)
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      // A refused pull can still have moved something; read the checkout again either way.
      await refresh()
    }
  }

  const switchBranch = useMutation({
    mutationFn: (name: string) => createRepoBranch({ name }, scope),
    onSuccess: async (result) => {
      toast(result.created ? `Created and switched to ${result.branch}` : `Switched to ${result.branch}`)
      // Refresh the rest of both payloads first, then keep the mutation's authoritative checkout
      // even if a read races and briefly returns the previous HEAD.
      await refresh()
      queryClient.setQueryData<RepoResponse>(repoKey, (current) =>
        current?.info ? { ...current, info: { ...current.info, branch: result.branch } } : current,
      )
      // Health is workspace-level, so only patch it when it describes this repo.
      queryClient.setQueryData<HealthResponse>(healthKey, (current) =>
        current?.repo?.root === info.root ? { ...current, repo: { ...current.repo, branch: result.branch } } : current,
      )
    },
    onError,
  })

  const setBase = useMutation({
    mutationFn: (baseBranch: string | null) => putConfig({ baseBranch }, scope),
    onSuccess: (result) => {
      toast(result.baseBranch ? `New tasks now start from ${result.baseBranch}` : 'New tasks now start from the checked-out branch')
      void queryClient.invalidateQueries({ queryKey: repoKey })
      void queryClient.invalidateQueries({ queryKey: [scope, 'config'] })
    },
    onError,
  })

  return {
    hasRemote: Boolean(info.remote),
    pull,
    pulling: pullMutation.isPending,
    confirmation,
    dismissConfirmation: () => {
      if (!pullMutation.isPending) setConfirmation(null)
    },
    switchBranch,
    setBase,
  }
}
