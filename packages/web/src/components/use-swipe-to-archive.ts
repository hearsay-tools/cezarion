import * as React from 'react'

/**
 * Swipe a finished sidebar row left to archive it (#780 §7), on touch and in the mobile shell —
 * where there is no hover to reveal the row button. Pointer events only, no dependency.
 *
 *  - The surface is `touch-action: pan-y`, so the browser keeps vertical panning. The row stays
 *    still until the finger has travelled AXIS_LOCK_PX; a mostly vertical first move locks the
 *    gesture vertical for good, so a scroll that starts on a row never moves it.
 *  - Released past PARK_PX the row parks open on the ACTION_PX action; past COMMIT_RATIO of its
 *    width (or on a leftward fling) it archives on release.
 *  - One row is open at a time (a module store). Opening another, a scroll anywhere, or a
 *    pointerdown outside the open row closes it.
 *  - The click that ends a drag, or the tap that closes an open row, is swallowed in the capture
 *    phase, so the row's link does not navigate.
 */

export const AXIS_LOCK_PX = 10
export const PARK_PX = 40
export const ACTION_PX = 88
export const COMMIT_RATIO = 0.6
export const SNAP_MS = 200
/** 1px/ms: a deliberate short swipe (~0.6px/ms) parks; only a real flick archives. */
export const FLING_PX_PER_MS = 1
/** How long a gesture's click swallow outlives it. A touch tap's click lands within a frame or
 *  two of the pointerup; anything later (a screen reader's activation, a keyboard Enter after a
 *  drag that produced no click at all) is not part of the gesture. */
const SUPPRESS_CLICK_MS = 300
/** The window a release velocity is measured over. */
const FLING_WINDOW_MS = 100

export type SwipePhase = 'idle' | 'dragging' | 'open' | 'committing'

type SwipeState = { offset: number; phase: SwipePhase; past: boolean }
const IDLE: SwipeState = { offset: 0, phase: 'idle', past: false }

/** The one row that is dragging or open, and how to close it. */
let current: { id: string; close: () => void } | null = null

function claim(id: string, close: () => void) {
  if (current && current.id !== id) current.close()
  current = { id, close }
}

function release(id: string) {
  if (current?.id === id) current = null
}

/** Tests only: forget the open row between cases. */
export function resetSwipeStore() {
  current = null
}

function vibrate() {
  // iOS Safari has no `navigator.vibrate`; where it exists it may still refuse (no user gesture).
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(10)
  } catch {
    // A haptic is decoration.
  }
}

type Gesture = {
  pointerId: number
  x0: number
  y0: number
  base: number
  width: number
  axis: 'x' | 'y' | null
  wasOpen: boolean
  samples: Array<{ x: number; t: number }>
}

