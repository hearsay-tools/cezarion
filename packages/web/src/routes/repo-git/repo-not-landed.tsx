import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleDashedIcon, GitPullRequestArrowIcon, GitPullRequestCreateIcon, InfoIcon } from 'lucide-react'
import { useId, useState } from 'react'

import { ApiError, createRunPr, deleteRepoBranches } from '@/api/client'
import { queryKeys, useRepoBranches, useRuns } from '@/api/queries'
import type { RepoBranchEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { CopyIcon, EllipsisIcon, TriangleAlertIcon } from '@/components/design-icons'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider, useReferenceStatus } from '@/components/reference-status'
import { referenceStatusPresentation } from '@/lib/reference-status'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { queryScope } from '@open-mercato/cezar-api-client'

/** The note the whole Git view shows when the forge could not answer (issue 08 §A). */
export const NO_FORGE_NOTE = 'Squash-merged branches may show as not landed without GitHub'

type Group = { key: 'no-pr' | 'pr-open' | 'deleted'; title: string; note?: string; rows: RepoBranchEntry[] }

/** Not landed's three groups, in the board's order; an empty group is not drawn. */
export function notLandedGroups(branches: readonly RepoBranchEntry[]): Group[] {
  const noPr: RepoBranchEntry[] = []
  const prOpen: RepoBranchEntry[] = []
  const deleted: RepoBranchEntry[] = []
  for (const entry of branches) {
    if (entry.class === 'orphan') deleted.push(entry)
    else if (entry.class !== 'not-landed') continue
    else if (entry.pr && (entry.pr.state === 'open' || entry.pr.state === 'draft')) prOpen.push(entry)
    else noPr.push(entry)
  }
  const groups: Group[] = [
    { key: 'no-pr', title: 'No pull request', note: 'nobody sees this work until you act', rows: noPr },
    { key: 'pr-open', title: 'Pull request open', rows: prOpen },
    { key: 'deleted', title: 'Task deleted', note: 'this branch is the only copy of the work', rows: deleted },
  ]
  return groups.filter((group) => group.rows.length > 0)
}

