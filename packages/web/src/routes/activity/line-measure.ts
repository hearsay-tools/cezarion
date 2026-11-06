import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { recipientName, senderName, type RunEntry } from './activity-model'
import { familyPath, peerPath, relativeBox, stubPath, type Box, type Point } from './line-geometry'
import { laneOffsets, separateLabels } from './line-route'

/** The size a peer label takes (two lines and the window bar), for keeping labels apart. */
export const PEER_LABEL = { w: 190, h: 50 }

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

function peerLine(request: ActivityRequest, cards: ReadonlyMap<string, Box>, index: ReadonlyMap<string, RunEntry>, lane: number | undefined): LineShape | undefined {
  const from = cards.get(request.senderRunId)
  const to = cards.get(request.recipientRunId)
  const base = { requestId: request.requestId, kind: 'peer' as const }
  if (from && to) return { ...base, ...peerPath(from, to, [...cards.values()], lane) }
  if (from) return { ...base, ...stubPath(from, 'sender', lane), away: recipientName(index, request) }
  if (to) return { ...base, ...stubPath(to, 'recipient', lane), away: senderName(index, request) }
  return undefined
}

function familyLine(request: ActivityRequest, cards: ReadonlyMap<string, Box>, anchors: ReadonlyMap<string, Box>, index: ReadonlyMap<string, RunEntry>, lane: number | undefined): LineShape | undefined {
  const cardId = index.get(request.senderRunId)?.cardId ?? index.get(request.recipientRunId)?.cardId
  const card = cardId === undefined ? undefined : cards.get(cardId)
  const from = anchors.get(request.senderRunId)
  const to = anchors.get(request.recipientRunId)
  if (!card || !from || !to) return undefined
  return { requestId: request.requestId, kind: 'family', ...familyPath(from, to, card, lane) }
}

/**
 * Measure every line from the laid-out graph. Peer lines are left out in the one-column layout,
 * where the sender card carries a "→ <task>" link instead. A family line needs both rows drawn.
 */
export function measureLines(
  host: HTMLElement,
  requests: readonly ActivityRequest[],
  index: ReadonlyMap<string, RunEntry>,
  { peers }: { peers: boolean },
): LineShape[] {
  const cards = boxes(host, 'data-activity-card')
  const anchors = boxes(host, 'data-activity-anchor')
  const lanes = laneOffsets(requests)
  const lines: LineShape[] = []
  for (const request of requests) {
    const lane = lanes.get(request.requestId)
    const line = request.relationship === 'peer'
      ? (peers ? peerLine(request, cards, index, lane) : undefined)
      : familyLine(request, cards, anchors, index, lane)
    if (line) lines.push(line)
  }
  // Only peer lines carry a label. They sit in column gaps: moving one down keeps it in its gap.
  const labels = separateLabels(lines.filter((line) => line.kind === 'peer').map((line) => ({ id: line.requestId, at: line.label })), PEER_LABEL, 'y')
  return lines.map((line) => ({ ...line, label: labels.get(line.requestId) ?? line.label }))
}

/** Equal line sets draw the same picture; the measure skips a state update for them. */
export function sameLines(a: readonly LineShape[], b: readonly LineShape[]): boolean {
  return a.length === b.length && a.every((line, i) => {
    const other = b[i]
    return other !== undefined && line.requestId === other.requestId && line.d === other.d && line.away === other.away && line.label.x === other.label.x && line.label.y === other.label.y
  })
}
