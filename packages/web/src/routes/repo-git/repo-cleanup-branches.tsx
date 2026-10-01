import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { deleteRepoBranches } from '@/api/client'
import { queryKeys, useRepoBranches } from '@/api/queries'
import type { RepoBranchEntry } from '@open-mercato/cezar-api-client'
import { ChevronRightIcon, Trash2Icon } from '@/components/design-icons'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { NO_FORGE_NOTE } from './repo-not-landed'

/**
 * Git → Cleanup's second card (issue 08 §C): the `merged` and `empty` branches, the only classes
 * the server bulk-deletes. Each group expands to its list; the header's "Delete N branches"
 * confirms once with the count and sends every name. The server re-classifies at delete time and
 * returns anything that stopped being safe under `refused`, so a stale list can never delete work
 * that is not on the base.
 */
export function CleanupBranchesCard({ base }: { base: string }) {
  const branches = useRepoBranches()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<Record<'merged' | 'empty', boolean>>({ merged: false, empty: false })
  const [confirming, setConfirming] = useState(false)

  const merged = (branches.data?.branches ?? []).filter((entry) => entry.class === 'merged')
  const empty = (branches.data?.branches ?? []).filter((entry) => entry.class === 'empty')
  const safe = [...merged, ...empty]

  const remove = useMutation({
    mutationFn: (names: string[]) => deleteRepoBranches({ names }),
    onSuccess: (result) => {
      const refused = result.refused.length
      toast(`Deleted ${result.deleted.length} branch${result.deleted.length === 1 ? '' : 'es'}${refused ? `; kept ${refused} that ${refused === 1 ? 'is' : 'are'} no longer safe to delete` : ''}`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    },
    onError: (error: Error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      toast(error.message, { tone: 'danger' })
    },
  })

  if (branches.isPending) {
    return <p data-slot="cleanup-branches-loading" className="text-[13px] text-soft-foreground">Loading branches…</p>
  }
  if (branches.isError) {
    return <p data-slot="cleanup-branches-error" className="text-[13px] text-danger">Branches did not load: {branches.error.message}</p>
  }
  const count = safe.length
  const noun = `branch${count === 1 ? '' : 'es'}`

  return (
    <section data-slot="cleanup-branches" aria-labelledby="cleanup-branches-title" className="flex flex-col rounded-[8px] border border-border">
      <div className="flex flex-col gap-[10px] border-b border-border px-[14px] py-[12px] md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <h2 id="cleanup-branches-title" className="text-[13px] font-semibold text-foreground">
            Branches safe to delete · {count}
          </h2>
          <p className="text-[11.5px] leading-[17px] text-soft-foreground">
            Their work is already on {base}, or they have none. Deleting loses nothing.
          </p>
        </div>
        <button
          type="button"
          data-action="cleanup-branches-delete"
          disabled={count === 0 || remove.isPending}
          onClick={() => setConfirming(true)}
          className="inline-flex h-[28px] shrink-0 items-center gap-[5px] self-start rounded-[6px] bg-muted px-[10px] text-[12px] font-medium text-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 disabled:hover:brightness-100 max-md:h-11 md:self-center"
        >
          <Trash2Icon aria-hidden="true" className="size-[12px]" />
          {remove.isPending ? 'Deleting…' : `Delete ${count} ${noun}`}
        </button>
      </div>
      <BranchGroup
        kind="merged"
        title={`Merged into ${base}`}
        hint={branches.data.prStateKnown ? 'including squash-merged PRs, read from the PR state' : NO_FORGE_NOTE.toLowerCase()}
        rows={merged}
        open={open.merged}
        onToggle={() => setOpen((current) => ({ ...current, merged: !current.merged }))}
      />
      <BranchGroup
        kind="empty"
        title="Empty"
        hint="no commits beyond the fork point"
        rows={empty}
        open={open.empty}
        onToggle={() => setOpen((current) => ({ ...current, empty: !current.empty }))}
      />

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {count} {noun}?</AlertDialogTitle>
            <AlertDialogDescription>
              {merged.length} merged into {base} and {empty.length} empty. Their work is already on {base}, or
              they have none. Anything that stopped being safe since this list loaded is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              data-action="cleanup-branches-confirm"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => {
                remove.mutate(safe.map((entry) => entry.name))
                setConfirming(false)
              }}
            >
              Delete {count} {noun}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function BranchGroup({ kind, title, hint, rows, open, onToggle }: {
  kind: 'merged' | 'empty'
  title: string
  hint: string
  rows: RepoBranchEntry[]
  open: boolean
  onToggle: () => void
}) {
  const listId = `cleanup-branches-${kind}`
  return (
    <div data-slot="cleanup-branch-group" data-group={kind} className="border-b border-border last:border-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        disabled={rows.length === 0}
        onClick={onToggle}
        className="flex min-h-[44px] w-full items-center gap-[12px] px-[14px] py-[4px] text-left hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:hover:bg-transparent"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="truncate text-[12.5px] text-foreground">{title} · {rows.length}</span>
          <span className="truncate text-[11px] text-soft-foreground">{hint}</span>
        </span>
        {rows.length > 0 ? (
          <ChevronRightIcon aria-hidden="true" className={cn('size-[13px] shrink-0 text-soft-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        ) : null}
      </button>
      {open ? (
        <ul id={listId} aria-label={title} className="flex flex-col pb-[6px]">
          {rows.map((entry) => (
            <li key={entry.name} data-slot="cleanup-branch-row" data-branch={entry.name} className="flex min-h-[32px] items-center gap-[10px] px-[14px] pl-[26px] text-[11.5px]">
              <span className="shrink-0 font-mono text-muted-foreground">{entry.name}</span>
              {entry.runId ? (
                <Link to={`/tasks/${entry.runId}`} className="min-w-0 flex-1 truncate text-soft-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {entry.title ?? 'Open the task'}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate text-soft-foreground">{entry.lastCommit.subject}</span>
              )}
              {entry.pr ? <span className="shrink-0 text-soft-foreground">PR #{entry.pr.number}</span> : null}
              <span className="shrink-0 tabular-nums text-soft-foreground">{shortAge(entry.lastCommit.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
