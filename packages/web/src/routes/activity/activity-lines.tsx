import * as React from 'react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import type { PeerWait, RunEntry } from './activity-model'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { PEER_LABEL, measureLines, sameLines, type LineShape } from './line-measure'
import { visibleRect } from './line-viewport'
import { useComets } from './use-comets'
import { useOverlayMeasure } from './use-overlay-measure'

/**
 * The lines between tasks (spec 2026-11-05-live-activity-view, "Lines between tasks" and "Many
 * lines"): an SVG overlay over the graph (its parent element) and one HTML label per peer or wait
 * line.
 * Geometry is measured from the laid-out cards (`useOverlayMeasure`) and from what of the graph is
 * on screen, again on every scroll. Open lines march; a closed line plays its reply or fades.
 */

/** Where a drawn line is in its life: open, or closed and still playing its last motion. */
export type LinePhase = 'open' | 'reply' | 'replied' | 'fade'

const SHORT_TEXT = 28

/** The label's short form of a question. */
export function shortText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SHORT_TEXT ? `${flat.slice(0, SHORT_TEXT - 1).trimEnd()}…` : flat
}

/** How much of the reply window is used, 0 to 1; undefined without a deadline. */
export function windowUsed(request: Pick<ActivityRequest, 'createdAt' | 'deadline'>, now: number): number | undefined {
  if (request.deadline === undefined) return undefined
  return spanUsed(request.createdAt, request.deadline, now)
}

/** How much of the span from `from` to `to` has passed at `now`, 0 to 1. */
export function spanUsed(from: string, to: string, now: number): number {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1
  return Math.min(1, Math.max(0, (now - start) / (end - start)))
}

/** The class of a line path in its phase: open dashes march, a new line fades in behind its
 *  comet, a replied line turns solid, a closing one fades out. */
export function pathMotion(phase: LinePhase, opening: boolean): string | undefined {
  if (phase === 'fade') return 'activity-line-out'
  if (phase === 'replied') return undefined
  return cn('activity-march', opening && 'activity-line-in')
}

/** The class of a wait line: open dots drift from the peer to the waiter, a new line fades in,
 *  an ended one fades out. */
export function waitMotion(motion: MotionState, id: string): string {
  return id in motion.waitsClosing ? 'activity-line-out' : cn('activity-drift', id in motion.opening && 'activity-line-in')
}

const LABEL_BOX = 'pointer-events-none absolute z-[4] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background px-1.5 py-[3px] text-[10px] leading-[1.3] text-foreground tabular-nums'

/** A wait line's label: "Waiting", its age, a stub's other task, and how much of the wait's
 *  deadline window is used. Its border is dashed, as the line is not a request. */
function WaitLabel({ line, wait, now, motion }: { line: LineShape; wait: PeerWait; now: number; motion: MotionState }) {
  return (
    <div
      data-slot="activity-line-label"
      data-wait={wait.id}
      aria-hidden="true"
      style={{ left: line.label.x, top: line.label.y, width: PEER_LABEL.w }}
      className={cn(LABEL_BOX, 'border-dashed border-message-peer-accent', wait.id in motion.waitsClosing && 'activity-line-out')}
    >
      <span className="flex gap-1 font-semibold">
        <span className="min-w-0 truncate text-message-peer-accent">Waiting</span>
        <span className="ml-auto shrink-0">{counter(since(wait.since, now))}</span>
      </span>
      {line.away ? <span className="block truncate">{line.away}</span> : null}
      <span data-slot="activity-wait-bar" className="mt-[3px] block h-[3px] overflow-hidden rounded-sm bg-border">
        <span className="block h-full bg-message-peer-accent opacity-70" style={{ width: `${Math.round(spanUsed(wait.since, wait.deadline, now) * 100)}%` }} />
      </span>
    </div>
  )
}

function PeerLabel({ line, request, now, phase, replied }: { line: LineShape; request: ActivityRequest; now: number; phase: LinePhase; replied: boolean }) {
  const used = windowUsed(request, now)
  return (
    <div
      data-slot="activity-line-label"
      data-request={request.requestId}
      data-phase={phase}
      aria-hidden="true"
      style={{ left: line.label.x, top: line.label.y, width: PEER_LABEL.w }}
      className={cn(
        LABEL_BOX,
        replied ? 'border-success' : 'border-message-peer-accent',
        phase === 'fade' && 'activity-line-out',
      )}
    >
      <span className="flex gap-1 font-semibold">
        {replied ? <span className="text-success">Replied</span> : <span className="min-w-0 truncate text-message-peer-accent">Request</span>}
        <span className="ml-auto shrink-0">{counter(since(request.createdAt, now))}</span>
      </span>
      <span className="block truncate">{line.away ?? shortText(request.text)}</span>
      {used === undefined || replied ? null : (
        <span className="mt-[3px] block h-[3px] overflow-hidden rounded-sm bg-border">
          <span className="block h-full bg-message-peer-accent" style={{ width: `${Math.round(used * 100)}%` }} />
        </span>
      )}
    </div>
  )
}

