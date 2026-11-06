import * as React from 'react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import { WaitRing, pathMotion, phaseOf, saysReplied, waitMotion } from './activity-lines'
import type { PeerWait } from './activity-model'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { arcPath, relativeBox, type Box, type Point } from './line-geometry'
import { waitLane } from './line-measure'
import { laneOffsets, separateLabels } from './line-route'
import { useComets } from './use-comets'
import { useOverlayMeasure } from './use-overlay-measure'

/**
 * The global view's static peer arcs (spec 2026-11-05-live-activity-view, "Global view"): one
 * dashed arc above the pills for each open peer request inside one panel, and one dotted arc for
 * each open peer wait, from the peer to the waiter, each with its age label.
 * Measured from the laid-out pills of this panel's strip (the overlay's parent), so an arc never
 * leaves its panel. Below `md` the arcs hide and the sender pill names its peer instead. The arcs
 * move as the project view's lines do: open dashes march, comets travel, a closed arc fades.
 */

/** The size an age label takes, for placing labels clear of the pills and of each other. */
export const ARC_LABEL = { w: 104, h: 20 }

export interface ArcShape {
  /** The request id, or the peer wait's `id`. */
  id: string
  kind: 'peer' | 'wait'
  d: string
  label: Point
}

function pillBoxes(host: HTMLElement): Map<string, Box> {
  const origin = host.getBoundingClientRect()
  const out = new Map<string, Box>()
  for (const el of host.querySelectorAll<HTMLElement>('[data-activity-pill]')) {
    const id = el.getAttribute('data-activity-pill')
    if (id) out.set(id, relativeBox(el.getBoundingClientRect(), origin))
  }
  return out
}

/** Every arc whose two pills are in the host. A wait arc runs from the peer to the waiter. */
export function measureArcs(host: HTMLElement, arcs: readonly ActivityRequest[], waits: readonly PeerWait[] = []): ArcShape[] {
  const pills = pillBoxes(host)
  const all = [...pills.values()]
  const ends = [
    ...arcs.map((request) => ({ requestId: request.requestId, senderRunId: request.senderRunId, recipientRunId: request.recipientRunId, kind: 'peer' as const })),
    ...waits.map((wait) => ({ ...waitLane(wait), kind: 'wait' as const })),
  ]
  const lanes = laneOffsets(ends)
  const shapes: ArcShape[] = []
  for (const end of ends) {
    const from = pills.get(end.senderRunId)
    const to = pills.get(end.recipientRunId)
    if (from && to) shapes.push({ id: end.requestId, kind: end.kind, ...arcPath(from, to, all, lanes.get(end.requestId)) })
  }
  // Labels sit above a row or in a row gap: moving one sideways keeps it off the pills.
  const labels = separateLabels(shapes.map((shape) => ({ id: shape.id, at: shape.label })), ARC_LABEL, 'x')
  return shapes.map((shape) => ({ ...shape, label: labels.get(shape.id) ?? shape.label }))
}

export function sameArcs(a: readonly ArcShape[], b: readonly ArcShape[]): boolean {
  return a.length === b.length && a.every((arc, i) => arc.id === b[i]?.id && arc.d === b[i]?.d && arc.label.x === b[i]?.label.x && arc.label.y === b[i]?.label.y)
}

interface ArcsProps {
  arcs: readonly ActivityRequest[]
  /** The panel's open peer waits and, after them, the ended ones still fading out. */
  waits?: readonly PeerWait[]
  /** The wait arcs that touch the pill under the pointer or the focus: drawn stronger. */
  active?: ReadonlySet<string>
  layoutKey: string
  now: number
  motion?: MotionState
  paused?: boolean
}

const ARC_LABEL_BOX = 'pointer-events-none absolute z-[4] -translate-x-1/2 -translate-y-1/2 rounded-md border bg-background px-1.5 py-px text-[10.5px] whitespace-nowrap text-foreground tabular-nums max-md:hidden'

