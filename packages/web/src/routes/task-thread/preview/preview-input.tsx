import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

import type { PreviewClientMessage } from '@open-mercato/cezar-api-client'

import { createPointerState, keyToMessage, pasteToMessage, pointerToMessages, wheelToMessage, type PointerLike } from './input-map'

/**
 * The input layer over the preview canvas (#781): a focusable box in the surface's own CSS box
 * that turns pointer, wheel, key and paste events into client messages through `input-map`.
 * It is mounted only while the page can take input; the pane unmounts it behind a state overlay
 * or a page dialog, and what the owner types then goes nowhere.
 */

const asPointer = (event: PointerEvent): PointerLike => event as PointerEvent & { type: PointerLike['type'] }

/** The page's keyboard exit: every other key, Tab and Escape included, belongs to the page. */
const isLeaveKey = (event: ReactKeyboardEvent) => event.key === 'Escape' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey

export function PreviewInput({ scale, send, onLeave }: {
  scale: number
  send: (message: PreviewClientMessage) => void
  /** Shift+Esc: hand the keyboard back to the cockpit. Without it the layer only blurs. */
  onLeave?: () => void
}) {
  const layer = useRef<HTMLDivElement>(null)
  const state = useRef(createPointerState({ left: 0, top: 0 }, scale))
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const sendRef = useRef(send)
  sendRef.current = send
  /** The newest mouse move, held until the next frame: one move per frame is all the page can use. */
  const pendingMove = useRef<{ event: PointerEvent; frame: number } | undefined>(undefined)

  const measure = () => {
    const element = layer.current
    if (element) state.current.rect = element.getBoundingClientRect()
    state.current.scale = scaleRef.current
  }

  const run = (event: PointerEvent) => {
    measure()
    for (const message of pointerToMessages(asPointer(event), state.current)) sendRef.current(message)
  }

  const flushMove = () => {
    const pending = pendingMove.current
    if (!pending) return
    pendingMove.current = undefined
    cancelAnimationFrame(pending.frame)
    run(pending.event)
  }

  useEffect(() => () => {
    if (pendingMove.current) cancelAnimationFrame(pendingMove.current.frame)
  }, [])

  // Take the keyboard when nothing else has it, so typing right after a page opens reaches the page.
  useEffect(() => {
    if (document.activeElement === document.body) layer.current?.focus({ preventScroll: true })
  }, [])

  // A React wheel handler is passive, and the page, not the cockpit, should scroll.
  useEffect(() => {
    const element = layer.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      measure()
      sendRef.current(wheelToMessage(event, state.current.rect, state.current.scale))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // The paste event carries the text (Ctrl/Cmd+V itself is not sent as a key).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (document.activeElement !== layer.current) return
      const message = pasteToMessage(event.clipboardData?.getData('text') ?? '')
      if (!message) return
      event.preventDefault()
      sendRef.current(message)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  const onPointerDown = (event: ReactPointerEvent) => {
    flushMove()
    layer.current?.focus({ preventScroll: true })
    // A drag that leaves the page must still end on it: the release has to reach the page.
    try { layer.current?.setPointerCapture(event.pointerId) } catch { /* a synthetic or ended pointer */ }
    run(event.nativeEvent)
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    const native = event.nativeEvent
    if (native.pointerType === 'touch') return run(native)
    const pending = pendingMove.current
    if (pending) {
      pending.event = native
      return
    }
    pendingMove.current = {
      event: native,
      frame: requestAnimationFrame(() => {
        const queued = pendingMove.current
        pendingMove.current = undefined
        if (queued) run(queued.event)
      }),
    }
  }

  const onPointerEnd = (event: ReactPointerEvent) => {
    flushMove()
    run(event.nativeEvent)
  }

  const onKey = (event: ReactKeyboardEvent) => {
    if (isLeaveKey(event)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'keydown') {
        if (onLeave) onLeave()
        else layer.current?.blur()
      }
      return
    }
    const message = keyToMessage(event.nativeEvent)
    if (!message) return
    event.preventDefault()
    // Whatever the page receives is not the cockpit's: its bare-key and Alt shortcuts listen on
    // `window` and would fire on the same keystroke (`c` opens a new task, Alt+A approves).
    event.stopPropagation()
    send(message)
  }

  return (
    <div
      ref={layer}
      data-slot="preview-input"
      role="application"
      aria-label="Page preview, interactive"
      aria-description="Keys go to the page, Tab included. Press Shift+Escape to return to the cockpit."
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={onKey}
      onKeyUp={onKey}
      className="absolute inset-0 touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
    />
  )
}
