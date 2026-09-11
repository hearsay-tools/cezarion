import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitPullRequestArrowIcon, LoaderCircleIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { getRepoPullBranches, pullRepo } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { RepoInfo, RepoPullConfirmation, RepoResponse } from '@open-mercato/cezar-api-client'
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
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

/** Branch picker and pull action shared by every segment of the repository view. */
export function RepoPull({ repo, info }: { repo: RepoResponse; info: RepoInfo }) {
  const queryClient = useQueryClient()
  const initialBranch = repo.baseBranch ?? info.branch
  const [selectedBranch, setSelectedBranch] = useState(initialBranch)
  const [confirmation, setConfirmation] = useState<RepoPullConfirmation | null>(null)
  const pullButtonRef = useRef<HTMLButtonElement>(null)

  // Capture the scope at render time. A pull can outlive navigation to another project, and its
  // completion must refresh the project it changed rather than whichever one is active later.
  const repoKey = queryKeys.repo
  const healthKey = queryKeys.health
  const branchesKey = [...repoKey, 'pull'] as const
  const hasRemote = Boolean(info.remote)
  const branches = useQuery({
    queryKey: branchesKey,
    queryFn: ({ signal }) => getRepoPullBranches({ signal }),
    enabled: hasRemote,
  })

  const pull = useMutation({ mutationFn: pullRepo })
  const refreshChangedProject = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: repoKey }),
      queryClient.invalidateQueries({ queryKey: healthKey }),
    ])

  const attempt = async (branch: string, confirm = false) => {
    try {
      const result = await pull.mutateAsync(confirm ? { branch, confirm: true } : { branch })
      if ('risks' in result) {
        setConfirmation(result)
        return
      }
      setConfirmation(null)
      toast(result.summary)
      await refreshChangedProject()
    } catch (error) {
      setConfirmation(null)
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      // Switching happens before `git pull`; a pull refusal can therefore still change HEAD.
      await refreshChangedProject()
    }
  }

  const discoveredBranches = branches.data?.branches ?? repo.branches
  const selectedIsLocal = branches.data === undefined || discoveredBranches.includes(selectedBranch)
  const options = selectedIsLocal ? discoveredBranches : [selectedBranch, ...discoveredBranches]
  const loadingBranches = hasRemote && branches.isPending
  const unavailableReason = !hasRemote
    ? 'No remote configured. Add a Git remote before pulling.'
    : branches.isError
      ? `Could not load local branches: ${branches.error.message}`
      : !selectedIsLocal
        ? `${selectedBranch} is not a local branch. Choose a local branch to pull.`
        : null
  const selectDisabled = pull.isPending || loadingBranches || !hasRemote || branches.isError
  const pullDisabled = selectDisabled || !selectedIsLocal
  const switchesBranch = selectedBranch !== info.branch

  return (
    <>
      <div data-slot="repo-pull" className="max-w-full md:w-auto">
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor="repo-pull-branch" className="sr-only">
            Branch to pull
          </label>
          <select
            id="repo-pull-branch"
            value={selectedBranch}
            disabled={selectDisabled}
            onChange={(event) => setSelectedBranch(event.target.value)}
            className="h-11 min-w-0 flex-1 rounded-md border border-input bg-card px-3 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 md:w-48"
          >
            {options.map((branch) => (
              <option key={branch} value={branch} disabled={!selectedIsLocal && branch === selectedBranch}>
                {branch}
              </option>
            ))}
          </select>
          <Button
            ref={pullButtonRef}
            type="button"
            data-action="repo-pull"
            className="h-11 px-4"
            disabled={pullDisabled}
            title={unavailableReason ?? undefined}
            onClick={() => void attempt(selectedBranch)}
          >
            {pull.isPending ? (
              <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <GitPullRequestArrowIcon aria-hidden="true" />
            )}
            {switchesBranch ? 'Switch & pull' : 'Pull'}
          </Button>
        </div>
        <p data-slot="repo-pull-note" className="mt-1 break-all text-[11px] text-soft-foreground md:text-left">
          {unavailableReason ?? `${selectedBranch} stays checked out after the pull.`}
        </p>
      </div>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pull.isPending) setConfirmation(null)
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            pullButtonRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Pull {confirmation?.branch} anyway?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {confirmation?.risks.includes('active_runs') ? (
                  <p>An active session is using this repository. Pulling can change files while it works.</p>
                ) : null}
                {confirmation?.risks.includes('dirty_tree') ? (
                  <p>The checkout has dirty files. Git may refuse the switch or pull to protect them.</p>
                ) : null}
                <p>{confirmation?.branch} will stay checked out after this attempt.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={pull.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              disabled={pull.isPending || confirmation === null}
              onClick={(event) => {
                event.preventDefault()
                if (confirmation) void attempt(confirmation.branch, true)
              }}
            >
              {pull.isPending ? 'Pulling…' : 'Pull anyway'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
