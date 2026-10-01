import { queryScope } from '@open-mercato/cezar-api-client'

import { RefreshCwIcon } from '@/components/design-icons'
import { SCREEN_LIST_BODY_CLASS, SCREEN_LIST_TITLE_CLASS } from '@/components/nav-row-styles'
import { cn } from '@/lib/utils'

import { GithubFilterList } from './github-filter-list'
import { useGithubFilterModel } from './use-github-filter-model'

/**
 * The phone's GitHub entry (#622): the filter list as its own screen. Choosing a row pushes the
 * list (`/github?filter=…`, `/github/prs?filter=…`), which carries a "Back to filters" link here.
 * Rendered by the routed view, so `queryScope()` is already the project on screen.
 *
 * The board's title row is the 22px title plus a 17px refresh icon; the repository name is not
 * on this screen (the top bar already names the project).
 */
export function GithubFilterScreen({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  const model = useGithubFilterModel(queryScope())
  return (
    <div data-route="github" data-slot="github-filter-screen" className={SCREEN_LIST_BODY_CLASS}>
      <div className="mb-[16px] flex items-center gap-[8px]">
        <h1 className={cn(SCREEN_LIST_TITLE_CLASS, 'min-w-0 flex-1')}>GitHub</h1>
        <button
          type="button"
          data-slot="gh-screen-refresh"
          aria-label="Refresh from GitHub"
          title="Refresh from GitHub"
          disabled={refreshing}
          onClick={onRefresh}
          className="-my-2 -mr-[10px] flex size-11 shrink-0 items-center justify-center rounded-md text-soft-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
        >
          <RefreshCwIcon size={17} aria-hidden="true" className={cn('size-[17px]', refreshing && 'motion-safe:animate-spin')} />
        </button>
      </div>
      <GithubFilterList model={model} variant="screen" />
    </div>
  )
}
