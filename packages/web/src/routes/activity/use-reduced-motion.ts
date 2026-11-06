import { useSyncExternalStore } from 'react'

/** The user's motion preference (spec 2026-11-05-live-activity-view, "Reduced motion"). */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : undefined)

function subscribe(listener: () => void): () => void {
  const media = query()
  media?.addEventListener?.('change', listener)
  return () => media?.removeEventListener?.('change', listener)
}

/** True when the user asks for reduced motion; false wherever `matchMedia` is missing. */
export function prefersReducedMotion(): boolean {
  return query()?.matches ?? false
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}
