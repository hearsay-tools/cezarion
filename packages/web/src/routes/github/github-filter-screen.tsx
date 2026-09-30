import { queryScope } from '@open-mercato/cezar-api-client'

import { SCREEN_LIST_BODY_CLASS, SCREEN_LIST_TITLE_CLASS } from '@/components/nav-row-styles'

import { GithubFilterList } from './github-filter-list'
import { useGithubFilterModel } from './use-github-filter-model'

/**
 * The phone's GitHub entry (#622): the filter list as its own screen. Choosing a row pushes the
 * list (`/github?filter=…`, `/github/prs?filter=…`), which carries a "Back to filters" link here.
 * Rendered by the routed view, so `queryScope()` is already the project on screen.
 */
export function GithubFilterScreen({ repo }: { repo?: string }) {
  const model = useGithubFilterModel(queryScope())
  return (
    <div data-route="github" data-slot="github-filter-screen" className={SCREEN_LIST_BODY_CLASS}>
      <h1 className={SCREEN_LIST_TITLE_CLASS}>GitHub</h1>
      {repo ? <p className="truncate px-[10px] pb-[16px] text-[13px] text-muted-foreground" data-slot="gh-repo">{repo}</p> : <div className="pb-[16px]" />}
      <GithubFilterList model={model} variant="screen" />
    </div>
  )
}
