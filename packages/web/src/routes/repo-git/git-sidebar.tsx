import { useSidebarNavigate } from '@/components/app-shell'

import { GitWorktreeList } from './git-worktree-list'
import { useGitWorktreeModel } from './use-git-worktree-model'

/**
 * The Git view's desktop sidebar list (#622): the task worktrees on disk. The repository's own
 * Changes / Commits / Branches facets stay in the main header. `scope` is the explicit project
 * scope (see `useGitWorktreeModel`).
 */
export function GitSidebar({ scope }: { scope: string }) {
  const model = useGitWorktreeModel(scope)
  const onNavigate = useSidebarNavigate()
  return (
    <div data-slot="git-sidebar" className="px-2 pt-4">
      <h2 className="px-2.5 pb-4 text-[13px] font-semibold">Git</h2>
      <GitWorktreeList model={model} variant="sidebar" onNavigate={onNavigate} />
    </div>
  )
}
