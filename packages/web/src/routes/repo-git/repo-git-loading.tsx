import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

import { RepoBackLink } from './repo-back-link'

/** The repo view's loading surface — also the route's `Suspense` fallback (routes.tsx), so it
 *  lives outside the lazy chunk it stands in for, same reason as git-tab-loading.tsx. */
export function RepoGitLoading({ back = false }: { back?: boolean }) {
  return (
    <div data-route="repo-git" className="flex min-h-full flex-col">
      {back ? <RepoBackLink /> : null}
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading repository…"
        subtitle="Fetching the repo's git state."
      />
    </div>
  )
}
