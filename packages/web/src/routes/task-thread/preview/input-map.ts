import type { PreviewClientMessage } from '@open-mercato/cezar-api-client'

/**
 * Turns what the owner does on the preview canvas into the whitelisted client messages (#781).
 * Ported from the screencast prototype: CDP's own mouse and key vocabulary, plus the Chromium
 * editing commands headless needs for Ctrl/Cmd shortcuts. Every position divides by the display
 * `scale`, so a click on a fixed viewport shrunk to fit lands on the same page pixel.
 *
 * Nothing here touches the DOM: the functions take event-shaped values and return messages, and
 * the one piece of state (touch tracking, click counting) lives in a `PointerState` the caller owns.
 */

type Mouse = Extract<PreviewClientMessage, { t: 'mouse' }>
type Key = Extract<PreviewClientMessage, { t: 'key' }>

/** A touch that moves less than this (page-independent CSS pixels) and ends quickly is a tap. */
const TAP_SLOP_PX = 10
const TAP_MAX_MS = 500
/** Presses this close in time and place count as one multi-click. */
const MULTI_CLICK_MS = 500
const MULTI_CLICK_SLOP_PX = 4
/** One wheel "line" in pixels, as the prototype counted it. */
const LINE_PX = 16

export interface Origin {
  left: number
  top: number
}

