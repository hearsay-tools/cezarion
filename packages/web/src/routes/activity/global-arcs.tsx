import * as React from 'react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import { pathMotion, phaseOf, saysReplied } from './activity-lines'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { arcPath, relativeBox, type Box, type Point } from './line-geometry'
import { laneOffsets, separateLabels } from './line-route'
import { useComets } from './use-comets'
import { useOverlayMeasure } from './use-overlay-measure'

/**
 * The global view's static peer arcs (spec 2026-11-05-live-activity-view, "Global view"): one
 * dashed arc above the pills for each open peer request inside one panel, with the age label.
 * Measured from the laid-out pills of this panel's strip (the overlay's parent), so an arc never
 * leaves its panel. Below `md` the arcs hide and the sender pill names its peer instead. The arcs
 * move as the project view's lines do: open dashes march, comets travel, a closed arc fades.
 */

/** The size an age label takes, for placing labels clear of the pills and of each other. */
export const ARC_LABEL = { w: 104, h: 20 }

export interface ArcShape {
  requestId: string
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

/** Every arc whose two pills are in the host. */
export function measureArcs(host: HTMLElement, arcs: readonly ActivityRequest[]): ArcShape[] {
  const pills = pillBoxes(host)
  const all = [...pills.values()]
  const lanes = laneOffsets(arcs)
  const shapes: ArcShape[] = []
  for (const request of arcs) {
    const from = pills.get(request.senderRunId)
    const to = pills.get(request.recipientRunId)
    if (from && to) shapes.push({ requestId: request.requestId, ...arcPath(from, to, all, lanes.get(request.requestId)) })
  }
  // Labels sit above a row or in a row gap: moving one sideways keeps it off the pills.
  const labels = separateLabels(shapes.map((shape) => ({ id: shape.requestId, at: shape.label })), ARC_LABEL, 'x')
  return shapes.map((shape) => ({ ...shape, label: labels.get(shape.requestId) ?? shape.label }))
}

export function sameArcs(a: readonly ArcShape[], b: readonly ArcShape[]): boolean {
  return a.length === b.length && a.every((arc, i) => arc.requestId === b[i]?.requestId && arc.d === b[i]?.d && arc.label.x === b[i]?.label.x && arc.label.y === b[i]?.label.y)
}

interface ArcsProps {
  arcs: readonly ActivityRequest[]
  layoutKey: string
  now: number
  motion?: MotionState
  paused?: boolean
}

function ArcLabel({ arc, request, now, motion }: { arc: ArcShape; request: ActivityRequest; now: number; motion: MotionState }) {
  const replied = saysReplied(motion, arc.requestId)
  return (
    <span
      data-slot="activity-arc-label"
      data-request={arc.requestId}
      aria-hidden="true"
      style={{ left: arc.label.x, top: arc.label.y }}
      className={cn(
        'pointer-events-none absolute z-[4] -translate-x-1/2 -translate-y-1/2 rounded-md border bg-background px-1.5 py-px text-[10.5px] whitespace-nowrap text-foreground tabular-nums max-md:hidden',
        replied ? 'border-success' : 'border-message-peer-accent',
        phaseOf(motion, arc.requestId) === 'fade' && 'activity-line-out',
      )}
    >
      {replied ? <span className="font-semibold text-success">Replied</span> : <span className="font-semibold text-message-peer-accent">Request</span>} · {counter(since(request.createdAt, now))}
    </span>
  )
}

export function ActivityArcs({ arcs, layoutKey, now, motion = EMPTY_MOTION, paused = false }: ArcsProps) {
  const overlayRef = React.useRef<SVGSVGElement>(null)
  const measure = React.useCallback((host: HTMLElement) => measureArcs(host, arcs), [arcs])
  const shapes = useOverlayMeasure(overlayRef, measure, sameArcs, '[data-activity-pill]', layoutKey)
  const drawn = React.useMemo(() => new Set(shapes.map((arc) => arc.requestId)), [shapes])
  const cometLayer = useComets(motion.comets, drawn, paused)
  const byId = new Map(arcs.map((request) => [request.requestId, request]))
  // One overlay per panel: each needs its own marker id.
  const marker = `activity-arrow-arc-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <>
      <svg ref={overlayRef} data-slot="activity-arcs" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3] size-full overflow-visible max-md:hidden">
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 10 5 0 10z" className="fill-message-peer-accent" />
          </marker>
        </defs>
        {shapes.map((arc) => {
          const phase = phaseOf(motion, arc.requestId)
          return (
            <path
              key={arc.requestId}
              data-request={arc.requestId}
              data-kind="peer"
              data-phase={phase}
              d={arc.d}
              fill="none"
              strokeDasharray={phase === 'replied' ? undefined : '6 5'}
              strokeWidth={2}
              markerEnd={`url(#${marker})`}
              className={cn('stroke-message-peer-accent', pathMotion(phase, arc.requestId in motion.opening))}
            />
          )
        })}
        <g ref={cometLayer} data-slot="activity-comets" />
      </svg>
      {shapes.map((arc) => {
        const request = byId.get(arc.requestId)
        return request ? <ArcLabel key={arc.requestId} arc={arc} request={request} now={now} motion={motion} /> : null
      })}
    </>
  )
}
