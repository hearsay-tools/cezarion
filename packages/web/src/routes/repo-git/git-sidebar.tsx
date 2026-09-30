import type { ComponentType, SVGProps } from 'react'
import { useLocation } from 'react-router'

import { useProjectRepo } from '@/api/queries'
import { useSidebarNavigate } from '@/components/app-shell'
import { FileDiffIcon, GitBranchIcon, GitCommitHorizontalIcon } from '@/components/design-icons'
import {
  SIDEBAR_LIST_BODY_CLASS, SIDEBAR_LIST_COUNT_CLASS, SIDEBAR_LIST_HEADING_CLASS, SIDEBAR_LIST_ICON_CLASS,
  SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, SIDEBAR_LIST_UNLABELLED_GROUP_CLASS, SIDEBAR_SELECTED_CLASS,
} from '@/components/nav-row-styles'
import { Link, stripProjectPrefix } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { GitWorktreeList } from './git-worktree-list'
import type { RepoTab } from './repo-git'
import { useGitWorktreeModel } from './use-git-worktree-model'

/** The repository facet a `/git…` pathname shows, or null outside the repository view. */
export function repoTabOf(pathname: string): RepoTab | null {
  const flat = stripProjectPrefix(pathname)
  if (/^\/git\/commits(?:\/|$)/.test(flat)) return 'commits'
  if (/^\/git\/branches(?:\/|$)/.test(flat)) return 'branches'
  return /^\/git\/?$/.test(flat) ? 'changes' : null
}

const REPO_ROWS: ReadonlyArray<{ id: RepoTab; label: string; to: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { id: 'changes', label: 'Changes', to: '/git?view=repo', icon: FileDiffIcon },
  { id: 'commits', label: 'Commits', to: '/git/commits', icon: GitCommitHorizontalIcon },
  { id: 'branches', label: 'Branches', to: '/git/branches', icon: GitBranchIcon },
]

/**
 * The Git view's desktop sidebar list (#622): the repository's Changes / Commits / Branches, then
 * the task worktrees on disk. `scope` is the explicit project scope (see `useGitWorktreeModel`).
 */
export function GitSidebar({ scope }: { scope: string }) {
  const model = useGitWorktreeModel(scope)
  const repo = useProjectRepo(scope)
  const { pathname } = useLocation()
  const onNavigate = useSidebarNavigate()
  const active = repoTabOf(pathname)
  const data = repo.data?.info ? repo.data : null
  // Changes counts working-tree entries, Branches local branches; Commits is a capped log, so it
  // carries no count rather than a misleading one.
  const counts: Record<RepoTab, number | null> = {
    changes: data ? data.status.length : null,
    commits: null,
    branches: data ? data.branches.length : null,
  }
  return (
    <div data-slot="git-sidebar" className={SIDEBAR_LIST_BODY_CLASS}>
      <h2 className={SIDEBAR_LIST_HEADING_CLASS}>
        Git
        {data ? (
          <span data-slot="git-sidebar-branch" className="ml-auto truncate pl-2 text-[12px] font-normal text-muted-foreground">
            {data.info.branch}
          </span>
        ) : null}
      </h2>
      <nav aria-label="Repository" data-slot="git-repo-nav" className={SIDEBAR_LIST_UNLABELLED_GROUP_CLASS}>
        {REPO_ROWS.map(({ id, label, to, icon: Icon }) => {
          const count = counts[id]
          const current = active === id
          return (
            <Link
              key={id}
              to={to}
              data-git-facet={id}
              aria-current={current ? 'page' : undefined}
              onClick={onNavigate}
              className={cn(SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, current && SIDEBAR_SELECTED_CLASS)}
            >
              <Icon aria-hidden="true" className={SIDEBAR_LIST_ICON_CLASS} />
              <span className="truncate">{label}</span>
              {count ? (
                <span data-slot="git-facet-count" className={SIDEBAR_LIST_COUNT_CLASS}>{count}</span>
              ) : null}
            </Link>
          )
        })}
      </nav>
      <GitWorktreeList model={model} variant="sidebar" onNavigate={onNavigate} />
    </div>
  )
}
