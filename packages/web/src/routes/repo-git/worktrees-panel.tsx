import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { openRunIn, reclaimRunWorktree, reclaimWorktrees } from '@/api/client'
import { queryKeys, useOpenTargets, useWorktrees } from '@/api/queries'
import type { WorktreeInfo } from '@open-mercato/cezar-api-client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { BrushIcon } from 'lucide-react'
import { FolderOpenIcon } from '@/components/design-icons'
import { toast } from '@/components/ui/toaster'
import { formatMem } from '@/lib/tasks-table'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * Git → Cleanup: the worktrees card (#483, moved from Settings by issue 06 §3, reworked by issue
 * 08 §C). Lists every task worktree materialized on disk with its size, age and retention state
 * (`in use`, `reclaimable` past the keep limit, `kept · newest N` inside it). The per-row action
 * is Reclaim: the DIRECTORY only, through retention's own rule (`POST /worktrees/:runId/reclaim`);
 * the branch stays, so nothing on this card can delete work. Rows a live or reviewable task stands
 * on show "in use" and have no action. The header's "Reclaim N GB now" is the bulk enforcer,
 * sized from exactly the rows it will take (`pastKeep`), behind the design-system AlertDialog
 * (native confirm() is banned). Live-updates through the global event stream (queryKeys.worktrees).
 */
