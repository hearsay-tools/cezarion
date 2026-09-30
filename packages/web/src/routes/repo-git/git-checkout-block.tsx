import { LoaderCircleIcon } from 'lucide-react'
import { useRef, type RefObject } from 'react'

import type { RepoInfo, RepoResponse, RepoTracking } from '@open-mercato/cezar-api-client'
import {
  ArrowDownIcon, ChevronDownIcon, ChevronRightIcon, GitBranchIcon, TriangleAlertIcon,
} from '@/components/design-icons'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { fetchedAgo, GIT_SECTION_PATH } from './git-sections'
import { useGitCheckout } from './use-git-checkout'

/** The board's two sizes of one card: the desktop sidebar's and the phone Git screen's. */
const SIZES = {
  sidebar: {
    card: 'gap-[8px] rounded-[8px] p-[10px]',
    branchRow: 'gap-[6px]',
    branchIcon: 'size-[14px]',
    branch: 'text-[12.5px]',
    chevron: 'size-[12px]',
    pull: 'h-[24px] gap-[4px] rounded-[6px] px-[8px] text-[11.5px] [&>svg]:size-[12px]',
    line: 'text-[11px]',
    lineChevron: 'size-[11px]',
    dirty: 'gap-[6px] pt-[6px] text-[11px] [&>svg]:size-[12px]',
  },
  screen: {
    card: 'gap-[10px] rounded-[10px] p-[12px]',
    branchRow: 'gap-[8px]',
    branchIcon: 'size-[16px]',
    branch: 'text-[14px]',
    chevron: 'size-[14px]',
    pull: 'h-[36px] gap-[6px] rounded-[8px] px-[14px] text-[13px] [&>svg]:size-[14px]',
    line: 'text-[12px]',
    lineChevron: 'size-[12px]',
    dirty: 'h-[40px] gap-[8px] pt-[4px] text-[13px] [&>svg:first-child]:size-[14px] [&>svg:last-child]:size-[15px]',
  },
} as const

/**
 * The Git view's checkout block (issue 06 §3): which branch the main checkout is on, with the
 * branch menu (switch, via `POST /repo/branch`) and Pull; which branch new tasks start from (the
 * base-branch picker); the freshness line (issue 08: `2 behind origin · fetched 6m ago`, as of
 * the last fetch, hidden when the base has no upstream); and, when the checkout is dirty, a link
 * to its uncommitted files.
 *
 * `scope` is explicit: the desktop sidebar renders above the `ProjectScopeProvider`.
 */
