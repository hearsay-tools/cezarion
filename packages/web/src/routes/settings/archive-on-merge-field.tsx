import { useId } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { putConfig, putWorkspaceConfig } from '@/api/client'
import { queryKeys, useConfig, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { ConfigResponse, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'

type Preference = Pick<ConfigResponse, 'archiveOnMerge' | 'effectiveArchiveOnMerge' | 'archiveOnMergeSource'>

export function ArchiveOnMergeField() {
  const config = useConfig()
  if (config.isPending) return <p role="status">Loading task settings…</p>
  if (config.isError) return <p role="alert" className="text-sm text-danger">Task settings did not load: {config.error.message}</p>
  return <ArchivePreference config={config.data} scope="project" />
}

export function TasksSection() {
  const config = useWorkspaceConfig()
  if (config.isPending) return <p role="status" className="p-4 text-sm">Loading task settings…</p>
  if (config.isError) return <p role="alert" className="p-4 text-sm text-danger">Task settings did not load: {config.error.message}</p>
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6"><ArchivePreference config={config.data} scope="global" /></div>
}

function ArchivePreference({ config, scope }: { config: Preference; scope: 'project' | 'global' }) {
  const id = useId()
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: async ({ archiveOnMerge, projectKey }: { archiveOnMerge: boolean | null; projectKey: typeof queryKeys.config }): Promise<ConfigResponse | WorkspaceConfigResponse> => scope === 'project' ? putConfig({ archiveOnMerge }, projectKey[0]) : putWorkspaceConfig({ archiveOnMerge }),
    onSuccess: (result, { projectKey }) => {
      if (scope === 'project') client.setQueryData(projectKey, result)
      else {
        client.setQueryData(workspaceQueryKeys.config, result)
        void client.invalidateQueries({ predicate: query => query.queryKey.at(-1) === 'config' && query.queryKey !== workspaceQueryKeys.config })
      }
    },
  })
  return <section data-slot="archive-on-merge-field" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-foreground">Archive tasks after PRs merge</label>
      <p id={`${id}-hint`} className="text-[13px] text-muted-foreground">Automatically archive a settled task and its workers once all their associated pull requests merge. History stays available in Archived.</p>
    </div>
    <select
      id={id}
      aria-describedby={`${id}-hint ${id}-effective`}
      className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring active:bg-muted disabled:opacity-50"
      value={config.archiveOnMerge === null ? 'inherit' : config.archiveOnMerge ? 'enabled' : 'disabled'}
      disabled={save.isPending}
      onChange={event => save.mutate({ archiveOnMerge: event.target.value === 'inherit' ? null : event.target.value === 'enabled', projectKey: queryKeys.config })}
    >
      <option value="inherit">{scope === 'project' ? 'Inherit global setting' : 'Use default'}</option>
      <option value="enabled">Enabled</option>
      <option value="disabled">Disabled</option>
    </select>
    <p id={`${id}-effective`} className="text-[13px] text-muted-foreground">Currently {config.effectiveArchiveOnMerge ? 'enabled' : 'disabled'} · {config.archiveOnMergeSource} setting.</p>
    <p className="text-[13px] text-muted-foreground">Unarchive restores the task. It stays visible until a later associated PR merges.</p>
    {save.isPending ? <p role="status" className="text-sm text-muted-foreground">Saving…</p> : null}
    {save.isError ? <p role="alert" className="text-sm text-danger">Could not save: {save.error.message}</p> : null}
  </section>
}
