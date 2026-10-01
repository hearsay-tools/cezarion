import { useLocation } from 'react-router'

import { useProjectRepo } from '@/api/queries'
import { useSidebarNavigate } from '@/components/app-shell'
import { SIDEBAR_LIST_BODY_CLASS } from '@/components/nav-row-styles'

import { GitCheckoutBlock } from './git-checkout-block'
import { GitSectionList } from './git-section-list'
import { gitSectionOf } from './git-sections'
import { useGitSectionCounts } from './use-git-section-counts'

/**
 * The Git view's desktop sidebar body (issue 06 §3, #622): the checkout block, then the sections
 * — Recently on main, Cleanup, All branches — with the open one lit. Task worktrees are not
 * listed: each is one task's checkout, and the Tasks list already shows those.
 *
 * `scope` is the explicit project scope, because the sidebar renders above the
 * `ProjectScopeProvider`. Outside a git repository the sections still render, so the sidebar is
 * never empty; the checkout block needs the repository. Until `/repo` first answers, a
 * placeholder holds the block's place and the sections wait: the block mounts ABOVE them, so
 * drawing them early would slide every section row down under a pointer already on its way
 * (PR #716: an All branches click landed on the uncommitted line). The block is keyed by scope
 * so a Pull confirmation never survives into another project.
 */
export function GitSidebar({ scope }: { scope: string }) {
  const repo = useProjectRepo(scope)
  const { pathname } = useLocation()
  const onNavigate = useSidebarNavigate()
  const data = repo.data?.info ? repo.data : null
  const counts = useGitSectionCounts(scope, data, 'sidebar')
  return (
    <div data-slot="git-sidebar" role="region" aria-label="Git" className={SIDEBAR_LIST_BODY_CLASS}>
      {data?.info ? (
        <GitCheckoutBlock key={scope} scope={scope} repo={data} info={data.info} variant="sidebar" onNavigate={onNavigate} />
      ) : repo.isPending ? (
        <div data-slot="git-checkout-placeholder" aria-hidden="true" className="h-[94px] rounded-[8px] border border-border" />
      ) : null}
      {repo.isPending ? null : (
        <GitSectionList
          branch={data?.info?.branch ?? null}
          counts={counts}
          variant="sidebar"
          active={gitSectionOf(pathname)}
          onNavigate={onNavigate}
        />
      )}
    </div>
  )
}