const STATUS_TONE: Partial<Record<NonNullable<RepoBranchEntry['runStatus']>, StatusDotTone>> = {
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

/**
 * Git → Not landed (issue 08 §C): finished tasks whose commits are not on the base, and `cez/*`
 * branches whose task was deleted. Grouped by what the user can do about them: no PR yet, a PR
 * open, or the branch is all that is left. Nothing here can be bulk-deleted. Delete branch sits in
 * each row's `…` menu and asks for the branch name typed; the server re-classifies it anyway.
 */
export function RepoNotLandedSection() {
  const branches = useRepoBranches()
  const runs = useRuns()
  const scope = queryScope()
  const [deleting, setDeleting] = useState<RepoBranchEntry | null>(null)

  if (branches.isPending) {
    return <p data-slot="not-landed-loading" role="status" className="px-[28px] py-[20px] text-[13px] text-soft-foreground">Loading branches…</p>
  }
  if (branches.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon size={16} />}
        tone="danger"
        heading="h2"
        title="Could not classify the branches"
        subtitle={branches.error.message}
      />
    )
  }
  const groups = notLandedGroups(branches.data.branches)
  const finishedAt = new Map((runs.data ?? []).map((run) => [run.id, run.finishedAt]))
  const requests = groups.flatMap((group) => group.rows).flatMap((entry) =>
    entry.pr ? [{ projectId: scope, kind: 'PR' as const, number: entry.pr.number }] : [],
  )

  return (
    <ReferenceStatusProvider projectId={scope} requests={requests}>
      <div data-slot="repo-not-landed" className="flex flex-col gap-[2px] px-[8px] pt-[12px] pb-[calc(90px+env(safe-area-inset-bottom))] md:px-[20px] md:pb-[20px]">
        {!branches.data.prStateKnown ? <ForgeNote /> : null}
        {groups.length === 0 ? (
          <CenteredState
            icon={<GitPullRequestArrowIcon size={16} />}
            tone="neutral"
            heading="h2"
            title="Everything landed"
            subtitle="Every finished task's commits are on the base branch, or it made none."
          />
        ) : (
          <>
            {groups.map((group) => (
              <section key={group.key} data-slot="not-landed-group" data-group={group.key} aria-label={group.title} className="flex flex-col">
                <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-[6px] px-[10px] pt-[14px] pb-[6px] text-[11px] text-soft-foreground">
                  <span className="font-medium">{group.title}</span>
                  <span>{group.rows.length}</span>
                  {group.note ? <span>· {group.note}</span> : null}
                </h2>
                <ul className="flex flex-col">
                  {group.rows.map((entry) => (
                    <NotLandedRow
                      key={entry.name}
                      entry={entry}
                      finishedAt={entry.runId ? finishedAt.get(entry.runId) : undefined}
                      onDelete={() => setDeleting(entry)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            <p data-slot="not-landed-note" className="flex items-start gap-[6px] px-[10px] pt-[14px] text-[11.5px] leading-[17px] text-soft-foreground">
              <InfoIcon aria-hidden="true" className="mt-[2.5px] size-[12px] shrink-0" />
              Delete branch is in each row's … menu. It confirms and names the commits it drops. Nothing on this list can be bulk-deleted.
            </p>
          </>
        )}
      </div>
      <DeleteBranchDialog entry={deleting} onClose={() => setDeleting(null)} />
    </ReferenceStatusProvider>
  )
}

/** The squash-merge caveat, shown when `prStateKnown` is false. Information, never an error. */
export function ForgeNote({ className }: { className?: string }) {
  return (
    <p data-slot="git-no-forge" className={cn('flex items-start gap-[6px] px-[10px] pt-[6px] text-[11.5px] leading-[17px] text-soft-foreground', className)}>
      <InfoIcon aria-hidden="true" className="mt-[2.5px] size-[12px] shrink-0" />
      {NO_FORGE_NOTE}.
    </p>
  )
}

function NotLandedRow({ entry, finishedAt, onDelete }: {
  entry: RepoBranchEntry
  finishedAt: string | undefined
  onDelete: () => void
}) {
  const queryClient = useQueryClient()
  const orphan = entry.class === 'orphan'
  const openPr = entry.pr && (entry.pr.state === 'open' || entry.pr.state === 'draft') ? entry.pr : null
  const canCreatePr = !orphan && entry.runId !== null && !openPr
  const title = orphan ? `No task · last commit “${entry.lastCommit.subject}”` : entry.title ?? entry.name
  // "done 3d ago" is the task's own finish when the runs list has it, else the last commit's age.
  const age = shortAge(finishedAt ?? entry.lastCommit.at)
  const when = orphan || !entry.runStatus ? (age ? `${age} ago` : '') : `${entry.runStatus}${age ? ` ${age} ago` : ''}`

  const draftPr = useMutation({
    mutationFn: () => createRunPr(entry.runId!),
    onSuccess: (result) => {
      toast(`Draft PR created — ${result.url}`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.repoBranches })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
    onError: (error: Error) =>
      toast(error instanceof ApiError && error.manual ? `${error.message} — ${error.manual}` : error.message, { tone: 'danger' }),
  })
  const copyBranch = () =>
    void navigator.clipboard.writeText(entry.name).then(
      () => toast(`Copied ${entry.name}`),
      () => toast('Could not copy the branch name', { tone: 'danger' }),
    )

  const button = 'inline-flex h-[28px] shrink-0 items-center gap-[5px] rounded-[6px] px-[10px] text-[12px] font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 [&>svg]:size-[12px]'
  return (
    <li data-slot="not-landed-row" data-branch={entry.name} data-branch-class={entry.class} className="flex min-h-[56px] items-center gap-[12px] rounded-[6px] px-[10px] py-[6px] hover:bg-sidebar-row-hover">
      <span className="flex size-[12px] shrink-0 items-center justify-center">
        {orphan ? (
          <CircleDashedIcon aria-label="Task deleted" className="size-[12px] text-soft-foreground" />
        ) : (
          <StatusDot tone={(entry.runStatus && STATUS_TONE[entry.runStatus]) || 'neutral'} aria-label={entry.runStatus ?? undefined} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        {entry.runId ? (
          <Link to={`/tasks/${entry.runId}`} data-slot="not-landed-title" className="min-w-0 truncate rounded-[2px] text-[13px] text-foreground hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">
            {title}
          </Link>
        ) : (
          <span data-slot="not-landed-title" className="min-w-0 truncate text-[13px] text-muted-foreground" title={title}>{title}</span>
        )}
        <span data-slot="not-landed-meta" className="flex min-w-0 items-center gap-[6px] text-[11px] text-soft-foreground">
          <span className="shrink-0 font-mono text-muted-foreground">{entry.name}</span>
          <span className="shrink-0">· {entry.ahead} commit{entry.ahead === 1 ? '' : 's'}</span>
          {entry.diffStat ? (
            <span className="flex shrink-0 gap-[4px] tabular-nums">
              <span className="text-success">+{entry.diffStat.additions}</span>
              <span className="text-danger">−{entry.diffStat.deletions}</span>
            </span>
          ) : null}
          {when ? <span className="truncate">· {when}</span> : null}
        </span>
      </div>
      {entry.pr ? (
        <span data-slot="not-landed-pr" className="hidden shrink-0 items-center gap-[4px] text-[11.5px] text-muted-foreground md:flex">
          <ReferenceChip
            plain
            reference={{ kind: 'PR', number: entry.pr.number, url: entry.pr.url }}
            taskTitle={entry.title ?? entry.name}
            status={entry.pr.state === 'draft' ? 'draft' : entry.pr.state === 'closed' ? 'closed' : undefined}
          />
          <PrStateWords entry={entry} />
        </span>
      ) : null}
      {entry.runId ? (
        <Link to={`/tasks/${entry.runId}`} data-action="not-landed-open" className={cn(button, 'hidden border border-border hover:bg-muted md:inline-flex')}>
          Open task
        </Link>
      ) : null}
      {canCreatePr ? (
        <button type="button" data-action="not-landed-create-pr" disabled={draftPr.isPending} onClick={() => draftPr.mutate()} className={cn(button, 'hidden bg-muted hover:brightness-110 md:inline-flex')}>
          <GitPullRequestCreateIcon aria-hidden="true" />
          {draftPr.isPending ? 'Creating…' : 'Create draft PR'}
        </button>
      ) : null}
      {orphan ? (
        <button type="button" data-action="not-landed-copy" onClick={copyBranch} className={cn(button, 'hidden border border-border hover:bg-muted md:inline-flex')}>
          <CopyIcon aria-hidden="true" />
          Copy branch
        </button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          data-action="not-landed-more"
          aria-label={`More actions for ${entry.name}`}
          className="flex size-[28px] shrink-0 items-center justify-center rounded-[6px] text-soft-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:size-11"
        >
          <EllipsisIcon aria-hidden="true" className="size-[14px]" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {/* On a phone the row's buttons do not fit; the menu carries them. */}
          {entry.runId ? (
            <DropdownMenuItem asChild className="md:hidden">
              <Link to={`/tasks/${entry.runId}`}>Open task</Link>
            </DropdownMenuItem>
          ) : null}
          {canCreatePr ? (
            <DropdownMenuItem className="md:hidden" disabled={draftPr.isPending} onSelect={() => draftPr.mutate()}>Create draft PR</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className={cn(!orphan && 'md:hidden')} onSelect={copyBranch}>Copy branch</DropdownMenuItem>
          <DropdownMenuSeparator className="md:hidden" />
          <DropdownMenuItem data-action="not-landed-delete" variant="destructive" onSelect={onDelete}>Delete branch…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** `· waiting for review` / `· draft` beside the PR glyph: the forge status when the reference
 *  cache knows it, else the branch payload's own state. */
function PrStateWords({ entry }: { entry: RepoBranchEntry }) {
  const known = referenceStatusPresentation(useReferenceStatus('PR', entry.pr?.number).status)
  const state = entry.pr?.state
  const words = state === 'draft' || state === 'closed' ? state : known ? known.label.toLowerCase() : 'open'
  return <span data-slot="not-landed-pr-state">· {words}</span>
}

/**
 * Delete a not-landed or orphan branch (issue 08 §B3): names the task and what is being dropped,
 * and asks for the branch name typed. The server re-classifies at delete time and needs the same
 * name as `confirm`, so a stale row can never delete more than the user typed.
 */
export function DeleteBranchDialog({ entry, onClose }: { entry: RepoBranchEntry | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const remove = useMutation({
    mutationFn: (name: string) => deleteRepoBranches({ names: [name], confirm: name }),
    onSuccess: (result) => {
      const dropped = result.dropped?.length ?? 0
      toast(result.deleted.length > 0
        ? `Deleted ${result.deleted[0]}${dropped ? ` and ${dropped} commit${dropped === 1 ? '' : 's'} with it` : ''}`
        : result.refused[0]?.reason ?? 'Nothing was deleted')
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      close()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const close = () => {
    setTyped('')
    onClose()
  }
  const matches = entry !== null && typed.trim() === entry.name
  const commits = entry ? `${entry.ahead} commit${entry.ahead === 1 ? '' : 's'}` : ''
  return (
    <AlertDialog open={entry !== null} onOpenChange={(open) => !open && !remove.isPending && close()}>
      <AlertDialogContent data-slot="delete-branch-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entry?.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {entry?.class === 'orphan'
                  ? 'Its task was deleted, so this branch is the only copy of the work.'
                  : <>This drops the work of <span className="font-medium text-foreground">{entry?.title ?? entry?.name}</span>. It is not on the base branch{entry?.pr ? '' : ' and no pull request carries it'}.</>}
              </p>
              <p data-slot="delete-branch-dropped">
                {commits} will be dropped{entry?.diffStat ? ` (+${entry.diffStat.additions} −${entry.diffStat.deletions})` : ''}, the latest “{entry?.lastCommit.subject}”
                {' '}(<span className="font-mono">{entry?.lastCommit.sha.slice(0, 7)}</span>).
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (matches && entry) remove.mutate(entry.name)
          }}
          className="flex flex-col gap-[6px]"
        >
          <label htmlFor={inputId} className="text-[12.5px] text-muted-foreground">
            Type <span className="font-mono text-foreground">{entry?.name}</span> to confirm
          </label>
          <Input
            id={inputId}
            data-slot="delete-branch-confirm"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="h-11 font-mono"
          />
        </form>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11" disabled={remove.isPending}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            data-action="delete-branch-confirm"
            className="h-11 bg-danger text-danger-foreground hover:brightness-[0.96]"
            disabled={!matches || remove.isPending}
            onClick={(event) => {
              event.preventDefault()
              if (matches && entry) remove.mutate(entry.name)
            }}
          >
            {remove.isPending ? 'Deleting…' : 'Delete branch'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
