import type { ReactNode } from 'react'

import { useRun } from '@/api/queries'
import { ApiError } from '@/api/client'
import { runTitle } from '@/lib/task-groups'

import { taskTitleFor, type TaskTitleMap } from './conversation-presentation'

/** How a card names the other task of a message, and whether its thread can be opened. */
export interface CounterpartView {
  title: string
  linkable: boolean
}

/**
 * A worker or parent keeps its old behavior: the title the run list or relationships answer
 * carries, or "Task". A peer is any root task of the project, and the run list holds only a
 * window of them, so a peer without a title is read from the server. Until that answers, or when
 * it says the task is gone, the card names it without a link: a link to a deleted task is broken.
 */
export function Counterpart({ id, peer, taskTitles, children }: {
  id: string
  peer: boolean
  taskTitles?: TaskTitleMap | undefined
  children: (view: CounterpartView) => ReactNode
}) {
  if (!peer || taskTitles?.[id] !== undefined) return children({ title: taskTitleFor(id, taskTitles), linkable: true })
  return <LookedUpPeer id={id}>{children}</LookedUpPeer>
}

function LookedUpPeer({ id, children }: { id: string; children: (view: CounterpartView) => ReactNode }) {
  const run = useRun(id)
  if (run.data) return children({ title: runTitle(run.data), linkable: true })
  if (run.isPending) return children({ title: 'Peer task', linkable: false })
  return children({ title: run.error instanceof ApiError && run.error.status === 404 ? 'Deleted task' : 'Task unavailable', linkable: false })
}
