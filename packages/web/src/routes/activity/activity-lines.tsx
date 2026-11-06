import * as React from 'react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import type { RunEntry } from './activity-model'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { PEER_LABEL, measureLines, sameLines, type LineShape } from './line-measure'
import { visibleRect } from './line-viewport'
import { useComets } from './use-comets'
import { useOverlayMeasure } from './use-overlay-measure'

/**
 * The lines between tasks (spec 2026-11-05-live-activity-view, "Lines between tasks" and "Many
 * lines"): an SVG overlay over the graph (its parent element) and one HTML label per peer line.
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
  const start = Date.parse(request.createdAt)
  const end = Date.parse(request.deadline)
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
        'pointer-events-none absolute z-[4] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background px-1.5 py-[3px] text-[10px] leading-[1.3] text-foreground tabular-nums',
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
  index: ReadonlyMap<string, RunEntry>
  /** False in the one-column layout: peer requests become links on the sender card. */
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

function LinePath({ line, motion }: { line: LineShape; motion: MotionState }) {
  const phase = phaseOf(motion, line.requestId)
  return (
    <path
      data-request={line.requestId}
      data-kind={line.kind}
      data-phase={phase}
      d={line.d}
      fill="none"
      strokeDasharray={phase === 'replied' ? undefined : '6 5'}
      strokeWidth={line.kind === 'peer' ? 2.2 : 1.8}
      markerEnd={`url(#activity-arrow-${line.kind})`}
      className={cn(line.kind === 'peer' ? 'stroke-message-peer-accent' : 'stroke-message-inbound-accent', pathMotion(phase, line.requestId in motion.opening))}
    />
  )
}

export function ActivityLines({ requests, index, peers, layoutKey, now, motion = EMPTY_MOTION, paused = false }: LinesProps) {
  const overlayRef = React.useRef<SVGSVGElement>(null)
  const measure = React.useCallback(
    (host: HTMLElement) => measureLines(host, requests, index, { peers, frame: { width: host.clientWidth, view: visibleRect(host) } }),
    [requests, index, peers],
  )
  const lines = useOverlayMeasure(overlayRef, measure, sameLines, '[data-activity-card]', layoutKey, true)
  const drawn = React.useMemo(() => new Set(lines.map((line) => line.requestId)), [lines])
  const cometLayer = useComets(motion.comets, drawn, paused)
  const byId = new Map(requests.map((request) => [request.requestId, request]))
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
        </defs>
        {lines.map((line) => <LinePath key={line.requestId} line={line} motion={motion} />)}
        <g ref={cometLayer} data-slot="activity-comets" />
      </svg>
      {lines.map((line) => {
        const request = byId.get(line.requestId)
        return line.kind === 'peer' && request ? <PeerLabel key={line.requestId} line={line} request={request} now={now} phase={phaseOf(motion, line.requestId)} replied={saysReplied(motion, line.requestId)} /> : null
      })}
    </>
  )
}
