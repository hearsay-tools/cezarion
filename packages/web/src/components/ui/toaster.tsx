import { useSyncExternalStore, type FocusEvent } from 'react'

import { cn } from '@/lib/utils'

/**
 * A minimal toast primitive — the transient "that worked / that didn't" line the legacy UI
 * called `alertBar`. Deliberately not a library: the cockpit needs exactly one behavior
 * (message in, auto-dismiss after a beat) and every dependency lands in the shipped bundle.
 *
 * Module-level store + `useSyncExternalStore` so `toast()` is callable from anywhere —
 * mutation callbacks, event handlers — without threading a context through the tree. The one
 * `<Toaster />` instance (mounted at the app root) renders whatever the store holds.
 */

export type ToastTone = 'default' | 'danger'

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  /** `true` once the lifetime timer fired. The item stays in the store — and mounted — for
   *  `EXIT_MS` longer so the exit animation has something to animate; dropping it here is
   *  what made the old toast vanish with no transition. */
  exiting: boolean
  action?: ToastAction
}

export interface ToastAction {
  label: string
  onAction: () => void
}

const TOAST_MS = 5000
/** A toast with an action gives the reader time to reach it. */
export const ACTION_TOAST_MS = 8000
/** Exit-animation window. Keep in step with the `duration-200` on the toast's animation
 *  classes below: the node is removed once this elapses, so a shorter value would cut the
 *  slide-out off mid-flight. */
const EXIT_MS = 200

let items: readonly ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
/** Every pending lifetime/exit timer, so `resetToasts()` can cancel them — an orphaned timer
 *  would publish into the *next* test's store. */
const timers = new Set<ReturnType<typeof setTimeout>>()

function publish(next: readonly ToastItem[]): void {
  items = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `setTimeout` that keeps its handle cancellable until it actually runs. */
function schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(() => {
    timers.delete(handle)
    fn()
  }, ms)
  timers.add(handle)
  return handle
}

/** Lifetime clock of one toast, pausable. `holds` are the reasons it is paused (pointer over
 *  the toast, focus inside it); the clock runs only while none is held. */
interface Lifetime {
  handle: ReturnType<typeof setTimeout> | null
  deadline: number
  remaining: number
  holds: Set<'hover' | 'focus'>
}
const lifetimes = new Map<number, Lifetime>()

function startExit(id: number): void {
  lifetimes.delete(id)
  if (!items.some((t) => t.id === id && !t.exiting)) return
  publish(items.map((t) => (t.id === id ? { ...t, exiting: true } : t)))
  schedule(() => publish(items.filter((t) => t.id !== id)), EXIT_MS)
}

function runLifetime(id: number, life: Lifetime): void {
  life.deadline = Date.now() + life.remaining
  life.handle = schedule(() => startExit(id), life.remaining)
}

function hold(id: number, reason: 'hover' | 'focus', on: boolean): void {
  const life = lifetimes.get(id)
  if (!life) return
  const wasPaused = life.holds.size > 0
  if (on) life.holds.add(reason)
  else life.holds.delete(reason)
  const paused = life.holds.size > 0
  if (paused === wasPaused) return
  if (paused) {
    if (life.handle !== null) {
      clearTimeout(life.handle)
      timers.delete(life.handle)
      life.handle = null
    }
    life.remaining = Math.max(0, life.deadline - Date.now())
  } else {
    runLifetime(id, life)
  }
}

/** Show a transient message. `danger` tone for failures — the message should be the server's
 *  own words wherever one exists (see ApiError). An `action` adds a button that runs
 *  `onAction` and dismisses the toast; such a toast lives longer and pauses while hovered or
 *  focused. */
export function toast(
  message: string,
  opts: { tone?: ToastTone; action?: ToastAction } = {},
): void {
  const item: ToastItem = {
    id: nextId++,
    message,
    tone: opts.tone ?? 'default',
    exiting: false,
    ...(opts.action ? { action: opts.action } : {}),
  }
  publish([...items, item])
  // Two phases, one clock per toast: mark it exiting so the renderer can animate it out, then
  // remove it once the animation has played.
  const life: Lifetime = {
    handle: null,
    deadline: 0,
    remaining: opts.action ? ACTION_TOAST_MS : TOAST_MS,
    holds: new Set(),
  }
  lifetimes.set(item.id, life)
  runLifetime(item.id, life)
}

/** Test seam: clears the module-level queue *and* every pending timer, so one test's toasts
 *  never leak into the next. */
export function resetToasts(): void {
  for (const handle of timers) clearTimeout(handle)
  timers.clear()
  lifetimes.clear()
  publish([])
}

export function Toaster() {
  const current = useSyncExternalStore(subscribe, () => items)
  if (current.length === 0) return null
  return (
    <div
      data-slot="toaster"
      // Top-right, the placement web apps have standardised on: bottom-centre landed straight
      // on the thread's action row. z-[60] clears the Radix overlay layer (z-50) — dialogs fire
      // toasts, and their portal sits later in <body>, so at an equal z-index the dialog wins.
      //
      // The mobile offset clears the app shell's own header (app-shell.tsx: a 56px row plus its
      // border, under the safe-area inset) whose right end holds the run status dot and kebab.
      // Anchoring at 16px on a phone would cover exactly the controls #818 is about, which is
      // the bug moved rather than fixed; `md:` is where that header stops rendering.
      className="pointer-events-none fixed top-[calc(66px+env(safe-area-inset-top))] right-[calc(16px+env(safe-area-inset-right))] z-[60] flex flex-col items-end gap-2 md:top-[calc(16px+env(safe-area-inset-top))]"
    >
      {current.map((item) => (
        <div
          key={item.id}
          role="status"
          data-slot="toast"
          data-tone={item.tone}
          data-state={item.exiting ? 'closed' : 'open'}
          {...(item.action
            ? {
                onPointerEnter: () => hold(item.id, 'hover', true),
                onPointerLeave: () => hold(item.id, 'hover', false),
                onFocus: () => hold(item.id, 'focus', true),
                onBlur: (e: FocusEvent<HTMLDivElement>) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    hold(item.id, 'focus', false)
                },
              }
            : {})}
          className={cn(
            'pointer-events-auto max-w-[min(360px,calc(100vw-32px))] rounded-md px-3.5 py-2.5 text-[13px] font-medium shadow-modal',
            // tw-animate-css utilities (imported in styles/index.css), the same vocabulary the
            // shadcn primitives use. motion-safe: so `prefers-reduced-motion` keeps the instant
            // appear/disappear it had before.
            'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-4 motion-safe:duration-200',
            'motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:slide-out-to-right-4',
            item.tone === 'danger'
              ? 'bg-danger text-danger-foreground'
              : 'bg-contrast text-contrast-foreground',
            item.action && 'flex items-center',
          )}
        >
          {item.message}
          {item.action ? (
            <button
              type="button"
              data-slot="toast-action"
              className="ml-3 shrink-0 cursor-pointer font-semibold text-inherit underline underline-offset-2"
              onClick={() => {
                item.action!.onAction()
                startExit(item.id)
              }}
            >
              {item.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
