import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { queryScope } from '@open-mercato/cezar-api-client'

import { queryKeys, useRepo } from '@/api/queries'
import { RefreshCwIcon } from '@/components/design-icons'
import { SCREEN_LIST_BODY_CLASS, SCREEN_LIST_TITLE_CLASS } from '@/components/nav-row-styles'
import { cn } from '@/lib/utils'

import { GitCheckoutBlock } from './git-checkout-block'
import { GitSectionList } from './git-section-list'
import { useGitSectionCounts } from './use-git-section-counts'

/**
 * The phone's Git entry (issue 06 §3, #622): the checkout block and the sections as their own
 * screen, 48px rows with chevrons — the GitHub filter screen's pattern. A section pushes its
 * screen (`/git?view=repo`, `/git/cleanup`, `/git/branches`), each with a "Back to Git" link here.
 * Rendered by the routed view, so `queryScope()` is already the project on screen.
 */
export function GitScreen() {
  const scope = queryScope()
  const repo = useRepo()
  const queryClient = useQueryClient()
  const refreshing = useIsFetching({ queryKey: queryKeys.repo }) > 0
  const data = repo.data?.info ? repo.data : null
  const counts = useGitSectionCounts(scope, data, 'screen')
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
  }
  return (
    <div data-route="repo-git" data-slot="git-screen" className={SCREEN_LIST_BODY_CLASS}>
      <div className="mb-[16px] flex items-center gap-[8px]">
        <h1 className={cn(SCREEN_LIST_TITLE_CLASS, 'min-w-0 flex-1')}>Git</h1>
        <button
          type="button"
          data-slot="git-screen-refresh"
          aria-label="Refresh the repository"
          title="Refresh the repository"
          disabled={refreshing}
          onClick={refresh}
          className="-my-2 -mr-[10px] flex size-11 shrink-0 items-center justify-center rounded-md text-soft-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
        >
          <RefreshCwIcon size={17} aria-hidden="true" className={cn('size-[17px]', refreshing && 'motion-safe:animate-spin')} />
        </button>
      </div>
      {data?.info ? (
        <div className="mb-[16px]">
          <GitCheckoutBlock scope={scope} repo={data} info={data.info} variant="screen" />
        </div>
      ) : repo.isPending ? (
        <p data-slot="git-screen-loading" role="status" className="mb-[16px] px-[10px] text-[13px] text-soft-foreground">Loading the checkout…</p>
      ) : repo.isError ? (
        <p data-slot="git-screen-error" role="alert" className="mb-[16px] px-[10px] text-[13px] text-danger">Could not load the repository: {repo.error.message}</p>
      ) : (
        <p data-slot="git-screen-not-git" className="mb-[16px] px-[10px] text-[13px] text-soft-foreground">Not a git repository.</p>
      )}
      <GitSectionList branch={data?.info?.branch ?? null} counts={counts} variant="screen" />
    </div>
  )
}
