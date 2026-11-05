/** Lightweight route skeleton for both activity routes; independent of the feature chunk. */
export function ActivityLoading() {
  return (
    <div data-route="activity" aria-busy="true" className="min-h-full w-full px-[18px] py-6 md:px-7">
      <h1 className="text-[18px] font-semibold">Activity</h1>
      <p data-slot="activity-loading" role="status" className="mt-4 text-xs text-muted-foreground">
        Loading activity…
      </p>
    </div>
  )
}
