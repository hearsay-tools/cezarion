import { useEffect, useRef, useState } from 'react'

/**
 * The iOS virtual-keyboard adapter (spec iOS checklist; tech research §7): Safari does NOT
 * resize the layout viewport when the keyboard opens, so a bottom-docked composer gets
 * covered. The fix is the `--kb` custom-property pattern — watch `visualViewport`, publish
 * the keyboard's overlap height as `--kb` on `:root`, and let the dock lift itself with
 * `bottom: var(--kb, 0px)`. `interactive-widget=resizes-content` in the viewport meta is the
 * progressive-enhancement layer above this; on engines that honor it the inset stays 0 and
 * this adapter is a no-op.
 *
 * Everything is written against structural stubs (`KeyboardWindow`), so tests drive keyboard
 * open/close without a real Safari.
 */

/** The subset of `VisualViewport` the math needs — stubbable. */
export interface KeyboardViewport {
  height: number
  scale?: number
  offsetTop: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

/** The subset of `window` the adapter reads. `visualViewport` is nullable per spec. */
export interface KeyboardWindow {
  innerHeight: number
  /** Baseline scope for the resizes-content check; absent in old stubs (treated as constant). */
  innerWidth?: number
  /** Where the focused element is read from (`window.document` in a browser). */
  document?: { activeElement: unknown }
  visualViewport: KeyboardViewport | null
}

/**
 * How many px of layout viewport the keyboard covers right now. The layout viewport keeps
 * `innerHeight`; the visual viewport shrinks to `height` and may pan down by `offsetTop` —
 * whatever remains below it is keyboard. Clamped at 0: URL-bar collapse can make the visual
 * viewport momentarily TALLER than `innerHeight`, which is not a keyboard.
 */
export function keyboardInset(win: KeyboardWindow): number {
  const viewport = win.visualViewport
  if (!viewport) return 0
  return Math.max(0, Math.round(win.innerHeight - viewport.height - viewport.offsetTop))
}

/**
 * Watch the visual viewport and publish the inset. `apply` fires on every viewport event
 * (Safari streams them through the keyboard animation — the composer tracks it); `onSettle`
 * fires once, `settleMs` after the events stop — the re-stick-to-bottom moment (research:
 * "re-run scrollToEnd() after the viewport settles"). Returns the cleanup; it resets the
 * inset to 0 so a stale `--kb` never outlives the watcher.
 */
export function watchKeyboardInset(
  win: KeyboardWindow,
  apply: (px: number) => void,
  onSettle?: (px: number) => void,
  settleMs = 250,
): () => void {
  const viewport = win.visualViewport
  if (!viewport) {
    apply(0)
    return () => {}
  }
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const onChange = () => {
    const inset = keyboardInset(win)
    apply(inset)
    if (onSettle) {
      clearTimeout(settleTimer)
      settleTimer = setTimeout(() => onSettle(inset), settleMs)
    }
  }
  apply(keyboardInset(win))
  viewport.addEventListener('resize', onChange)
  viewport.addEventListener('scroll', onChange)
  return () => {
    clearTimeout(settleTimer)
    viewport.removeEventListener('resize', onChange)
    viewport.removeEventListener('scroll', onChange)
    apply(0)
  }
}

/**
 * How much of the layout viewport is OUTSIDE the visual viewport, per edge. Floating layers
 * (Radix popovers) position against the layout viewport, so on iOS an open keyboard (bottom)
 * or a panned-down visual viewport (top) can hide them while their math says "visible".
 * Feeding these to Radix as `collisionPadding` makes collision avoidance work against the
 * viewport the user can actually see.
 */
export interface ViewportInsets {
  top: number
  bottom: number
}

export function viewportInsets(win: KeyboardWindow): ViewportInsets {
  const viewport = win.visualViewport
  if (!viewport) return { top: 0, bottom: 0 }
  return { top: Math.max(0, Math.round(viewport.offsetTop)), bottom: keyboardInset(win) }
}

/**
 * Merge the visual-viewport insets into a Radix `collisionPadding` value (number or per-side
 * object, default 0 — Radix's own default), preserving the caller's left/right padding.
 */
export function keyboardAwareCollisionPadding(
  insets: ViewportInsets,
  padding: number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>> = 0,
): Record<'top' | 'right' | 'bottom' | 'left', number> {
  const base = typeof padding === 'number' ? { top: padding, right: padding, bottom: padding, left: padding } : padding
  return {
    top: (base.top ?? 0) + insets.top,
    right: base.right ?? 0,
    bottom: (base.bottom ?? 0) + insets.bottom,
    left: base.left ?? 0,
  }
}

/** Watch the visual viewport and publish both insets. Same event surface as
 *  {@link watchKeyboardInset}; no settle debounce — positioning wants every frame. */
export function watchViewportInsets(
  win: KeyboardWindow,
  apply: (insets: ViewportInsets) => void,
): () => void {
  const viewport = win.visualViewport
  if (!viewport) {
    apply({ top: 0, bottom: 0 })
    return () => {}
  }
  const onChange = () => apply(viewportInsets(win))
  onChange()
  viewport.addEventListener('resize', onChange)
  viewport.addEventListener('scroll', onChange)
  return () => {
    viewport.removeEventListener('resize', onChange)
    viewport.removeEventListener('scroll', onChange)
  }
}

/** The React binding: the current visual-viewport insets as state ({0,0} on engines without
 *  `visualViewport` — desktop and jsdom stay exactly where they were). */
export function useViewportInsets(): ViewportInsets {
  const [insets, setInsets] = useState<ViewportInsets>({ top: 0, bottom: 0 })
  useEffect(() => {
    return watchViewportInsets(window as unknown as KeyboardWindow, (next) =>
      setInsets((current) =>
        current.top === next.top && current.bottom === next.bottom ? current : next,
      ),
    )
  }, [])
  return insets
}

/**
 * The React binding: keeps `--kb` on `:root` while mounted. `onSettle` is read through a ref,
 * so callers can hand a fresh closure every render without re-subscribing to the viewport.
 */
export function useKeyboardInsetVar(onSettle?: (px: number) => void): void {
  const onSettleRef = useRef(onSettle)
  onSettleRef.current = onSettle
  useEffect(() => {
    const root = document.documentElement
    return watchKeyboardInset(
      window as unknown as KeyboardWindow,
      (px) => root.style.setProperty('--kb', `${px}px`),
      (px) => onSettleRef.current?.(px),
    )
  }, [])
}

/** Below this a bottom inset is browser chrome or a pan, not a keyboard (the shortest iOS
 *  keyboard is ~200px, the URL-bar wobble a few dozen). */
export const KEYBOARD_MIN_INSET = 80

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/** A focused element that raises an on-screen keyboard: text-like input, textarea, contenteditable. */
function isTextEditable(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const node = el as { tagName?: string; type?: string; isContentEditable?: boolean }
  const tag = node.tagName?.toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((node.type ?? '').toLowerCase())
  return node.isContentEditable === true
}

/** Tallest `innerHeight` seen per window at its current `innerWidth`; a width change (rotation)
 *  starts the baseline over. Weakly keyed so stub windows do not leak. */
const heightBaselines = new WeakMap<object, { width: number | undefined; height: number }>()

function layoutHeightDrop(win: KeyboardWindow): number {
  const prev = heightBaselines.get(win)
  const height = prev && prev.width === win.innerWidth ? Math.max(prev.height, win.innerHeight) : win.innerHeight
  heightBaselines.set(win, { width: win.innerWidth, height })
  return height - win.innerHeight
}

/** Whether the on-screen keyboard is up. Two shapes: an overlay keyboard (iOS Safari) shows as a
 *  tall bottom inset at normal zoom — a pinch-zoomed page also has a shorter visual viewport,
 *  which is not a keyboard. A `resizes-content` keyboard (Chromium honoring the viewport meta)
 *  shrinks the layout viewport instead, so the inset stays 0; it counts only when a text field
 *  has focus, since a shorter desktop window or a hardware keyboard is not an on-screen one. */
export function keyboardOpen(win: KeyboardWindow): boolean {
  const drop = layoutHeightDrop(win)
  const scale = win.visualViewport?.scale ?? 1
  if (Math.abs(scale - 1) < 0.05 && keyboardInset(win) > KEYBOARD_MIN_INSET) return true
  return drop > KEYBOARD_MIN_INSET && isTextEditable(win.document?.activeElement)
}

/** The React binding for {@link keyboardOpen}. */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const win = window as unknown as KeyboardWindow
    const update = () => setOpen(keyboardOpen(win))
    update()
    const viewport = win.visualViewport
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
    }
  }, [])
  return open
}