interface Modifiers {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiers = (e: Modifiers): number => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

/** Client coordinates to a page pixel. `rect` is the layer over the canvas, in its CSS (scaled) box. */
export function toPagePoint(clientX: number, clientY: number, rect: Origin, scale: number): { x: number; y: number } {
  return { x: Math.round((clientX - rect.left) / scale), y: Math.round((clientY - rect.top) / scale) }
}

// ---- pointer ----------------------------------------------------------------------------------

export interface PointerLike extends Modifiers {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel'
  pointerId: number
  pointerType: string
  clientX: number
  clientY: number
  button: number
  buttons: number
  /** Chromium reports 0 here for pointer events, so clicks are counted from the presses. */
  detail?: number
  timeStamp: number
}

interface TouchTrack {
  startX: number
  startY: number
  startAt: number
  lastX: number
  lastY: number
  scrolling: boolean
}

export interface PointerState {
  /** The layer's box and the display scale now; the caller refreshes both before each event. */
  rect: Origin
  scale: number
  touches: Map<number, TouchTrack>
  /** A second finger came down: the gesture is a pinch or a two-finger scroll, and v1 ignores it. */
  multiTouch: boolean
  click: { at: number; x: number; y: number; button: number; count: number }
}

export function createPointerState(rect: Origin, scale: number): PointerState {
  return { rect, scale, touches: new Map(), multiTouch: false, click: { at: Number.NEGATIVE_INFINITY, x: 0, y: 0, button: -1, count: 1 } }
}

const BUTTONS = ['left', 'middle', 'right'] as const

function mouse(type: Mouse['type'], state: PointerState, e: PointerLike, extra: Partial<Mouse>): Mouse {
  const point = toPagePoint(e.clientX, e.clientY, state.rect, state.scale)
  return {
    t: 'mouse',
    type,
    x: point.x,
    y: point.y,
    button: BUTTONS[e.button] ?? 'none',
    buttons: e.buttons,
    clickCount: 1,
    modifiers: modifiers(e),
    ...extra,
  }
}

const negate = (value: number): number => (value === 0 ? 0 : -value)

function wheel(state: PointerState, clientX: number, clientY: number, dx: number, dy: number): Mouse {
  const point = toPagePoint(clientX, clientY, state.rect, state.scale)
  // Dragging the page by N CSS pixels moves it N pixels on screen: N / scale page pixels.
  return { t: 'mouse', type: 'mouseWheel', x: point.x, y: point.y, button: 'none', buttons: 0, deltaX: negate(dx / state.scale), deltaY: negate(dy / state.scale), modifiers: 0 }
}

function touchToMessages(e: PointerLike, state: PointerState): PreviewClientMessage[] {
  const { touches } = state
  const track = touches.get(e.pointerId)
  const finish = () => {
    touches.delete(e.pointerId)
    if (touches.size === 0) state.multiTouch = false
  }

  switch (e.type) {
    case 'pointerdown':
      touches.set(e.pointerId, { startX: e.clientX, startY: e.clientY, startAt: e.timeStamp, lastX: e.clientX, lastY: e.clientY, scrolling: false })
      if (touches.size > 1) state.multiTouch = true
      return []
    case 'pointermove': {
      if (!track) return []
      if (state.multiTouch) {
        track.lastX = e.clientX
        track.lastY = e.clientY
        return []
      }
      if (!track.scrolling) {
        if (Math.hypot(e.clientX - track.startX, e.clientY - track.startY) <= TAP_SLOP_PX) return []
        // Past the slop it is a scroll, and it starts from where the finger went down.
        track.scrolling = true
      }
      const dx = e.clientX - track.lastX
      const dy = e.clientY - track.lastY
      track.lastX = e.clientX
      track.lastY = e.clientY
      return dx === 0 && dy === 0 ? [] : [wheel(state, e.clientX, e.clientY, dx, dy)]
    }
    case 'pointerup': {
      const tap = track !== undefined && !state.multiTouch && !track.scrolling && e.timeStamp - track.startAt <= TAP_MAX_MS
      finish()
      if (!tap || !track) return []
      const at = { ...e, clientX: track.startX, clientY: track.startY }
      return [
        mouse('mouseMoved', state, at, { button: 'none', buttons: 0 }),
        mouse('mousePressed', state, at, { button: 'left', buttons: 1 }),
        mouse('mouseReleased', state, at, { button: 'left', buttons: 0 }),
      ]
    }
    case 'pointercancel':
      finish()
      return []
  }
}

/**
 * Mouse and pen forward as the prototype did (press, move, release, with the held buttons). Touch
 * is read as gestures: a short, still touch is a click; a drag scrolls the page; a long press or a
 * second finger does nothing in v1.
 */
export function pointerToMessages(e: PointerLike, state: PointerState): PreviewClientMessage[] {
  if (e.pointerType === 'touch') return touchToMessages(e, state)
  switch (e.type) {
    case 'pointerdown': {
      const previous = state.click
      const again =
        previous.button === e.button &&
        e.timeStamp - previous.at <= MULTI_CLICK_MS &&
        Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= MULTI_CLICK_SLOP_PX
      state.click = { at: e.timeStamp, x: e.clientX, y: e.clientY, button: e.button, count: again ? previous.count + 1 : 1 }
      return [mouse('mousePressed', state, e, { clickCount: state.click.count })]
    }
    case 'pointermove':
      return [mouse('mouseMoved', state, e, { button: e.buttons & 1 ? 'left' : 'none' })]
    case 'pointerup':
      return [mouse('mouseReleased', state, e, { clickCount: state.click.count })]
    case 'pointercancel':
      return []
  }
}

// ---- wheel ------------------------------------------------------------------------------------

export interface WheelLike extends Modifiers {
  clientX: number
  clientY: number
  deltaX: number
  deltaY: number
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number
  buttons?: number
}

export function wheelToMessage(e: WheelLike, rect: Origin, scale: number): PreviewClientMessage {
  const point = toPagePoint(e.clientX, e.clientY, rect, scale)
  const lines = e.deltaMode === 1 ? LINE_PX : 1
  return {
    t: 'mouse',
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: e.buttons ?? 0,
    deltaX: (e.deltaX * lines) / scale,
    deltaY: (e.deltaY * lines) / scale,
    modifiers: modifiers(e),
  }
}

// ---- keyboard ---------------------------------------------------------------------------------

export interface KeyLike extends Modifiers {
  type: string
  key: string
  code: string
  keyCode: number
  getModifierState?: (key: string) => boolean
}

/** Chromium needs editing commands for the shortcuts to act in a headless page. */
const COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo', y: 'redo' }

/**
 * `undefined` means "not the page's key": the caller must neither send nor `preventDefault`, so
 * the event keeps going. Ctrl/Cmd+V (the paste event sends the text) and Ctrl/Cmd+K (cezar's
 * command palette, registered for both) are such keys.
 */
export function keyToMessage(e: KeyLike): PreviewClientMessage | undefined {
  const k = e.key.toLowerCase()
  // Windows reports AltGr as Ctrl+Alt: a character typed that way is text, not a shortcut.
  const shortcut = (e.ctrlKey || e.metaKey) && !e.getModifierState?.('AltGraph')
  if (shortcut && (k === 'v' || k === 'k')) return undefined

  const base = { t: 'key', key: e.key, code: e.code, modifiers: modifiers(e), vk: e.keyCode } as const
  if (e.type === 'keyup') return { ...base, type: 'keyUp' }

  const text = shortcut ? '' : e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : e.key === 'Tab' ? '\t' : ''
  const command = shortcut ? (k === 'z' && e.shiftKey ? 'redo' : COMMANDS[k]) : undefined
  const message: Key = { t: 'key', type: text ? 'keyDown' : 'rawKeyDown', key: e.key, code: e.code, text, modifiers: modifiers(e), vk: e.keyCode }
  return command ? { ...message, commands: [command] } : message
}

/** The paste event carries the text; an empty clipboard sends nothing. */
export function pasteToMessage(text: string): PreviewClientMessage | undefined {
  return text ? { t: 'insertText', text } : undefined
}
