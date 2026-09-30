import { queryScope } from '@open-mercato/cezar-api-client'

import { ChevronRightIcon, GitBranchIcon } from '@/components/design-icons'
import { Link } from '@/lib/project-router'

import { GitWorktreeList } from './git-worktree-list'
import { useGitWorktreeModel } from './use-git-worktree-model'

/**
 * The phone's Git entry (#622): the task worktrees as their own screen, with a link into the main
 * repository (`/git?view=repo`, whose header carries "Back to worktrees"). Rendered by the routed
 * view, so `queryScope()` is already the project on screen.
 */
export function GitWorktreeScreen() {
  const model = useGitWorktreeModel(queryScope())
  return (
    <div data-route="repo-git" data-slot="git-worktree-screen" className="flex min-h-full flex-col px-[18px] pt-[18px] pb-[calc(90px+env(safe-area-inset-bottom))]">
      <h1 className="pb-4 text-2xl font-semibold tracking-tight">Git</h1>
      <Link
        to="/git?view=repo"
        data-slot="git-open-repository"
        className="mb-6 flex h-12 items-center gap-[10px] rounded-[6px] px-[10px] text-[15px] text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <GitBranchIcon aria-hidden="true" className="size-[18px] shrink-0 text-soft-foreground" />
        <span className="truncate">Open repository</span>
        <ChevronRightIcon aria-hidden="true" className="ml-auto size-[18px] shrink-0 text-soft-foreground" />
      </Link>
      <GitWorktreeList model={model} variant="screen" />
    </div>
  )
}
