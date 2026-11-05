import type { ActivityRequest, ActivityRun, ActivityWorker } from '@open-mercato/cezar-api-client/contract/activity'

import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { since, span } from './activity-format'
import { askOf, finishedText, foldedWorkers, lineTexts, recipientName, sentPeerRequests, type RunEntry } from './activity-model'
import { RunShape, TONE_INK } from './activity-tone'
import { isLiveStatus, rootNow, workerLine, type NowContext } from './now-box'
import { Heartbeat, NowBoxView } from './now-box-view'

/**
 * One task card of the activity graph (spec 2026-11-05-live-activity-view, "Task cards"): the
 * status shape, the title and meta, the heartbeat, the now box, the workers and the text form of
 * the card's lines. The title link covers the whole card, so the card is a link to its task; the
 * buttons and worker links sit above it.
 */

export interface CardProps {
  task: ActivityRun
  requests: readonly ActivityRequest[]
  index: ReadonlyMap<string, RunEntry>
  ctx: NowContext
  /** More than 12 cards: no detail line, workers folded into dots. */
  dense: boolean
  /** One column: peer lines become "→ <task>" links on the sender card. */
  narrow: boolean
}

const taskPath = (runId: string) => `/tasks/${encodeURIComponent(runId)}`

function metaLine(run: ActivityRun | ActivityWorker, now: number): string {
  const parts = [run.runner, run.model, run.currentStepId ? `step ${run.currentStepId}` : undefined, run.startedAt ? span(since(run.startedAt, now)) : undefined]
  return parts.filter((part): part is string => Boolean(part)).join(' · ')
}

/** Screen-reader text for the lines that touch a row; the SVG lines themselves are hidden. */
function LineText({ texts }: { texts: string[] }) {
  if (texts.length === 0) return null
  return (
    <ul data-slot="activity-line-text" className="sr-only">
      {texts.map((text, i) => <li key={i}>{text}</li>)}
    </ul>
  )
}

function WorkerRow({ worker, parentId, requests, index, ctx }: { worker: ActivityWorker; parentId: string; requests: readonly ActivityRequest[]; index: ReadonlyMap<string, RunEntry>; ctx: NowContext }) {
  const ask = askOf(worker.runId, parentId, requests)
  const line = workerLine(worker, ctx, ask?.text)
  return (
    <li
      data-slot="activity-worker"
      data-run={worker.runId}
      data-asks={line.asks ? 'true' : undefined}
      className={cn('relative grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 rounded-lg py-[5px] before:absolute before:top-[13px] before:-left-3.5 before:w-2.5 before:border-t before:border-border', line.asks && '-mx-1.5 bg-message-inbound-bg px-1.5')}
    >
      <span className="mt-[3px]"><RunShape run={worker} role="worker" /></span>
      <span className="min-w-0 truncate text-[12.5px] font-medium">
        <Link to={taskPath(worker.runId)} className="relative z-[1] hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center">{worker.title}</Link>
        <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{[worker.runner, worker.model].filter(Boolean).join(' · ')}</span>
      </span>
      <span data-slot="activity-worker-line" className="col-start-2 truncate text-[11.5px] text-muted-foreground tabular-nums">
        <b className={cn('font-semibold', TONE_INK[line.tone])}>{line.verb}</b> · <span className={cn(line.mono && 'font-mono')}>{line.main}</span>
      </span>
      <LineText texts={lineTexts(worker.runId, requests, index)} />
    </li>
  )
}

function WorkerDots({ workers }: { workers: readonly ActivityWorker[] }) {
  return (
    <div data-slot="activity-worker-dots" className="mt-2 ml-[18px] flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      {workers.map((worker) => <RunShape key={worker.runId} run={worker} role="worker" />)}
      <span className="ml-1">{workers.length} worker{workers.length === 1 ? '' : 's'}</span>
    </div>
  )
}

function Workers({ task, requests, index, ctx, dense }: Omit<CardProps, 'narrow'>) {
  // Settled done, failed and cancelled workers fold into the count; review workers stay a row.
  const rows = task.workers.filter((worker) => isLiveStatus(worker.status) || worker.status === 'review')
  const finished = finishedText(foldedWorkers(task))
  return (
    <>
      {rows.length > 0 && dense ? <WorkerDots workers={rows} /> : null}
      {rows.length > 0 && !dense ? (
        <ul data-slot="activity-workers" className="mt-2 ml-1 border-l border-border pl-3.5">
          {rows.map((worker) => <WorkerRow key={worker.runId} worker={worker} parentId={task.runId} requests={requests} index={index} ctx={ctx} />)}
        </ul>
      ) : null}
      {finished ? <p data-slot="activity-finished" className="mt-1.5 ml-[18px] text-[11px] text-muted-foreground">{finished}</p> : null}
    </>
  )
}

function PeerLinks({ task, requests, index }: Pick<CardProps, 'task' | 'requests' | 'index'>) {
  const sent = sentPeerRequests(task.runId, requests)
  if (sent.length === 0) return null
  return (
    <ul data-slot="activity-peer-links" className="mt-2 flex flex-col gap-1">
      {sent.map((request) => (
        <li key={request.requestId}>
          <Link to={taskPath(request.recipientRunId)} className="relative z-[1] text-[12px] text-message-peer-accent hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center">
            → {recipientName(index, request)}
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function ActivityCard({ task, requests, index, ctx, dense, narrow }: CardProps) {
  const box = rootNow(task, ctx)
  return (
    <article
      data-activity-card={task.runId}
      data-rung={task.rung}
      className={cn('relative min-w-0 rounded-xl border bg-card px-3.5 py-3', box.action ? 'border-pending' : 'border-border')}
    >
      <header className="flex items-center gap-2">
        <RunShape run={task} role="root" />
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
          <Link to={taskPath(task.runId)} className="after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-2 focus-visible:outline-ring">
            {task.title}
          </Link>
        </h3>
        <Heartbeat rate={task.rate} />
      </header>
      <p className="mt-0.5 mb-2 ml-5 truncate text-[11.5px] text-muted-foreground">{metaLine(task, ctx.now)}</p>
      <LineText texts={lineTexts(task.runId, requests, index)} />
      <NowBoxView box={box} now={ctx.now} dense={dense} />
      {box.action ? (
        <div className="mt-2 flex gap-1.5">
          <Button asChild size="sm" variant={box.action === 'answer' ? 'primary' : 'outline'} className="relative z-[1] max-md:min-h-11">
            <Link to={taskPath(task.runId)}>{box.action === 'answer' ? 'Answer' : 'Open task'}</Link>
          </Button>
        </div>
      ) : null}
      {narrow ? <PeerLinks task={task} requests={requests} index={index} /> : null}
      <Workers task={task} requests={requests} index={index} ctx={ctx} dense={dense} />
    </article>
  )
}
