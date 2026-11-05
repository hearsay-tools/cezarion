import * as React from 'react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import type { RunEntry } from './activity-model'
import { measureLines, sameLines, type LineShape } from './line-measure'
import { useOverlayMeasure } from './use-overlay-measure'

/**
 * The static lines between tasks (spec 2026-11-05-live-activity-view, "Lines between tasks"): an
 * SVG overlay over the graph (its parent element) and one HTML label per peer line. Geometry is
 * measured from the laid-out cards (`useOverlayMeasure`). Slice S6 adds the march and the comets.
 */

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

function PeerLabel({ line, request, now }: { line: LineShape; request: ActivityRequest; now: number }) {
  const used = windowUsed(request, now)
  return (
    <div
      data-slot="activity-line-label"
      data-request={request.requestId}
      aria-hidden="true"
      style={{ left: line.label.x, top: line.label.y }}
      className="pointer-events-none absolute z-[4] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-message-peer-accent bg-background px-2 py-[3px] text-center text-[10.5px] leading-[1.3] whitespace-nowrap text-foreground tabular-nums"
    >
      <span className="block font-semibold text-message-peer-accent">Request · {counter(since(request.createdAt, now))}</span>
      {line.away ?? shortText(request.text)}
      {used === undefined ? null : (
        <span className="mt-[3px] block h-[3px] overflow-hidden rounded-sm bg-border">
          <span className="block h-full bg-message-peer-accent" style={{ width: `${Math.round(used * 100)}%` }} />
        </span>
      )}
    </div>
  )
}

export function ActivityLines({
  requests,
  index,
  peers,
  layoutKey,
  now,
}: {
  requests: readonly ActivityRequest[]
  index: ReadonlyMap<string, RunEntry>
  /** False in the one-column layout: peer requests become links on the sender card. */
  peers: boolean
  /** Changes whenever the cards may have moved: a new placement or a new snapshot. */
  layoutKey: string
  now: number
}) {
  const overlayRef = React.useRef<SVGSVGElement>(null)
  const measure = React.useCallback((host: HTMLElement) => measureLines(host, requests, index, { peers }), [requests, index, peers])
  const lines = useOverlayMeasure(overlayRef, measure, sameLines, '[data-activity-card]', layoutKey)
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
        {lines.map((line) => (
          <path
            key={line.requestId}
            data-request={line.requestId}
            data-kind={line.kind}
            d={line.d}
            fill="none"
            strokeDasharray="6 5"
            strokeWidth={line.kind === 'peer' ? 2.2 : 1.8}
            markerEnd={`url(#activity-arrow-${line.kind})`}
            className={cn(line.kind === 'peer' ? 'stroke-message-peer-accent' : 'stroke-message-inbound-accent')}
          />
        ))}
      </svg>
      {lines.map((line) => {
        const request = byId.get(line.requestId)
        return line.kind === 'peer' && request ? <PeerLabel key={line.requestId} line={line} request={request} now={now} /> : null
      })}
    </>
  )
}