function WaitArcLabel({ arc, wait, now, motion }: { arc: ArcShape; wait: PeerWait; now: number; motion: MotionState }) {
  return (
    <span
      data-slot="activity-arc-label"
      data-wait={wait.id}
      aria-hidden="true"
      style={{ left: arc.label.x, top: arc.label.y }}
      className={cn(ARC_LABEL_BOX, 'border-dashed border-message-peer-accent', wait.id in motion.waitsClosing && 'activity-line-out')}
    >
      <span className="font-semibold text-message-peer-accent">Waiting</span> · {counter(since(wait.since, now))}
    </span>
  )
}

function ArcLabel({ arc, request, now, motion }: { arc: ArcShape; request: ActivityRequest; now: number; motion: MotionState }) {
  const replied = saysReplied(motion, arc.id)
  return (
    <span
      data-slot="activity-arc-label"
      data-request={arc.id}
      aria-hidden="true"
      style={{ left: arc.label.x, top: arc.label.y }}
      className={cn(
        ARC_LABEL_BOX,
        replied ? 'border-success' : 'border-message-peer-accent',
        phaseOf(motion, arc.id) === 'fade' && 'activity-line-out',
      )}
    >
      {replied ? <span className="font-semibold text-success">Replied</span> : <span className="font-semibold text-message-peer-accent">Request</span>} · {counter(since(request.createdAt, now))}
    </span>
  )
}

const NO_WAITS: readonly PeerWait[] = []
const NO_IDS: ReadonlySet<string> = new Set()

export function ActivityArcs({ arcs, waits = NO_WAITS, active = NO_IDS, layoutKey, now, motion = EMPTY_MOTION, paused = false }: ArcsProps) {
  const overlayRef = React.useRef<SVGSVGElement>(null)
  const measure = React.useCallback((host: HTMLElement) => measureArcs(host, arcs, waits), [arcs, waits])
  const shapes = useOverlayMeasure(overlayRef, measure, sameArcs, '[data-activity-pill]', layoutKey)
  const drawn = React.useMemo(() => new Set(shapes.map((arc) => arc.id)), [shapes])
  const cometLayer = useComets(motion.comets, drawn, paused)
  const byId = new Map(arcs.map((request) => [request.requestId, request]))
  const waitById = new Map(waits.map((wait) => [wait.id, wait]))
  // One overlay per panel: each needs its own marker ids.
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const marker = `activity-arrow-arc-${uid}`
  const ring = `activity-ring-arc-${uid}`
  return (
    <>
      <svg ref={overlayRef} data-slot="activity-arcs" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3] size-full overflow-visible max-md:hidden">
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 10 5 0 10z" className="fill-message-peer-accent" />
          </marker>
          <WaitRing id={ring} />
        </defs>
        {shapes.map((arc) => {
          if (arc.kind === 'wait') {
            const on = active.has(arc.id)
            return (
              <path
                key={arc.id}
                data-wait={arc.id}
                data-kind="wait"
                data-active={on ? 'true' : undefined}
                d={arc.d}
                fill="none"
                strokeDasharray="0 8"
                strokeLinecap="round"
                strokeWidth={on ? 3 : 2.2}
                markerEnd={`url(#${ring})`}
                className={cn('stroke-message-peer-accent', on ? 'opacity-100' : 'opacity-80', waitMotion(motion, arc.id))}
              />
            )
          }
          const phase = phaseOf(motion, arc.id)
          return (
            <path
              key={arc.id}
              data-request={arc.id}
              data-kind="peer"
              data-phase={phase}
              d={arc.d}
              fill="none"
              strokeDasharray={phase === 'replied' ? undefined : '6 5'}
              strokeWidth={2}
              markerEnd={`url(#${marker})`}
              className={cn('stroke-message-peer-accent', pathMotion(phase, arc.id in motion.opening))}
            />
          )
        })}
        <g ref={cometLayer} data-slot="activity-comets" />
      </svg>
      {shapes.map((arc) => {
        const wait = arc.kind === 'wait' ? waitById.get(arc.id) : undefined
        if (wait) return <WaitArcLabel key={arc.id} arc={arc} wait={wait} now={now} motion={motion} />
        const request = byId.get(arc.id)
        return request ? <ArcLabel key={arc.id} arc={arc} request={request} now={now} motion={motion} /> : null
      })}
    </>
  )
}
