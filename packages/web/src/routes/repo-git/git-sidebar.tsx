import type { ComponentType, SVGProps } from 'react'
import { useLocation } from 'react-router'

import { useProjectRepo } from '@/api/queries'
import { useSidebarNavigate } from '@/components/app-shell'
import { FileDiffIcon, GitBranchIcon, GitCommitHorizontalIcon } from '@/components/design-icons'
import { SIDEBAR_SELECTED_CLASS } from '@/components/nav-row-styles'
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
    <div data-slot="git-sidebar" className="px-2 pt-4">
      <h2 className="flex items-baseline px-2.5 pb-4 text-[13px] font-semibold">
        Git
        {data ? (
          <span data-slot="git-sidebar-branch" className="ml-auto truncate pl-2 text-[12px] font-normal text-muted-foreground">
            {data.info.branch}
          </span>
        ) : null}
      </h2>
      <nav aria-label="Repository" data-slot="git-repo-nav" className="mb-5">
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
              className={cn(
                'group flex h-[32px] items-center gap-[10px] rounded-[6px] px-[10px] text-[13px] text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
                current && SIDEBAR_SELECTED_CLASS,
              )}
            >
              <Icon aria-hidden="true" className="size-[15px] shrink-0 text-soft-foreground group-aria-[current=page]:text-foreground" />
              <span className="truncate">{label}</span>
              {count ? (
                <span data-slot="git-facet-count" className="ml-auto text-[11.5px] tabular-nums text-soft-foreground">{count}</span>
              ) : null}
            </Link>
          )
        })}
      </nav>
      <GitWorktreeList model={model} variant="sidebar" onNavigate={onNavigate} />
    </div>
  )
}
