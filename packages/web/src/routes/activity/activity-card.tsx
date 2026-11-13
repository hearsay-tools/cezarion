import type { HTMLAttributes } from 'react'
import type { ActivityRequest, ActivityRun, ActivityWorker } from '@open-mercato/cezar-api-client/contract/activity'

import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { since, span } from './activity-format'
import { askOf, finishedText, foldedWorkers, lineTexts, type PeerWait, type RunEntry } from './activity-model'
import { EMPTY_MOTION, passedChecks, type MotionState } from './activity-motion'
import { RunShape, TONE_BORDER, TONE_FILL, TONE_INK } from './activity-tone'
import { isLiveStatus, rootNow, workerLine, type NowContext } from './now-box'
import { PeerLinks } from './peer-links'
import type { OnHover } from './use-wait-highlight'
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
  /** The open peer waits of the view: the card's text form and its narrow-layout links. */
  waits?: readonly PeerWait[]
  index: ReadonlyMap<string, RunEntry>
  ctx: NowContext
  /** More than 12 cards: no detail line, workers folded into dots. */
  dense: boolean
  /** One column: peer lines become "→ <task>" links on the sender card, and wait lines "⋯ waits
   *  on <task>" links on the waiter card. */
  narrow: boolean
  /** A peer wait links this card to the card under the pointer or holding the focus. */
  linked?: boolean
  /** The pointer or the focus entered this card or left it. */
  onHover?: OnHover
  motion?: MotionState
  /** A card that left the view, drawn while it collapses: no line ends at it, and it is hidden
   *  from assistive technology and from the keyboard. */
  ghost?: boolean
}

const taskPath = (runId: string) => `/tasks/${encodeURIComponent(runId)}`

function metaLine(run: ActivityRun | ActivityWorker, now: number): string {
  const parts = [run.runner, run.model, run.currentStepId ? `step ${run.currentStepId}` : undefined, run.startedAt ? span(since(run.startedAt, now)) : undefined]
  return parts.filter((part): part is string => Boolean(part)).join(' · ')
}

/** Screen-reader text for the lines that touch a row; the SVG lines themselves are hidden. */
export function LineText({ texts }: { texts: string[] }) {
  if (texts.length === 0) return null
  return (
    <ul data-slot="activity-line-text" className="sr-only">
      {texts.map((text, i) => <li key={i}>{text}</li>)}
    </ul>
  )
}

interface WorkerRowProps {
  worker: ActivityWorker
  parentId: string
  requests: readonly ActivityRequest[]
  index: ReadonlyMap<string, RunEntry>
  ctx: NowContext
  motion: MotionState
}

