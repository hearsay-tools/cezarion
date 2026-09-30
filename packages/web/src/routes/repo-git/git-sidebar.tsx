import type { ComponentType, SVGProps } from 'react'
import { useLocation } from 'react-router'

import { useProjectRepo } from '@/api/queries'
import { useSidebarNavigate } from '@/components/app-shell'
import { FileDiffIcon, GitBranchIcon, GitCommitHorizontalIcon } from '@/components/design-icons'
import {
  SIDEBAR_LIST_BODY_CLASS, SIDEBAR_LIST_COUNT_CLASS, SIDEBAR_LIST_GROUP_CLASS, SIDEBAR_LIST_GROUP_LABEL_CLASS,
  SIDEBAR_LIST_ICON_CLASS, SIDEBAR_LIST_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, SIDEBAR_LIST_UNLABELLED_GROUP_CLASS,
  SIDEBAR_SELECTED_CLASS,
} from '@/components/nav-row-styles'
import { Link, stripProjectPrefix } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { GIT_TWO_LINE_ROW_CLASS, GitWorktreeList } from './git-worktree-list'
import { shortGitAge } from './git-worktree-model'
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

/** The board keeps every list short: the newest few commits, the rest is the Commits tab. */
const RECENT_COMMITS = 3

/**
 * The Git view's desktop sidebar body (#622): no heading; the repository's Changes / Commits / Branches rows
 * (kept at the owner's request, the board has none), the task worktrees on disk and the recent commits.
 * `scope` is the explicit project scope (see `useGitWorktreeModel`).
 */
export function GitSidebar({ scope }: { scope: string }) {
  const model = useGitWorktreeModel(scope)
  const repo = useProjectRepo(scope)
  const { pathname } = useLocation()
  const onNavigate = useSidebarNavigate()
  const openSha = /^\/git\/commits\/([^/]+)/.exec(stripProjectPrefix(pathname))?.[1]
  const active = repoTabOf(pathname)
  const data = repo.data?.info ? repo.data : null
  // Changes counts working-tree entries, Branches local branches; Commits is a capped log, so it
  // carries no count rather than a misleading one.
  const counts: Record<RepoTab, number | null> = {
    changes: data ? data.status.length : null,
    commits: null,
    branches: data ? data.branches.length : null,
  }
  const commits = repo.data?.info ? repo.data.log.slice(0, RECENT_COMMITS) : []
  return (
    <div data-slot="git-sidebar" role="region" aria-label="Git" className={SIDEBAR_LIST_BODY_CLASS}>
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
      {commits.length > 0 ? (
        <nav aria-label="Recent commits" data-slot="git-commit-list" className={SIDEBAR_LIST_GROUP_CLASS}>
          <h3 className={SIDEBAR_LIST_GROUP_LABEL_CLASS}>Recent commits</h3>
          {commits.map((commit) => (
            <Link
              key={commit.hash}
              to={`/git/commits/${commit.hash}`}
              data-slot="git-commit-row"
              data-sha={commit.hash}
              title={commit.subject}
              aria-current={openSha === commit.hash ? 'page' : undefined}
              onClick={onNavigate}
              className={cn(
                GIT_TWO_LINE_ROW_CLASS, SIDEBAR_LIST_ROW_HOVER_CLASS, 'h-[49px]',
                openSha === commit.hash && SIDEBAR_SELECTED_CLASS,
              )}
            >
              <span className="flex min-w-0 flex-1 items-start gap-[10px]">
                <span className="flex h-[19px] w-[12px] shrink-0 items-center justify-center">
                  <GitCommitHorizontalIcon aria-hidden="true" className="size-[12px] text-soft-foreground" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span data-slot="git-commit-subject" className="truncate text-[13px] font-medium leading-[19px]">{commit.subject}</span>
                  <span data-slot="git-commit-meta" className="truncate text-[11.5px] leading-[17px] text-soft-foreground">
                    {commit.hash} · {shortGitAge(commit.when)}
                  </span>
                </span>
              </span>
              <span aria-hidden="true" className="w-[16px] shrink-0" />
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  )
}
