import { useLocation, useSearchParams } from 'react-router'

import { useSidebarNavigate } from '@/components/app-shell'
import { SIDEBAR_LIST_BODY_CLASS } from '@/components/nav-row-styles'
import { stripProjectPrefix } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { GithubFilterList } from './github-filter-list'
import { parseGithubFilter, rowIdOf, type GithubListView } from './github-sidebar-model'
import { useGithubFilterModel } from './use-github-filter-model'

/** The view a `/github…` pathname shows: `/github/prs…` is pull requests, everything else issues. */
export function githubViewOf(pathname: string): GithubListView {
  return /^\/github\/prs(?:\/|$)/.test(stripProjectPrefix(pathname)) ? 'prs' : 'issues'
}

/**
 * The GitHub view's desktop sidebar list (#622): saved-style filters with counts. Selecting one
 * only sets the main list's `?filter=` — the list, detail pane and Hand to agent stay in the main
 * area. `scope` is the explicit project scope (see `useGithubFilterModel`).
 */
export function GithubSidebar({ scope }: { scope: string }) {
  const model = useGithubFilterModel(scope)
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const onNavigate = useSidebarNavigate()
  const view = githubViewOf(pathname)
  const active = rowIdOf(view, parseGithubFilter(view, params.get('filter')))
  return (
    <div data-slot="github-sidebar" role="region" aria-label="GitHub" // The board's body is 12px all round (the shared class says 8px horizontally).
    className={cn(SIDEBAR_LIST_BODY_CLASS, 'px-3')}>
      <GithubFilterList model={model} variant="sidebar" activeId={active} onNavigate={onNavigate} />
    </div>
  )
}
