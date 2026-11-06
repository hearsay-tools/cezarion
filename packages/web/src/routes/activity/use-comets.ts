import * as React from 'react'

import { MOTION_MS, type MotionState } from './activity-motion'
import { createCometLoop, drawComets, type CometLoop } from './comet-loop'

const frame = (callback: (time: number) => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : (setTimeout(() => callback(performance.now()), 16) as unknown as number)
const cancel = (handle: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle))

/**
 * The comets of one line overlay. It launches each comet of the motion state once, as soon as
 * its line is drawn (`drawn` holds the drawn request ids), and stops the loop on a hidden tab.
 * Returns the ref of the `<g>` the comets are drawn in; React renders that group empty.
 */
export function useComets(comets: MotionState['comets'], drawn: ReadonlySet<string>, paused: boolean): React.RefObject<SVGGElement | null> {
  const layerRef = React.useRef<SVGGElement>(null)
  const loop = React.useRef<CometLoop | undefined>(undefined)
  const launched = React.useRef(new Set<string>())
  React.useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const created = createCometLoop({ frame, cancel, draw: (flights, time) => drawComets(layer, flights, time) })
    loop.current = created
    return () => {
      created.stop()
      loop.current = undefined
    }
  }, [])
  React.useEffect(() => {
    if (paused) {
      loop.current?.stop()
      return
    }
    for (const id of launched.current) if (!(id in comets)) launched.current.delete(id)
    for (const [id, comet] of Object.entries(comets)) {
      if (launched.current.has(id) || !drawn.has(comet.requestId)) continue
      launched.current.add(id)
      loop.current?.launch({ id, requestId: comet.requestId, reverse: comet.reverse, tone: comet.tone, duration: MOTION_MS.comet })
    }
  }, [comets, drawn, paused])
  return layerRef
}