function WorkerRow({ worker, parentId, requests, index, ctx, motion }: WorkerRowProps) {
  const ask = askOf(worker.runId, parentId, requests)
  const line = workerLine(worker, ctx, ask?.text)
  const hold = motion.workerHold[worker.runId]
  return (
    <li
      data-slot="activity-worker"
      data-run={worker.runId}
      data-asks={line.asks ? 'true' : undefined}
      data-hold={hold?.phase}
      className={cn(
        'relative grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 rounded-lg py-[5px] before:absolute before:top-[13px] before:-left-3.5 before:w-2.5 before:border-t before:border-border',
        line.asks && '-mx-1.5 bg-message-inbound-bg px-1.5',
        worker.runId in motion.workerEnter && 'activity-row-enter',
        hold?.phase === 'fold' && 'activity-row-fold',
      )}
    >
      {hold ? <span key={hold.key} aria-hidden="true" className={cn('activity-row-flash', TONE_FILL[hold.tone])} /> : null}
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

function Workers({ task, requests, index, ctx, dense, motion }: Omit<CardProps, 'narrow' | 'motion'> & { motion: MotionState }) {
  // Settled done, failed and cancelled workers fold into the count; review workers stay a row. A
  // worker that just settled stays a row while it flashes, then folds.
  const held = (runId: string) => runId in motion.workerHold
  const rows = task.workers.filter((worker) => isLiveStatus(worker.status) || worker.status === 'review' || held(worker.runId))
  const finished = finishedText(foldedWorkers(task, held))
  return (
    <>
      {rows.length > 0 && dense ? <WorkerDots workers={rows} /> : null}
      {rows.length > 0 && !dense ? (
        <ul data-slot="activity-workers" className="mt-2 ml-1 border-l border-border pl-3.5">
          {rows.map((worker) => <WorkerRow key={worker.runId} worker={worker} parentId={task.runId} requests={requests} index={index} ctx={ctx} motion={motion} />)}
        </ul>
      ) : null}
      {finished ? <p data-slot="activity-finished" className="mt-1.5 ml-[18px] text-[11px] text-muted-foreground">{finished}</p> : null}
    </>
  )
}

const PEER_LINK = 'relative z-[1] text-[12px] text-message-peer-accent hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center'

/** Pointer and focus handlers that report the card to the board's wait highlight. Focus moving
 *  between two elements of one card keeps the card. */
export function hoverHandlers(runId: string, onHover: CardProps['onHover']): HTMLAttributes<HTMLElement> {
  if (!onHover) return {}
  return {
    onPointerEnter: () => onHover('pointer', runId),
    onPointerLeave: () => onHover('pointer', undefined),
    onFocus: () => onHover('focus', runId),
    onBlur: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHover('focus', undefined)
    },
  }
}

/** The card's entry and its collapse. */
function cardMotion(task: ActivityRun, motion: MotionState, ghost: boolean): string | undefined {
  if (ghost) return 'activity-card-leave'
  return task.runId in motion.entering ? 'activity-card-enter' : undefined
}

/** The glow and the flash of a card or a pill: layers over its border. */
export function CardEffects({ task, motion, glow }: { task: ActivityRun; motion: MotionState; glow: boolean }) {
  const flash = motion.flash[task.runId]
  return (
    <>
      {glow ? <span aria-hidden="true" className="activity-glow" /> : null}
      {flash ? <span key={flash.key} data-slot="activity-flash" data-tone={flash.tone} aria-hidden="true" className={cn('activity-flash', TONE_BORDER[flash.tone])} /> : null}
    </>
  )
}

const NO_WAITS: readonly PeerWait[] = []

export function ActivityCard({ task, requests, waits = NO_WAITS, index, ctx, dense, narrow, motion = EMPTY_MOTION, ghost = false, linked = false, onHover }: CardProps) {
  const box = rootNow(task, ctx)
  // A ghost is not a line end: the lines measure only `data-activity-card`.
  const identity = ghost ? { 'data-activity-ghost': task.runId, inert: true, 'aria-hidden': true } : { 'data-activity-card': task.runId }
  const now = { sweep: task.rung === 'running' && isLiveStatus(task.status), slideKey: motion.slides[task.runId]?.key, passed: passedChecks(motion, task.runId) }
  return (
    <article
      {...identity}
      data-flip={task.runId}
      data-rung={task.rung}
      data-action={box.action}
      data-linked={linked && !ghost ? 'true' : undefined}
      {...(ghost ? {} : hoverHandlers(task.runId, onHover))}
      className={cn(
        'relative min-w-0 rounded-xl border bg-card px-3.5 py-3',
        box.action ? 'border-pending' : 'border-border',
        linked && !ghost && 'outline-2 outline-offset-2 outline-message-peer-accent',
        cardMotion(task, motion, ghost),
      )}
    >
      <CardEffects task={task} motion={motion} glow={box.action !== undefined && !ghost} />
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
      <LineText texts={lineTexts(task.runId, requests, index, waits)} />
      <NowBoxView box={box} now={ctx.now} dense={dense} motion={now} />
      {box.action ? (
        <div className="mt-2 flex gap-1.5">
          <Button asChild size="sm" variant={box.action === 'answer' ? 'primary' : 'outline'} className="relative z-[1] max-md:min-h-11">
            <Link to={taskPath(task.runId)}>{box.action === 'answer' ? 'Answer' : 'Open task'}</Link>
          </Button>
        </div>
      ) : null}
      {narrow ? <PeerLinks runId={task.runId} requests={requests} waits={waits} index={index} link={Link} pathOf={taskPath} className="mt-2 flex flex-col gap-1" linkClassName={PEER_LINK} /> : null}
      <Workers task={task} requests={requests} index={index} ctx={ctx} dense={dense} motion={motion} />
    </article>
  )
}
