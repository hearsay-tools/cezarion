import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { getGithubItem } from '@/api/client'
import { queryKeys, useGithubItem, type useGithubSearch } from '@/api/queries'
import type { GithubData, GithubItem } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

import type { GithubView } from './github'
import type { GithubSidebarFilter } from './use-github-filters'

/** The deep-linked item the open list does not hold (#692), with the key its query lives under —
 *  read when Refresh is PRESSED, so a refresh that lands after the reader moved on still writes
 *  to the project it was pressed in. */
export type ExactTarget = { kind: 'issue' | 'pr'; number: number; key: ReturnType<typeof queryKeys.githubItem> }

export type ExactGithubItem = ReturnType<typeof useExactGithubItem>

/** Ask gh for the exact item again, past the server's item cache, and file the answer under the
 *  key captured with it. Resolves `false` when the request did not land. */
export function refetchExactItem(queryClient: QueryClient, target: ExactTarget | null): Promise<boolean> {
  return target
    ? getGithubItem(target.kind, target.number, { refresh: true })
        .then((data) => {
          queryClient.setQueryData(target.key, data)
          return true
        })
        .catch(() => false)
    : Promise.resolve(true)
}

/**
 * The URL's `:n`, and the item the detail pane keeps for it when the open list does not hold it.
 *
 * Retain one explicitly selected search result independently of visible search rows. Query
 * edits and filters can hide those rows; the URL still identifies the detail being read.
 * Scope/kind/number checks prevent a retained item leaking across projects or tabs.
 */
export function useGithubSelection(
  view: GithubView,
  n: string | undefined,
  forgeSearch: ReturnType<typeof useGithubSearch>,
  { filterGate, filterRows, fullList }: GithubSidebarFilter,
) {
  const scope = queryKeys.github()[0]
  const selectedNumber = n === undefined ? null : Number.parseInt(n, 10)
  const selectedSearchItem = !filterGate && forgeSearch.data?.available
    ? forgeSearch.data.items.find(item => item.number === selectedNumber)
    : undefined
  // A qualifier-selected PR (Review requested / Checks failing) that the open list does not hold is
  // retained exactly like a text-search hit: clearing the filter or a refresh that drops it from
  // the results must not take the detail pane away from a URL that still names it.
  const selectedFilterItem = filterRows && selectedNumber !== null && !fullList.some(item => item.number === selectedNumber)
    ? filterRows.find(item => item.number === selectedNumber)
    : undefined
  const retainCandidate = selectedSearchItem ?? selectedFilterItem
  const [retainedDetail, setRetainedDetail] = useState<{ scope: string; view: GithubView; item: GithubItem } | null>(null)
  useEffect(() => {
    if (retainCandidate) setRetainedDetail({ scope, view, item: retainCandidate })
  }, [scope, view, retainCandidate])
  const remoteDetail = retainCandidate ?? (
    retainedDetail?.scope === scope && retainedDetail.view === view && retainedDetail.item.number === selectedNumber
      ? retainedDetail.item : null
  )
  return { selectedNumber, remoteDetail }
}

/**
 * A URL can name an item none of those hold — a closed or merged one, opened from a task tab's
 * "Files changed" or a pasted link (#692). Once the list has answered, ask GitHub for that
 * number alone, rather than calling a real item "Not found". Never for an item already held.
 */
export function useExactGithubItem(
  view: GithubView,
  gh: GithubData | undefined,
  selectedNumber: number | null,
  { fullList, filterRows }: GithubSidebarFilter,
  remoteDetail: GithubItem | null,
) {
  const queryClient = useQueryClient()
  const exactTargetRef = useRef<ExactTarget | null>(null)
  const itemKind = view === 'issues' ? 'issue' : 'pr'
  const exactWanted =
    gh?.available === true &&
    selectedNumber !== null &&
    Number.isSafeInteger(selectedNumber) &&
    selectedNumber > 0 &&
    !fullList.some((item) => item.number === selectedNumber) &&
    !filterRows?.some((item) => item.number === selectedNumber) &&
    remoteDetail === null
  const exactItem = useGithubItem(itemKind, selectedNumber ?? 0, exactWanted)
  const exactDetail =
    exactWanted && exactItem.data?.available && exactItem.data.item?.kind === itemKind ? exactItem.data.item : null
  exactTargetRef.current =
    exactWanted && selectedNumber !== null
      ? { kind: itemKind, number: selectedNumber, key: queryKeys.githubItem(itemKind, selectedNumber) }
      : null
  const [retryingExact, setRetryingExact] = useState(false)
  const retryExact = () => {
    setRetryingExact(true)
    void refetchExactItem(queryClient, exactTargetRef.current).then((landed) => {
      setRetryingExact(false)
      if (!landed) toast(`Could not reach GitHub for #${selectedNumber}`, { tone: 'danger' })
    })
  }
  return { exactWanted, exactItem, exactDetail, exactTargetRef, retryingExact, retryExact }
}