interface LinesProps {
  /** The open requests and, after them, the closed ones still playing their motion. */
  requests: readonly ActivityRequest[]
  /** The open peer waits and, after them, the ended ones still fading out. */
  waits?: readonly PeerWait[]
  /** The wait lines that touch the card under the pointer or the focus: drawn stronger. */
  active?: ReadonlySet<string>
  index: ReadonlyMap<string, RunEntry>
  /** False in the one-column layout: peer requests and waits become links on the cards. */
  peers: boolean
  /** Changes whenever the cards may have moved: a new placement or a new snapshot. */
  layoutKey: string
  now: number
  motion?: MotionState
  paused?: boolean
}

export const phaseOf = (motion: MotionState, requestId: string): LinePhase => motion.closing[requestId]?.phase ?? 'open'

/** A label says "Replied" once the reply comet arrives, through the fade. */
export function saysReplied(motion: MotionState, requestId: string): boolean {
  const closing = motion.closing[requestId]
  return closing !== undefined && closing.replied && closing.phase !== 'reply'
}

const NO_IDS: ReadonlySet<string> = new Set()

function LinePath({ line, motion }: { line: LineShape; motion: MotionState }) {
  const phase = phaseOf(motion, line.id)
  return (
    <path
      data-request={line.id}
      data-kind={line.kind}
      data-phase={phase}
      d={line.d}
      fill="none"
      strokeDasharray={phase === 'replied' ? undefined : '6 5'}
      strokeWidth={line.kind === 'peer' ? 2.2 : 1.8}
      markerEnd={`url(#activity-arrow-${line.kind})`}
      className={cn(line.kind === 'peer' ? 'stroke-message-peer-accent' : 'stroke-message-inbound-accent', pathMotion(phase, line.id in motion.opening))}
    />
  )
}

/** A wait line: round dots with no arrowhead, a ring at the waiter's end. */
function WaitPath({ line, motion, active }: { line: LineShape; motion: MotionState; active: boolean }) {
  return (
    <path
      data-wait={line.id}
      data-kind="wait"
      data-active={active ? 'true' : undefined}
      d={line.d}
      fill="none"
      strokeDasharray="0 8"
      strokeLinecap="round"
      strokeWidth={active ? 3.2 : 2.4}
      markerEnd="url(#activity-ring-wait)"
      className={cn('stroke-message-peer-accent', active ? 'opacity-100' : 'opacity-80', waitMotion(motion, line.id))}
    />
  )
}

/** The ring a wait line ends in: hollow, as the status ring of a task that waits outside itself. */
export function WaitRing({ id }: { id: string }) {
  return (
    <marker id={id} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="5" markerHeight="5" markerUnits="strokeWidth" orient="auto">
      <circle cx="6" cy="6" r="4" strokeWidth="2.4" className="fill-background stroke-message-peer-accent" />
    </marker>
  )
}

const NO_WAITS: readonly PeerWait[] = []

export function ActivityLines({ requests, waits = NO_WAITS, active = NO_IDS, index, peers, layoutKey, now, motion = EMPTY_MOTION, paused = false }: LinesProps) {
  const overlayRef = React.useRef<SVGSVGElement>(null)
  const measure = React.useCallback(
    (host: HTMLElement) => measureLines(host, requests, index, { peers, waits, frame: { width: host.clientWidth, view: visibleRect(host) } }),
    [requests, waits, index, peers],
  )
  const lines = useOverlayMeasure(overlayRef, measure, sameLines, '[data-activity-card]', layoutKey, true)
  const drawn = React.useMemo(() => new Set(lines.map((line) => line.id)), [lines])
  const cometLayer = useComets(motion.comets, drawn, paused)
  const byId = new Map(requests.map((request) => [request.requestId, request]))
  const waitById = new Map(waits.map((wait) => [wait.id, wait]))
  return (
    <>
      <svg ref={overlayRef} data-slot="activity-lines" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3] size-full overflow-visible">
        <defs>
          <marker id="activity-arrow-peer" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 10 5 0 10z" className="fill-message-peer-accent" />
          </marker>
          <marker id="activity-arrow-family" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 10 5 0 10z" className="fill-message-inbound-accent" />
          </marker>
          <WaitRing id="activity-ring-wait" />
        </defs>
        {lines.map((line) => line.kind === 'wait'
          ? <WaitPath key={line.id} line={line} motion={motion} active={active.has(line.id)} />
          : <LinePath key={line.id} line={line} motion={motion} />)}
        <g ref={cometLayer} data-slot="activity-comets" />
      </svg>
      {lines.map((line) => {
        const wait = line.kind === 'wait' ? waitById.get(line.id) : undefined
        if (wait) return <WaitLabel key={line.id} line={line} wait={wait} now={now} motion={motion} />
        const request = byId.get(line.id)
        return line.kind === 'peer' && request ? <PeerLabel key={line.id} line={line} request={request} now={now} phase={phaseOf(motion, line.id)} replied={saysReplied(motion, line.id)} /> : null
      })}
    </>
  )
}
