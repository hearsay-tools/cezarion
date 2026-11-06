import type { CometTone } from './activity-motion'

/**
 * Comets along the lines (spec 2026-11-05-live-activity-view, "Lines between tasks"): a bright
 * head with a short tail that travels a line from the sender to the recipient when a request
 * opens, and back in the success tone when the reply comes. A `requestAnimationFrame` loop moves
 * them; it runs only while a comet is in flight ("Performance"). Each frame moves the comet's
 * circles with `transform` only.
 */

export interface CometFlight {
  id: string
  requestId: string
  reverse: boolean
  tone: CometTone
  duration: number
}

/** A flight on the loop's clock: `start` is the first frame it was drawn in. */
export interface CometInFlight extends CometFlight {
  start?: number
}

export interface CometLoopDeps {
  frame: (callback: (time: number) => void) => number
  cancel: (handle: number) => void
  /** Draw these flights at `time`; an empty list clears every comet. */
  draw: (flights: readonly (CometInFlight & { start: number })[], time: number) => void
}

export interface CometLoop {
  launch: (flight: CometFlight) => void
  stop: () => void
  /** True while a frame is scheduled. */
  running: () => boolean
}

/** The loop. It schedules a frame only while a launched comet has not reached its end. */
export function createCometLoop({ frame, cancel, draw }: CometLoopDeps): CometLoop {
  let flights: CometInFlight[] = []
  let handle: number | undefined
  const tick = (time: number) => {
    handle = undefined
    const started = flights.map((flight) => ({ ...flight, start: flight.start ?? time }))
    flights = started.filter((flight) => time < flight.start + flight.duration)
    draw(flights as (CometInFlight & { start: number })[], time)
    if (flights.length > 0) handle = frame(tick)
  }
  return {
    launch(flight) {
      if (flights.some((other) => other.id === flight.id)) return
      flights.push(flight)
      if (handle === undefined) handle = frame(tick)
    },
    stop() {
      if (handle !== undefined) cancel(handle)
      handle = undefined
      flights = []
      draw([], 0)
    },
    running: () => handle !== undefined,
  }
}

/** Ease in and out: slow at both ends, as the prototype's comets move. */
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** How far along its line a comet is at `time`, 0 to 1. Its tail trails behind by `lag`. */
export function cometProgress(flight: { start: number; duration: number; reverse: boolean }, time: number, lag = 0): number {
  const raw = Math.min(1, Math.max(0, (time - flight.start) / flight.duration))
  const along = Math.max(0, easeInOut(raw) - lag)
  return flight.reverse ? 1 - along : along
}

const NS = 'http://www.w3.org/2000/svg'
/** The head, then the tail: each a smaller, fainter circle a little behind the one before. */
const TAIL = [0, 0.03, 0.06, 0.09, 0.12]
const RADIUS = [4.5, 3.5, 3, 2.5, 2]
const FILL: Record<CometTone, string> = {
  peer: 'fill-message-peer-accent',
  family: 'fill-message-inbound-accent',
  success: 'fill-success',
}

function cometGroup(layer: SVGGElement, flight: CometInFlight): SVGGElement {
  const found = layer.querySelector<SVGGElement>(`g[data-comet="${CSS.escape(flight.id)}"]`)
  if (found) return found
  const group = document.createElementNS(NS, 'g')
  group.setAttribute('data-comet', flight.id)
  const halo = document.createElementNS(NS, 'circle')
  halo.setAttribute('r', '9')
  halo.setAttribute('class', `${FILL[flight.tone]} opacity-35`)
  group.append(halo)
  TAIL.forEach((_, i) => {
    const dot = document.createElementNS(NS, 'circle')
    dot.setAttribute('r', String(RADIUS[i]))
    dot.setAttribute('class', i === 0 ? 'fill-foreground' : FILL[flight.tone])
    dot.setAttribute('opacity', String(1 - i * 0.15))
    group.append(dot)
  })
  layer.append(group)
  return group
}

/** The `draw` of a line overlay: one group of circles for each flight, moved along the path
 *  `path[data-request]` of the same overlay. A line SVG cannot measure in jsdom; it draws nothing. */
export function drawComets(layer: SVGGElement, flights: readonly (CometInFlight & { start: number })[], time: number) {
  const live = new Set(flights.map((flight) => flight.id))
  for (const group of layer.querySelectorAll('g[data-comet]')) if (!live.has(group.getAttribute('data-comet') ?? '')) group.remove()
  const svg = layer.ownerSVGElement
  for (const flight of flights) {
    const path = svg?.querySelector<SVGPathElement>(`path[data-request="${CSS.escape(flight.requestId)}"]`)
    if (!path || typeof path.getTotalLength !== 'function') continue
    const length = path.getTotalLength()
    const circles = cometGroup(layer, flight).querySelectorAll('circle')
    circles.forEach((circle, i) => {
      const point = path.getPointAtLength(cometProgress(flight, time, TAIL[Math.max(0, i - 1)]) * length)
      circle.setAttribute('transform', `translate(${point.x} ${point.y})`)
    })
  }
}
