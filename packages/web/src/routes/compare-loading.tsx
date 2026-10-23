import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/** Shared by the historical group's fetch state and its lazy route fallback. */
export function CompareLoading() {
  return (
    <div data-route="compare" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading retained results…"
        subtitle="Reading the historical task group."
      />
    </div>
  )
}
