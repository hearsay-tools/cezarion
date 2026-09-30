import { queryScope } from '@open-mercato/cezar-api-client'

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
    <div data-route="github" data-slot="github-filter-screen" className="flex min-h-full flex-col px-[18px] pt-[18px] pb-[calc(90px+env(safe-area-inset-bottom))]">
      <h1 className="text-2xl font-semibold tracking-tight">GitHub</h1>
      {repo ? <p className="truncate pb-4 text-[13px] text-muted-foreground" data-slot="gh-repo">{repo}</p> : <div className="pb-4" />}
      <GithubFilterList model={model} variant="screen" />
    </div>
  )
}
