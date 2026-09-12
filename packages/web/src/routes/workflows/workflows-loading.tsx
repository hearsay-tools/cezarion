/** Lightweight route skeleton; deliberately independent of the feature chunk. */
export function WorkflowsLoading() {
  return (
    <div
      data-route="workflows"
      aria-busy="true"
      className="mx-auto min-h-full w-full px-[18px] py-6 md:p-9"
    >
      <h1 className="text-[30px] font-semibold tracking-tight">Workflows</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Portable skill chains. Steps run from top to bottom.
      </p>
      <p data-slot="workflows-loading" role="status" className="mt-6 text-xs text-muted-foreground">
        Loading workflows…
      </p>
      <div aria-hidden="true" className="mt-4 flex flex-col gap-[22px] motion-safe:animate-pulse">
        <div className="h-11 rounded-lg border border-border bg-card" />
        <div className="h-80 rounded-xl border border-border bg-card" />
      </div>
    </div>
  )
}
