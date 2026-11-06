import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { recipientName, senderName, type RunEntry } from './activity-model'
import { COLUMN_GAP } from './layout'
import { clampInto, facingSide, familyPath, peerPath, relativeBox, stubPath, type Box, type Point } from './line-geometry'
import { laneOffsets, separateLabels, type Rect } from './line-route'
import { endsOnScreen, isOnScreen } from './line-viewport'

/** The size a peer label takes: two compact lines and the window bar, narrow enough for the
 *  96 px column gap with room on both sides, so a label never covers a card. */
export const PEER_LABEL = { w: COLUMN_GAP - 8, h: 40 }

/** Where the graph is and what of it is on screen. */
export interface GraphFrame {
  /** The host's width: the last column has no gap on its right. */
  width: number
  /** The visible part of the host, relative to it. Absent: everything is on screen. */
  view?: Rect
}

/** One drawn line: an open request between two rows or cards on the graph. */
export interface LineShape {
  requestId: string
  kind: 'peer' | 'family'
  d: string
  label: Point
  /** A stub: the name of the task at the end that is not on the view. */
  away?: string
}

/** The graph marks each card `data-activity-card` and each status shape `data-activity-anchor`. */
function boxes(host: HTMLElement, attribute: string): Map<string, Box> {
  const origin = host.getBoundingClientRect()
  const out = new Map<string, Box>()
  for (const el of host.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    const id = el.getAttribute(attribute)
    if (id) out.set(id, relativeBox(el.getBoundingClientRect(), origin))
  }
  return out
}

function peerLine(request: ActivityRequest, cards: ReadonlyMap<string, Box>, index: ReadonlyMap<string, RunEntry>, lane: number | undefined, frame: GraphFrame): LineShape | undefined {
  const from = cards.get(request.senderRunId)
  const to = cards.get(request.recipientRunId)
  const base = { requestId: request.requestId, kind: 'peer' as const }
  const view = frame.view ?? { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }
  const end = (card: Box, other: Box | undefined) => ({ side: facingSide(card, other, frame.width), labelHeight: PEER_LABEL.h, lane: lane ?? 0, view, ...(other ? { other } : {}) })
  switch (endsOnScreen(from, to, view)) {
    case 'both': return from && to ? { ...base, ...peerPath(from, to, [...cards.values()], lane, facingSide(from, undefined, frame.width)) } : undefined
    case 'sender': return from ? { ...base, ...stubPath(from, 'sender', end(from, to)), away: recipientName(index, request) } : undefined
    case 'recipient': return to ? { ...base, ...stubPath(to, 'recipient', end(to, from)), away: senderName(index, request) } : undefined
    case 'none': return undefined
  }
}

/** The centres of the column gaps: a label centred on one fits between the cards. */
function gapCentres(cards: ReadonlyMap<string, Box>, width: number): number[] {
  const rights = new Set([...cards.values()].map((card) => Math.round(card.x + card.w)))
  return [...rights].filter((right) => right + COLUMN_GAP <= width + 1).map((right) => right + COLUMN_GAP / 2)
}

/** Move a peer label sideways to the centre of its nearest column gap. */
export function fitLabel(label: Point, gaps: readonly number[]): Point {
  if (gaps.length === 0) return label
  const x = gaps.reduce((best, gap) => (Math.abs(gap - label.x) < Math.abs(best - label.x) ? gap : best))
  return { x, y: label.y }
}

function familyLine(request: ActivityRequest, cards: ReadonlyMap<string, Box>, anchors: ReadonlyMap<string, Box>, index: ReadonlyMap<string, RunEntry>, lane: number | undefined, view: Rect | undefined): LineShape | undefined {
  const cardId = index.get(request.senderRunId)?.cardId ?? index.get(request.recipientRunId)?.cardId
  const card = cardId === undefined ? undefined : cards.get(cardId)
  const from = anchors.get(request.senderRunId)
  const to = anchors.get(request.recipientRunId)
  // Both ends sit in one card: off screen, neither end is on screen.
  if (!card || !from || !to || (view && !isOnScreen(card, view))) return undefined
  return { requestId: request.requestId, kind: 'family', ...familyPath(from, to, card, lane) }
}

/**
 * Measure every line from the laid-out graph. Peer lines are left out in the one-column layout,
 * where the sender card carries a "→ <task>" link instead. A family line needs both rows drawn.
 * A peer line follows the "Many lines" rule against `frame.view`.
 */
export function measureLines(
  host: HTMLElement,
  requests: readonly ActivityRequest[],
  index: ReadonlyMap<string, RunEntry>,
  { peers, frame = { width: host.clientWidth } }: { peers: boolean; frame?: GraphFrame },
): LineShape[] {
  const cards = boxes(host, 'data-activity-card')
  const anchors = boxes(host, 'data-activity-anchor')
  const lanes = laneOffsets(requests)
  const lines: LineShape[] = []
  for (const request of requests) {
    const lane = lanes.get(request.requestId)
    const line = request.relationship === 'peer'
      ? (peers ? peerLine(request, cards, index, lane, frame) : undefined)
      : familyLine(request, cards, anchors, index, lane, frame.view)
    if (line) lines.push(line)
  }
  // Only peer lines carry a label. Each sits in a column gap: moving one down keeps it there.
  const gaps = gapCentres(cards, frame.width)
  const peerLabels = lines.filter((line) => line.kind === 'peer').map((line) => ({ id: line.requestId, at: fitLabel(line.label, gaps) }))
  const labels = separateLabels(peerLabels, PEER_LABEL, 'y')
  return lines.map((line) => ({ ...line, label: insideView(labels.get(line.requestId) ?? line.label, frame.view) }))
}

/** A label kept inside the visible part of the graph, so a label pushed past another never
 *  leaves the screen. */
function insideView(label: Point, view: Rect | undefined): Point {
  if (!view) return label
  const half = PEER_LABEL.h / 2
  return { x: label.x, y: clampInto(label.y, view.y0 + half, view.y1 - half) }
}

/** Equal line sets draw the same picture; the measure skips a state update for them. */
export function sameLines(a: readonly LineShape[], b: readonly LineShape[]): boolean {
  return a.length === b.length && a.every((line, i) => {
    const other = b[i]
    return other !== undefined && line.requestId === other.requestId && line.d === other.d && line.away === other.away && line.label.x === other.label.x && line.label.y === other.label.y
  })
}