export function GitCheckoutBlock({ scope, repo, info, variant, onNavigate }: {
  scope: string
  repo: RepoResponse
  info: RepoInfo
  variant: 'sidebar' | 'screen'
  onNavigate?: () => void
}) {
  const size = SIZES[variant]
  const checkout = useGitCheckout(scope, info)
  const base = repo.baseBranch ?? info.branch
  const dirty = repo.status.length
  const noRemote = 'No remote configured. Add a Git remote before pulling.'
  const busy = checkout.switchBranch.isPending
  const pullRef = useRef<HTMLButtonElement>(null)

  return (
    <section
      aria-label="Checkout"
      data-slot="git-checkout"
      data-variant={variant}
      className={cn('flex flex-col border border-border', size.card)}
    >
      <div className={cn('flex min-w-0 items-center', size.branchRow)}>
        <DropdownMenu>
          <DropdownMenuTrigger
            data-slot="git-branch-menu"
            aria-label={`Branch ${info.branch}. Switch branch`}
            disabled={busy}
            className={cn(
              'group flex min-w-0 flex-1 items-center rounded-[4px] text-left outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60',
              size.branchRow,
              variant === 'screen' && 'min-h-11',
            )}
          >
            <GitBranchIcon aria-hidden="true" className={cn('shrink-0 text-muted-foreground', size.branchIcon)} />
            <span data-slot="git-checkout-branch" className={cn('min-w-0 flex-1 truncate font-mono font-semibold text-foreground', size.branch)}>
              {info.branch}
            </span>
            <ChevronDownIcon aria-hidden="true" className={cn('shrink-0 text-soft-foreground group-hover:text-foreground', size.chevron)} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-xs text-soft-foreground">Switch branch</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={info.branch}
              onValueChange={(name) => {
                if (name !== info.branch) checkout.switchBranch.mutate(name)
              }}
            >
              {repo.branches.map((name) => (
                <DropdownMenuRadioItem key={name} value={name} data-branch={name} className="font-mono text-[12.5px]">
                  <span className="truncate">{name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to={GIT_SECTION_PATH.branches} data-slot="git-branch-menu-all" onClick={onNavigate}>
                Create or find a branch…
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          ref={pullRef}
          type="button"
          data-action="repo-pull"
          disabled={!checkout.hasRemote || checkout.pulling}
          title={checkout.hasRemote ? `Pull ${info.branch}` : noRemote}
          onClick={() => void checkout.pull()}
          className={cn(
            'inline-flex shrink-0 items-center bg-muted font-medium text-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 disabled:hover:brightness-100',
            size.pull,
          )}
        >
          {checkout.pulling ? (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <ArrowDownIcon aria-hidden="true" />
          )}
          Pull
        </button>
      </div>

      {repo.tracking ? <FreshnessLine tracking={repo.tracking} className={size.line} /> : null}

      <DropdownMenu>
        <DropdownMenuTrigger
          data-slot="base-branch-picker"
          aria-label={`New tasks start from ${base}. Change the base branch`}
          disabled={checkout.setBase.isPending}
          className={cn(
            'group flex min-w-0 items-center gap-[4px] self-start rounded-[4px] text-soft-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60',
            size.line,
            variant === 'screen' && 'min-h-[32px]',
          )}
        >
          <span className="shrink-0">New tasks start from</span>
          <span data-slot="base-branch" className="min-w-0 truncate font-mono text-muted-foreground group-hover:text-foreground">{base}</span>
          <ChevronDownIcon aria-hidden="true" className={cn('shrink-0', size.lineChevron)} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-soft-foreground">New tasks start from</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={repo.baseBranch ?? ''}
            onValueChange={(value) => checkout.setBase.mutate(value === '' ? null : value)}
          >
            <DropdownMenuRadioItem value="" data-branch="" className="text-[12.5px]">
              The checked-out branch (default)
            </DropdownMenuRadioItem>
            {repo.branches.map((name) => (
              <DropdownMenuRadioItem key={name} value={name} data-branch={name} className="font-mono text-[12.5px]">
                <span className="truncate">{name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {dirty > 0 ? (
        <Link
          to={GIT_SECTION_PATH.changes}
          data-slot="git-uncommitted"
          onClick={onNavigate}
          className={cn(
            'flex min-w-0 items-center border-t border-border text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
            size.dirty,
          )}
        >
          <TriangleAlertIcon aria-hidden="true" className="shrink-0 text-inbox-count-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {dirty} uncommitted file{dirty === 1 ? '' : 's'}
          </span>
          <ChevronRightIcon aria-hidden="true" className="shrink-0 text-soft-foreground" />
        </Link>
      ) : null}

      <PullConfirmDialog checkout={checkout} returnFocus={pullRef} />
    </section>
  )
}

/** `2 behind origin · fetched 6m ago` in the needs-you ink when the base is behind its upstream,
 *  `up to date · fetched 6m ago` all soft otherwise. "origin" is the upstream's remote name. */
function FreshnessLine({ tracking, className }: { tracking: RepoTracking; className: string }) {
  const remote = tracking.ref.split('/')[0] || tracking.ref
  const fetched = fetchedAgo(tracking)
  return (
    <p data-slot="git-freshness" className={cn('flex min-w-0 items-center gap-[4px] text-soft-foreground', className)}>
      {tracking.behind > 0 ? (
        <>
          <span data-slot="git-behind" className="shrink-0 font-medium text-inbox-count-foreground">
            {tracking.behind} behind {remote}
          </span>
          <span className="min-w-0 truncate">· {fetched}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">up to date · {fetched}</span>
      )}
    </p>
  )
}

/**
 * The pull's risk confirmation (`POST /repo/pull` answered 409 with `risks`). Shared by the
 * checkout block and Recently on main's Incoming bar, each with its own `useGitCheckout`.
 * `returnFocus` is the Pull button: it was disabled while the first attempt ran, so Radix has
 * nothing to return focus to on its own.
 */
export function PullConfirmDialog({ checkout, returnFocus }: {
  checkout: ReturnType<typeof useGitCheckout>
  returnFocus: RefObject<HTMLButtonElement | null>
}) {
  return (
    <AlertDialog open={checkout.confirmation !== null} onOpenChange={(open) => !open && checkout.dismissConfirmation()}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          // Pull was disabled while the first attempt ran, so Radix has nothing to return to.
          event.preventDefault()
          returnFocus.current?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Pull {checkout.confirmation?.branch} anyway?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {checkout.confirmation?.risks.includes('active_runs') ? (
                <p>An active session is using this repository. Pulling can change files while it works.</p>
              ) : null}
              {checkout.confirmation?.risks.includes('dirty_tree') ? (
                <p>The checkout has dirty files. Git may refuse the pull to protect them.</p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11" disabled={checkout.pulling}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="h-11"
            disabled={checkout.pulling || checkout.confirmation === null}
            onClick={(event) => {
              event.preventDefault()
              void checkout.pull(true)
            }}
          >
            {checkout.pulling ? 'Pulling…' : 'Pull anyway'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
