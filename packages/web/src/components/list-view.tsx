import * as React from 'react'
import type { ReactNode } from 'react'

import type { ListView } from '@/lib/task-groups'

/**
 * The sidebar quick-list's Active/Archived filter.
 *
 * The Tasks table owns its own copy: per-project as local state, global `/tasks` as `archived=1`
 * in the URL. Switching one must not change the other — browsing archived rows on the table still
 * needs the live runs in the sidebar. Context is what keeps every sidebar group on the same
 * question; the table is not a consumer.
 *
 * In-memory, not persisted: the filter resets to Active on every reload, and a filter that
 * silently survives a restart hides runs the user does not know are hidden.
 */
const ListViewContext = React.createContext<[ListView, (view: ListView) => void] | null>(null)

export function ListViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = React.useState<ListView>('active')
  // The tuple is memoized so a re-render of the provider (which sits high in the tree) does not
  // invalidate the context for every consumer below it.
  const value = React.useMemo(() => [view, setView] as [ListView, (view: ListView) => void], [view])
  return <ListViewContext.Provider value={value}>{children}</ListViewContext.Provider>
}

/** Throws without a provider, on purpose: a default would let a sidebar consumer mount outside
 *  the shell and quietly keep its own private filter. */
export function useListView(): [ListView, (view: ListView) => void] {
  const value = React.useContext(ListViewContext)
  if (!value) throw new Error('useListView must be used inside a <ListViewProvider>')
  return value
}
