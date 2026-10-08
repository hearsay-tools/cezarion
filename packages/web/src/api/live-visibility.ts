import { useSyncExternalStore } from 'react'

let pageHidden = false
const listeners = new Set<(active: boolean) => void>()
export const pageIsActive = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && !pageHidden
const emit = () => { const active = pageIsActive(); for (const listener of [...listeners]) listener(active) }
const hide = () => { pageHidden = true; emit() }
const show = () => { pageHidden = false; emit() }
export function subscribePageActivity(listener: (active: boolean) => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    pageHidden = false
    document.addEventListener('visibilitychange', emit)
    document.addEventListener('freeze', hide)
    document.addEventListener('resume', show)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', emit)
      document.removeEventListener('freeze', hide)
      document.removeEventListener('resume', show)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
    }
  }
}
export function usePageActive(): boolean {
  return useSyncExternalStore(subscribePageActivity, pageIsActive, () => false)
}
