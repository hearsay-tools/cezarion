import * as React from 'react'

/**
 * FLIP for the activity graph (spec 2026-11-05-live-activity-view, "Other motion"): when a card
 * leaves, the cards below it move up with a transform from where they were, never a jump. It
 * reads the cards' places after each commit and, when the placement changed, plays each moved
 * card from its old place to its new one. Transform only.
 */

export interface Place {
  x: number
  y: number
}

/** How far each card moved between two layouts; cards that moved less than a pixel, came or went
 *  are left out. */
export function flipDeltas(before: ReadonlyMap<string, Place>, after: ReadonlyMap<string, Place>): Map<string, Place> {
  const out = new Map<string, Place>()
  for (const [id, now] of after) {
    const was = before.get(id)
    if (!was) continue
    const delta = { x: was.x - now.x, y: was.y - now.y }
    if (Math.abs(delta.x) >= 1 || Math.abs(delta.y) >= 1) out.set(id, delta)
  }
  return out
}

export const FLIP_MS = 400

function places(host: HTMLElement, attribute: string): Map<string, { el: HTMLElement; at: Place }> {
  const out = new Map<string, { el: HTMLElement; at: Place }>()
  for (const el of host.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    const rect = el.getBoundingClientRect()
    out.set(el.getAttribute(attribute) ?? '', { el, at: { x: rect.left, y: rect.top } })
  }
  return out
}

/** Play FLIP on the host's `[attribute]` elements whenever `layoutKey` changes; `enabled` false
 *  (reduced motion, a hidden tab) moves them at once. */
export function useFlip(hostRef: React.RefObject<HTMLElement | null>, attribute: string, layoutKey: string, enabled: boolean) {
  const last = React.useRef<{ key: string; at: Map<string, Place> } | undefined>(undefined)
  React.useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const now = places(host, attribute)
    const at = new Map([...now].map(([id, place]) => [id, place.at]))
    const before = last.current
    last.current = { key: layoutKey, at }
    if (!enabled || !before || before.key === layoutKey) return
    for (const [id, delta] of flipDeltas(before.at, at)) {
      now.get(id)?.el.animate?.([{ transform: `translate(${delta.x}px, ${delta.y}px)` }, { transform: 'none' }], { duration: FLIP_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
    }
  })
}
