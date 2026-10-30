import type { RepoBranchEntry } from '@open-mercato/cezar-api-client'

/** Why the server kept a branch that may be merged (hearsay-tools/cezarion#2268): GitHub did not
 *  return its full PR history. Nothing when the row carries no reason. */
export function BranchKeptReason({ entry }: { entry: Pick<RepoBranchEntry, 'keptReason'> }) {
  if (!entry.keptReason) return null
  return <span data-slot="branch-kept-reason" className="min-w-0 text-[11px] text-soft-foreground">{entry.keptReason}</span>
}
