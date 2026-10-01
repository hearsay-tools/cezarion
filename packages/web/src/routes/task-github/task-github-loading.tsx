import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

const KIND_WORD = { issue: 'issue', pr: 'pull request' } as const

/**
 * The item tab's loading state, in its own module for the reason git-tab-loading.tsx gives: it is
 * also the route's `Suspense` fallback (routes.tsx), and a fallback must not import the chunk it
 * stands in for. The same `CenteredState` layout as `GitTabLoading`.
 *
 * As the page (`heading="h1"`, no number) while the run record loads; under the run header
 * (`heading="h2"`, with the number) while the item itself loads.
 */
export function TaskGithubItemLoading({
  kind,
  number,
  heading = 'h1',
}: {
  kind: 'issue' | 'pr'
  number?: number
  heading?: 'h1' | 'h2'
}) {
  const state = (
    <div data-slot="task-github-loading" className="flex min-h-full flex-1 flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        heading={heading}
        title={`Loading ${KIND_WORD[kind]}${number === undefined ? '' : ` #${number}`}…`}
        subtitle={number === undefined ? 'Fetching the run record.' : 'Asking GitHub.'}
      />
    </div>
  )
  if (heading === 'h2') return state
  return (
    <div data-route="task-github-item" className="flex min-h-full flex-col">
      {state}
    </div>
  )
}
