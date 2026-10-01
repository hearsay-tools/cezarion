import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { openRunIn, reclaimWorktrees, removeRunWorktree } from '@/api/client'
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
import { BrushIcon, Trash2Icon } from 'lucide-react'
import { FolderOpenIcon } from '@/components/design-icons'
import { toast } from '@/components/ui/toaster'
import { formatMem } from '@/lib/tasks-table'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/** What the confirm dialog is about — a bulk reclaim, or one row's delete. */
type Confirming = { kind: 'reclaim' } | { kind: 'delete'; runId: string; title: string } | null

/**
 * Git → Cleanup: the worktrees card (#483, moved from Settings by issue 06 §3). Lists every task
 * worktree materialized on disk with its size, age and retention state; a
 * per-row Delete (reclaims the directory AND branch, the spec-006 route), a
 * footer with disk used and the reclaimable-vs-keep budget (#566), and a
 * "Reclaim now" button that runs the count-based enforcer when reclaimable
 * finished worktrees exceed keep. Both destructive actions
 * confirm through the design-system AlertDialog (native confirm() is banned).
 * Live-updates through the global event stream (queryKeys.worktrees).
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
  const [confirming, setConfirming] = useState<Confirming>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })

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

  const remove = useMutation({
    mutationFn: (runId: string) => removeRunWorktree(runId),
    onSuccess: () => {
      void refresh()
      toast('Worktree removed')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
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
  const busy = reclaim.isPending || remove.isPending
  // Keep budget is reclaimable finished worktrees, not every on-disk dir (#566).
  const reclaimableCount = rows.filter((row) => row.reclaimable).length
  const canReclaim = keep > 0 && reclaimableCount > keep

  const runConfirmed = () => {
    if (confirming?.kind === 'reclaim') reclaim.mutate()
    else if (confirming?.kind === 'delete') remove.mutate(confirming.runId)
    setConfirming(null)
  }

  const size = totalBytes !== null ? formatMem(totalBytes) || '0 kB' : null
  // The heading names a size only when there is one: "Worktrees on disk · 0 kB" reads as a glitch.
  const headingSize = totalBytes ? size : null

  return (
    <section data-slot="worktrees-panel" aria-labelledby="worktrees-panel-title" className="flex flex-col rounded-[8px] border border-border">
      <div className="flex flex-col gap-[10px] border-b border-border px-[14px] py-[12px] md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <h2 id="worktrees-panel-title" className="text-[13px] font-semibold text-foreground">
            Worktrees on disk{headingSize ? ` · ${headingSize}` : ''}
          </h2>
          <p className="text-[11.5px] leading-[17px] text-soft-foreground">
            {keep === 0
              ? 'Finished tasks keep their checkout for review. Retention is unlimited ('
              : `Finished tasks keep their checkout for review; retention keeps the newest ${keep} (`}
            <Link to="/settings/worktrees" data-slot="worktrees-retention-link" className="underline-offset-2 hover:text-foreground hover:underline">
              Settings › Worktrees
            </Link>
            {keep === 0 ? '), so nothing is reclaimed on its own.' : ') and reclaims the rest.'}
            {' '}Reclaiming a directory keeps its branch.
          </p>
          <p data-slot="worktrees-footer" className="text-[11.5px] leading-[17px] text-soft-foreground">
            {rows.length} worktree{rows.length === 1 ? '' : 's'}
            {size !== null ? ` · ${size} on disk` : ' · size unavailable'}
            {' · '}
            {keep === 0 ? 'keeping all (unlimited)' : `${reclaimableCount} reclaimable, keeping the last ${keep}`}
          </p>
        </div>
        <button
          type="button"
          data-action="worktrees-reclaim-now"
          disabled={busy || !canReclaim}
          title={canReclaim ? undefined : 'Nothing past the keep limit to reclaim'}
          onClick={() => setConfirming({ kind: 'reclaim' })}
          className="inline-flex h-[28px] shrink-0 items-center gap-[5px] self-start rounded-[6px] bg-muted px-[10px] text-[12px] font-medium text-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 disabled:hover:brightness-100 md:self-center"
        >
          <BrushIcon aria-hidden="true" className="size-[12px]" />
          Reclaim now
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
              disabled={busy}
              onOpen={folderTarget ? () => openFolder.mutate(w.runId) : undefined}
              opening={openFolder.isPending}
              onDelete={() => setConfirming({ kind: 'delete', runId: w.runId, title: w.title })}
            />
          ))}
        </ul>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === 'delete' ? 'Delete this worktree and its branch?' : 'Reclaim old worktrees?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === 'delete' ? (
                <>
                  This removes the worktree directory and its branch — the local-only work is not
                  recoverable afterwards.
                  <span className="mt-1 block truncate font-medium text-foreground" title={confirming.title}>
                    {confirming.title}
                  </span>
                </>
              ) : (
                'Finished worktrees beyond the keep-limit are reclaimed now (directory only). Their branches are kept, so the work stays recoverable.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-action="worktrees-confirm"
              className={confirming?.kind === 'delete' ? 'bg-danger text-danger-foreground hover:brightness-[0.96]' : undefined}
              onClick={runConfirmed}
            >
              {confirming?.kind === 'delete' ? 'Delete worktree and branch' : 'Reclaim now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** Statuses whose checkout a live or reviewable task still stands on. */
const IN_USE = new Set<WorktreeInfo['status']>(['queued', 'running', 'waiting', 'review'])

/** What retention will do with a row, in the listing's own terms (`reclaimable`, #566). */
function retentionState(worktree: WorktreeInfo): { label: string; tone: 'in-use' | 'plain' } {
  if (IN_USE.has(worktree.status)) return { label: 'in use', tone: 'in-use' }
  return worktree.reclaimable ? { label: 'reclaimable', tone: 'plain' } : { label: 'kept', tone: 'plain' }
}

function WorktreeRow({
  worktree,
  disabled,
  onOpen,
  opening,
  onDelete,
}: {
  worktree: WorktreeInfo
  disabled: boolean
  onOpen?: () => void
  opening: boolean
  onDelete: () => void
}) {
  const state = retentionState(worktree)
  const age = shortAge(worktree.finishedAt ?? undefined)
  const status = worktree.status === 'review' ? 'at review' : age ? `${worktree.status} ${age} ago` : worktree.status
  const stateLabel = (
    <span
      data-slot={worktree.reclaimable ? 'worktree-reclaimable' : 'worktree-state'}
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
      {/* Delete removes the directory AND the branch (the spec-006 route); issue 08 adds a
          directory-only Reclaim here. Until then the label says exactly what it does. */}
      <button
        type="button"
        data-action="worktree-delete"
        aria-label={`Delete worktree and branch for ${worktree.title}`}
        title="Delete worktree and branch"
        disabled={disabled}
        onClick={onDelete}
        className={iconButton}
      >
        <Trash2Icon aria-hidden="true" className="size-[13px]" />
      </button>
    </li>
  )
}
