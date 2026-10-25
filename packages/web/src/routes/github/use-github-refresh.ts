import { hashKey, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useRef } from 'react'

import { getGithub, getGithubCommentCounts, getGithubComments } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { GithubPageParam } from '@/api/github-pages'
import type { GithubData } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

import type { GithubView } from './github'
import { FAILING_QUERY, GITHUB_PAGE_SIZE, REVIEW_QUERY } from './github-sidebar-model'
import { refetchExactItem, type ExactTarget } from './use-github-selection'

/**
 * The tab's Refresh: the list, the open thread and every search the tab shows, past the
 * server's caches. `checkPrNumbers` and `debouncedQuery` are the ones on screen when the refresh
 * lands; the mutation takes the exact item as its variable, read when Refresh is pressed.
 */
export function useGithubRefresh(view: GithubView, checkPrNumbers: number[], debouncedQuery: string) {
  const queryClient = useQueryClient()
  // The thread actually ON SCREEN, so a manual refresh can bust its SERVER cache.
  //
  // Deliberately a ref fed from the rendered `selected`, NOT derived from the `:n` route param.
  // With no `:n` the tab still renders a thread — `selected` falls back to `items[0]` (see
  // `selectGithubItem`, legacy behavior) — so keying off the URL would leave the bare `/github` and
  // `/github/prs` routes, i.e. the default landing pages, refreshing nothing. A ref because this
  // mutation is defined before `selected` exists and reads it at click time, not render time.
  const openThreadRef = useRef<{ kind: 'issue' | 'pr'; number: number } | null>(null)

  const refresh = useMutation({
    mutationFn: (exact: ExactTarget | null) => {
      // Started beside the list, not after it: the item has its own cache and its own failure, and
      // a list refresh that fails must still be able to recover a failed exact fetch.
      void refetchExactItem(queryClient, exact)
      return getGithub({ refresh: true, limit: GITHUB_PAGE_SIZE })
    },
    onSuccess: async (data) => {
      // A refresh starts the list over at one fresh first page: later pages were cut against the
      // old cursors, and the next scroll loads them again from this page's (#1183). A page load
      // still in flight is cancelled first, or it would land its old pages over the fresh one.
      // Then re-hydrate the visible checks window so glyphs track the fresh rows.
      await queryClient.cancelQueries({ queryKey: queryKeys.githubPages(GITHUB_PAGE_SIZE), exact: true })
      queryClient.setQueryData<InfiniteData<GithubData, GithubPageParam>>(
        queryKeys.githubPages(GITHUB_PAGE_SIZE), { pages: [data], pageParams: [{}] })
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubChecks(checkPrNumbers) })
      // Comment counts past the server's 60 s cache for the fresh page; every other cached
      // count is dropped so it is asked for again when its page is next loaded.
      const countsKind = view === 'issues' ? 'issue' : 'pr'
      const fresh = (view === 'issues' ? data.issues : data.prs).map((item) => item.number)
      const freshKey = queryKeys.githubCommentCounts(countsKind, fresh)
      void queryClient.removeQueries({
        queryKey: queryKeys.githubCommentCounts(countsKind, []).slice(0, 4),
        predicate: (q) => q.queryHash !== hashKey(freshKey),
      })
      if (data.available && data.commentsDeferred && fresh.length > 0) {
        void getGithubCommentCounts(countsKind, fresh, { refresh: true })
          .then((counts) => queryClient.setQueryData(freshKey, counts))
          .catch(() => { /* the badges keep what they had */ })
      }
      // Search has no server cache; refresh the active narrow as well as the open list.
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubSearch(view === 'issues' ? 'issue' : 'pr', debouncedQuery) })
      // The sidebar's qualifier searches (Review requested / Checks failing) have no server cache
      // either; a refresh that left them stale would show yesterday's hits in a fresh list.
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubSearch('pr', REVIEW_QUERY) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubSearch('pr', FAILING_QUERY) })

      // The open thread must be re-fetched with `refresh: true` (#525). Invalidating its key is
      // NOT enough, and was the bug in the first attempt: an invalidate re-requests
      // `/api/github/comments/…` WITHOUT `refresh=1`, and the route only busts `commentsCache`
      // when that param is present — so the client dutifully refetched and was handed the same
      // ≤60 s-old object. Pressing refresh has to reach `gh`, or it is theatre.
      const open = openThreadRef.current
      if (!open) {
        // No thread on screen (the unavailable branch) — nothing mounted, so clearing is free.
        void queryClient.removeQueries({ queryKey: ['github', 'comments'] })
        return
      }
      const openKey = queryKeys.githubComments(open.kind, open.number)
      // Fire-and-forget rather than awaited in `mutationFn`: a thread fetch that fails must not
      // discard an already-successful list refresh.
      void getGithubComments(open.kind, open.number, { refresh: true })
        .then((thread) => queryClient.setQueryData(openKey, thread))
        .catch(() => {
          /* the list refresh still landed; leave the thread showing what it has */
        })
      // Every OTHER cached thread is now suspect but not on screen — drop it so it refetches when
      // next opened. The open one MUST be excluded: removing a mounted query resets it to pending
      // and flashes the loading skeleton under the user.
      void queryClient.removeQueries({
        queryKey: ['github', 'comments'],
        predicate: (q) => q.queryHash !== hashKey(openKey),
      })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })
  return { refresh, openThreadRef }
}