export function useSwipeToArchive({
  id,
  enabled,
  onArchive,
}: {
  id: string
  enabled: boolean
  /** Resolving to `false` (or rejecting) means the archive did not happen: the row snaps back. */
  onArchive: () => void | Promise<unknown>
}) {
  const [state, setState] = React.useState<SwipeState>(IDLE)
  const surfaceRef = React.useRef<HTMLDivElement | null>(null)
  const gesture = React.useRef<Gesture | null>(null)
  const pastRef = React.useRef(false)
  const suppressClick = React.useRef(false)
  const suppressTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Swallow the click this gesture ends with, for SUPPRESS_CLICK_MS at most. */
  const swallowNextClick = () => {
    suppressClick.current = true
    clearTimeout(suppressTimer.current)
    suppressTimer.current = undefined
  }
  const lapseSwallow = () => {
    if (!suppressClick.current) return
    clearTimeout(suppressTimer.current)
    suppressTimer.current = setTimeout(() => {
      suppressClick.current = false
    }, SUPPRESS_CLICK_MS)
  }
  React.useEffect(() => () => clearTimeout(suppressTimer.current), [])
  const stateRef = React.useRef(state)
  stateRef.current = state
  const onArchiveRef = React.useRef(onArchive)
  onArchiveRef.current = onArchive

  const close = React.useCallback(() => {
    gesture.current = null
    pastRef.current = false
    release(id)
    setState(IDLE)
  }, [id])

  // A row that stops being swipeable (it was archived, it started running again) lets go.
  React.useEffect(() => {
    if (!enabled && stateRef.current.phase !== 'committing') close()
  }, [enabled, close])
  React.useEffect(() => () => release(id), [id])

  // While open: any scroll, or a pointerdown outside this row, closes it.
  const open = state.phase === 'open'
  React.useEffect(() => {
    if (!open) return
    const onScroll = () => close()
    const onPointerDown = (event: PointerEvent) => {
      const surface = surfaceRef.current
      if (surface && event.target instanceof Node && surface.contains(event.target)) return
      close()
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, close])

  const commit = (width: number) => {
    release(id)
    setState({ offset: -width, phase: 'committing', past: true })
    const settle = (archived: unknown) => {
      if (archived === false) close()
    }
    try {
      const result = onArchiveRef.current()
      if (result && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(settle, close)
    } catch {
      close()
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    // A fresh press: whatever the last gesture meant to swallow, it is over.
    suppressClick.current = false
    if (!enabled || stateRef.current.phase === 'committing') return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const box = (surfaceRef.current ?? event.currentTarget).getBoundingClientRect()
    gesture.current = {
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      base: stateRef.current.phase === 'open' ? -ACTION_PX : 0,
      width: box.width > 0 ? box.width : 320,
      axis: null,
      wasOpen: stateRef.current.phase === 'open',
      samples: [{ x: event.clientX, t: Date.now() }],
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || event.pointerId !== g.pointerId) return
    const dx = event.clientX - g.x0
    const dy = event.clientY - g.y0
    if (g.axis === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (g.axis === 'y') return
      // Horizontal from here on: keep the moves even when the finger leaves the row, take the
      // one-open-row slot (closing any other), and swallow the click this drag ends with.
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      } catch {
        // An already-released pointer: the moves still arrive while the finger is on the row.
      }
      claim(id, close)
      swallowNextClick()
    }
    if (g.axis !== 'x') return
    const offset = Math.min(0, Math.max(-g.width, g.base + dx))
    const past = -offset >= COMMIT_RATIO * g.width
    if (past && !pastRef.current) vibrate()
    pastRef.current = past
    g.samples.push({ x: event.clientX, t: Date.now() })
    if (g.samples.length > 8) g.samples.shift()
    setState({ offset, phase: 'dragging', past })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || event.pointerId !== g.pointerId) return
    gesture.current = null
    if (g.axis !== 'x') {
      // A tap on an open row closes it, and is not a tap on its link.
      if (g.axis === null && g.wasOpen) {
        swallowNextClick()
        lapseSwallow()
        close()
      }
      return
    }
    lapseSwallow()
    const offset = stateRef.current.offset
    const now = Date.now()
    const last = { x: event.clientX, t: now }
    // The speed over the last FLING_WINDOW_MS; a finger that sat still longer than that is not
    // flinging, whatever its final move was.
    const from = g.samples.find((sample) => now - sample.t <= FLING_WINDOW_MS && sample.t < now)
    const velocity = from ? (last.x - from.x) / (last.t - from.t) : 0
    pastRef.current = false
    if (stateRef.current.past || (velocity <= -FLING_PX_PER_MS && -offset >= PARK_PX)) {
      commit(g.width)
    } else if (velocity < FLING_PX_PER_MS && -offset >= PARK_PX) {
      claim(id, close)
      setState({ offset: -ACTION_PX, phase: 'open', past: false })
    } else {
      close()
    }
  }

  const onPointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || event.pointerId !== g.pointerId) return
    gesture.current = null
    lapseSwallow()
    if (g.axis === 'x') close()
  }

  // A keyboard activation is never the end of a pointer gesture.
  const onKeyDownCapture = () => {
    suppressClick.current = false
  }

  const onClickCapture = (event: React.MouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  return {
    offset: state.offset,
    phase: state.phase,
    past: state.past,
    surfaceRef,
    bind: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onKeyDownCapture },
    close,
  }
}
