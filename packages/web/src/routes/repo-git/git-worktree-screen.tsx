import { queryScope } from '@open-mercato/cezar-api-client'

import { ChevronRightIcon, GitBranchIcon } from '@/components/design-icons'
import {
  SCREEN_LIST_BODY_CLASS, SCREEN_LIST_CHEVRON_CLASS, SCREEN_LIST_ICON_CLASS, SCREEN_LIST_ROW_CLASS, SCREEN_LIST_TITLE_CLASS,
  SIDEBAR_LIST_ROW_HOVER_CLASS,
} from '@/components/nav-row-styles'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

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
    <div data-route="repo-git" data-slot="git-worktree-screen" className={SCREEN_LIST_BODY_CLASS}>
      <h1 className={cn(SCREEN_LIST_TITLE_CLASS, 'pb-[16px]')}>Git</h1>
      <Link
        to="/git?view=repo"
        data-slot="git-open-repository"
        className={cn(SCREEN_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, 'mb-[16px] text-muted-foreground')}
      >
        <GitBranchIcon aria-hidden="true" className={SCREEN_LIST_ICON_CLASS} />
        <span className="truncate">Open repository</span>
        <ChevronRightIcon aria-hidden="true" className={cn(SCREEN_LIST_CHEVRON_CLASS, 'ml-auto')} />
      </Link>
      <GitWorktreeList model={model} variant="screen" />
    </div>
  )
}
