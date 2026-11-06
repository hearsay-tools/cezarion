import type { ActivityRequest, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'
import { Link } from 'react-router'

import { cn } from '@/lib/utils'

import { LineText } from './activity-card'
import { lineTexts, recipientName, sentPeerRequests, type RunEntry } from './activity-model'
import { RunShape, ToneWord } from './activity-tone'
import { isLiveStatus, rootNow, type NowContext } from './now-box'
import { Heartbeat } from './now-box-view'

/**
 * One compact pill of the global view (spec 2026-11-05-live-activity-view, "Global view"): the
 * status shape, the title, a small heartbeat, one line (the card's verb in the rung tone and its
 * main line) and one dot for each live worker. The title link covers the pill, so the pill is a
 * link to its task; the narrow layout's "→ <task>" links sit above it.
 */

/** A task's page outside every project scope: the global view names the project in the path. */
export const projectTaskPath = (projectId: string, runId: string) => `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(runId)}`

interface PillProps {
  projectId: string
  task: ActivityRun
  requests: readonly ActivityRequest[]
  index: ReadonlyMap<string, RunEntry>
  ctx: NowContext
}

function WorkerDots({ task }: { task: ActivityRun }) {
  const live = task.workers.filter((worker) => isLiveStatus(worker.status))
  if (live.length === 0) return null
  return (
    <div data-slot="activity-pill-workers" className="mt-1.5 ml-[19px] flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      {live.map((worker) => <RunShape key={worker.runId} run={worker} role="worker" />)}
      <span className="ml-0.5">{live.length} worker{live.length === 1 ? '' : 's'}</span>
    </div>
  )
}

/** Below `md` the arcs are hidden; the sender pill names each peer it waits on instead. */
function PeerLinks({ projectId, task, requests, index }: Omit<PillProps, 'ctx'>) {
  const sent = sentPeerRequests(task.runId, requests)
  if (sent.length === 0) return null
  return (
    <ul data-slot="activity-peer-links" className="mt-1 ml-[19px] flex flex-col md:hidden">
      {sent.map((request) => (
        <li key={request.requestId}>
          <Link to={projectTaskPath(projectId, request.recipientRunId)} className="relative z-[1] inline-flex min-h-11 items-center text-[12px] text-message-peer-accent hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            → {recipientName(index, request)}
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function ActivityPill({ projectId, task, requests, index, ctx }: PillProps) {
  const box = rootNow(task, ctx)
  return (
    <li
      data-activity-pill={task.runId}
      data-rung={task.rung}
      className={cn('relative min-w-0 rounded-[10px] border bg-card-2 px-2.5 py-2', box.action ? 'border-pending' : 'border-border')}
    >
      <div className="flex items-center gap-[7px]">
        <RunShape run={task} role="root" />
        <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          <Link
            to={projectTaskPath(projectId, task.runId)}
            className="after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:outline-2 focus-visible:outline-ring"
          >
            {task.title}
          </Link>
        </h3>
        <Heartbeat rate={task.rate} className="h-3 w-10" />
      </div>
      <p data-slot="activity-pill-line" className="mt-[3px] ml-[19px] truncate text-[11.5px] text-muted-foreground tabular-nums">
        <ToneWord data-slot="activity-verb" tone={box.tone} className="font-semibold">{box.verb}</ToneWord>
        {' · '}
        <span data-slot="activity-main" className={cn(box.mono && 'font-mono text-[11px]')}>{box.main}</span>
      </p>
      <LineText texts={lineTexts(task.runId, requests, index)} />
      <WorkerDots task={task} />
      <PeerLinks projectId={projectId} task={task} requests={requests} index={index} />
    </li>
  )
}
