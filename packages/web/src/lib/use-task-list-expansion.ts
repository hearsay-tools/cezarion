import { useCallback, useState } from 'react'

/** Each page owns one expansion set, independent of the rows currently mounted. */
export function useTaskListExpansion() {
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set())
  const toggleExpandedRun = useCallback((id: string) => setExpandedRuns((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }), [])
  return { expandedRuns, toggleExpandedRun }
}
