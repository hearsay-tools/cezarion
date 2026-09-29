import * as React from 'react'
import { createPortal } from 'react-dom'

/**
 * How a routed run publishes its phone top-bar content (title, state line, run actions) into the
 * shell's `MobileTopBar` without the shell knowing anything about runs.
 *
 * The shell renders an empty slot element while a pushed task route is open and publishes it here;
 * `RunHeader` — which already holds the run, the attention state and the action machinery —
 * portals its content into it. A portal, rather than lifting run state up into the shell or
 * re-querying it there, because it keeps ONE `ActionsKebab` instance owning its dialogs and
 * mutations (React context and state follow the portal's React parent, not its DOM parent), and
 * because the slot's mere presence is the "there is a mobile bar to fill" signal: no shell, no
 * slot, and the header renders everything in place exactly as before.
 */
export const MobileRunBarSlotContext = React.createContext<HTMLElement | null>(null)

/** The shell's top-bar slot, or null outside a pushed task route (and outside the shell). */
export function useMobileRunBarSlot(): HTMLElement | null {
  return React.useContext(MobileRunBarSlotContext)
}

/** Renders `children` inside the shell's top-bar slot. */
export function MobileRunBarPortal({ slot, children }: { slot: HTMLElement; children: React.ReactNode }) {
  return createPortal(children, slot)
}

/** Tailwind's `md`, as `app-shell.tsx`'s `DESKTOP_MEDIA_QUERY`: the same breakpoint as the `md:`
 *  classes, read in JS where a component must choose WHICH tree to render rather than which to hide. */
const DESKTOP_QUERY = '(min-width: 768px)'

/** Is the viewport `md` or wider? Defaults to true where `matchMedia` is missing (jsdom), so a
 *  bare render is the desktop tree. */
export function useIsDesktopViewport(): boolean {
  const [desktop, setDesktop] = React.useState(() => window.matchMedia?.(DESKTOP_QUERY).matches ?? true)
  React.useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_QUERY)
    if (!query) return
    const onChange = () => setDesktop(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return desktop
}