export function WorktreesPanel() {
  const worktrees = useWorktrees()
  const targets = useOpenTargets()
  const folderTarget = targets.data?.targets.find((target) => target.id === 'finder')
  const openFolder = useMutation({
    mutationFn: (runId: string) => openRunIn(runId, folderTarget!.id),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.worktrees }),
      queryClient.invalidateQueries({ queryKey: queryKeys.repoBranches }),
    ])

  const reclaim = useMutation({
    mutationFn: () => reclaimWorktrees(),
    onSuccess: (result) => {
      void refresh()
      toast(
        result.reclaimed.length === 0
          ? 'Nothing to reclaim — no finished worktrees exceed the keep limit'
          : `Reclaimed ${result.reclaimed.length} worktree${result.reclaimed.length === 1 ? '' : 's'} (branch kept)`,
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const reclaimOne = useMutation({
    mutationFn: (worktree: WorktreeInfo) => reclaimRunWorktree(worktree.runId),
    onSuccess: (_result, worktree) => {
      void refresh()
      toast(`Reclaimed the worktree of ${worktree.title} (branch kept)`)
    },
    onError: (error: Error) => {
      void refresh()
      toast(error.message, { tone: 'danger' })
    },
  })

  if (worktrees.isPending) {
    return (
      <p data-slot="worktrees-loading" className="text-[13px] text-soft-foreground">
        Loading worktrees…
      </p>
    )
  }
  if (worktrees.isError) {
    return (
      <p data-slot="worktrees-error" className="text-[13px] text-danger">
        Worktrees did not load: {worktrees.error.message}
      </p>
    )
  }

  const { worktrees: rows, totalBytes, keep } = worktrees.data
  const busy = reclaim.isPending || reclaimOne.isPending
  // Exactly the rows the enforcer takes: reclaimable AND past the newest `keep` (#566).
  const pastKeep = rows.filter((row) => row.pastKeep)
  const canReclaim = pastKeep.length > 0
  const pastKeepBytes = pastKeep.some((row) => row.sizeBytes === null)
    ? null
    : pastKeep.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
  const reclaimLabel = !canReclaim
    ? 'Reclaim now'
    : pastKeepBytes
      ? `Reclaim ${formatMem(pastKeepBytes)} now`
      : `Reclaim ${pastKeep.length} now`

  // The heading names a size only when there is one: "Worktrees on disk · 0 kB" reads as a glitch.
  const headingSize = totalBytes ? formatMem(totalBytes) : null

  return (
    <section data-slot="worktrees-panel" aria-labelledby="worktrees-panel-title" className="flex flex-col rounded-[8px] border border-border">
      <div className="flex flex-col gap-[10px] border-b border-border px-[14px] py-[12px] md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <h2 id="worktrees-panel-title" className="text-[13px] font-semibold text-foreground">
            Worktrees on disk{headingSize ? ` · ${headingSize}` : ''}
          </h2>
          <p data-slot="worktrees-retention" className="text-[11.5px] leading-[17px] text-soft-foreground">
            {keep === 0
              ? 'Retention is unlimited ('
              : `Retention keeps the newest ${keep} finished checkout${keep === 1 ? '' : 's'} (`}
            <Link to="/settings/worktrees" data-slot="worktrees-retention-link" className="underline-offset-2 hover:text-foreground hover:underline">
              Settings › Worktrees
            </Link>
            {keep === 0 ? '), so nothing is reclaimed on its own.' : ') and reclaims the rest.'}
            {' '}Reclaim removes the directory only; the branch stays, so its work stays recoverable.
          </p>
        </div>
        <button
          type="button"
          data-action="worktrees-reclaim-now"
          disabled={busy || !canReclaim}
          title={canReclaim ? undefined : 'Nothing past the keep limit to reclaim'}
          onClick={() => setConfirming(true)}
          className="inline-flex h-[28px] shrink-0 items-center gap-[5px] self-start rounded-[6px] bg-muted px-[10px] text-[12px] font-medium text-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 disabled:hover:brightness-100 max-md:h-11 md:self-center"
        >
          <BrushIcon aria-hidden="true" className="size-[12px]" />
          {reclaimLabel}
        </button>
      </div>

      {rows.length === 0 ? (
        <p data-slot="worktrees-empty" className="px-[14px] py-[12px] text-[12.5px] text-soft-foreground">
          No task worktrees on disk.
        </p>
      ) : (
        <ul aria-label="Task worktrees on disk" className="flex flex-col">
          {rows.map((w) => (
            <WorktreeRow
              key={w.runId}
              worktree={w}
              keep={keep}
              disabled={busy}
              onOpen={folderTarget ? () => openFolder.mutate(w.runId) : undefined}
              opening={openFolder.isPending}
              onReclaim={() => reclaimOne.mutate(w)}
            />
          ))}
        </ul>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reclaim old worktrees?</AlertDialogTitle>
            <AlertDialogDescription>
              {pastKeep.length} finished worktree{pastKeep.length === 1 ? '' : 's'} beyond the keep limit
              {pastKeepBytes ? ` (${formatMem(pastKeepBytes)})` : ''} {pastKeep.length === 1 ? 'is' : 'are'} reclaimed now,
              directory only. Their branches are kept, so the work stays recoverable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              data-action="worktrees-confirm"
              onClick={() => {
                reclaim.mutate()
                setConfirming(false)
              }}
            >
              {reclaimLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** Statuses whose checkout a live or reviewable task still stands on. */
const IN_USE = new Set<WorktreeInfo['status']>(['queued', 'running', 'waiting', 'review'])

/** What retention will do with a row, in the listing's own terms (`reclaimable`, `pastKeep`). */
export function retentionState(worktree: WorktreeInfo, keep: number): { label: string; tone: 'in-use' | 'plain' } {
  if (IN_USE.has(worktree.status) || !worktree.reclaimable) return { label: 'in use', tone: 'in-use' }
  if (worktree.pastKeep) return { label: 'reclaimable', tone: 'plain' }
  return { label: keep > 0 ? `kept · newest ${keep}` : 'kept', tone: 'plain' }
}

function WorktreeRow({
  worktree,
  keep,
  disabled,
  onOpen,
  opening,
  onReclaim,
}: {
  worktree: WorktreeInfo
  keep: number
  disabled: boolean
  onOpen?: () => void
  opening: boolean
  onReclaim: () => void
}) {
  const state = retentionState(worktree, keep)
  const age = shortAge(worktree.finishedAt ?? undefined)
  const status = worktree.status === 'review' ? 'at review' : age ? `${worktree.status} ${age} ago` : worktree.status
  const stateLabel = (
    <span
      data-slot="worktree-state"
      data-state={state.tone === 'in-use' ? 'in-use' : worktree.pastKeep ? 'reclaimable' : 'kept'}
      className={cn('text-[11.5px]', state.tone === 'in-use' ? 'text-status-running' : 'text-soft-foreground')}
    >
      {state.label}
    </span>
  )
  const iconButton = 'flex size-[28px] shrink-0 items-center justify-center rounded-[6px] text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-md:size-11'
  return (
    <li data-slot="worktree-row" data-run={worktree.runId} className="flex min-h-[44px] items-center gap-[12px] border-b border-border px-[14px] py-[4px] last:border-0">
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate text-[12.5px] text-foreground" title={worktree.title}>{worktree.title}</span>
        <span className="truncate font-mono text-[10.5px] text-soft-foreground">
          {worktree.branch ?? worktree.runId.slice(0, 8)} · {status}
          <span className="md:hidden"> · {state.label}</span>
        </span>
      </div>
      <span data-slot="worktree-size" className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
        {worktree.sizeBytes !== null ? formatMem(worktree.sizeBytes) || '0 kB' : '—'}
      </span>
      <span className="hidden shrink-0 md:inline">{stateLabel}</span>
      {onOpen ? (
        <button type="button" className={iconButton} aria-label={`Open folder for ${worktree.title}`} title="Open folder" disabled={opening} onClick={onOpen}>
          <FolderOpenIcon aria-hidden="true" className="size-[13px]" />
        </button>
      ) : null}
      {/* Reclaim is the directory only (issue 08 §B4): the branch stays. The task screen keeps
          "Remove worktree" (directory AND branch); this card never deletes a branch. */}
      {state.tone === 'in-use' ? null : (
        <button
          type="button"
          data-action="worktree-reclaim"
          aria-label={`Reclaim the worktree of ${worktree.title} (branch kept)`}
          title="Reclaim the directory (branch kept)"
          disabled={disabled}
          onClick={onReclaim}
          className={iconButton}
        >
          <BrushIcon aria-hidden="true" className="size-[13px]" />
        </button>
      )}
    </li>
  )
}
