import * as React from 'react'

import { DEFAULT_SIDEBAR_WIDTH } from '@/lib/sidebar-width'

/** The desktop sidebar's current width, for the project rail (#711): it may unfold only while the
 *  main column keeps its floor, and the sidebar's width is part of that sum. The shell owns the
 *  width, so it provides it; outside a shell the rail reads the default. */
export const ShellSidebarWidthContext = React.createContext(DEFAULT_SIDEBAR_WIDTH)

/**
 * The drawer's close-on-navigate callback, published to whatever renders inside the sidebar's
 * slots (`projectHeader`, `taskQuickList`). The route-change effect already closes the drawer
 * for every *changed* route; this covers re-clicking a link to the CURRENT route (per the spec,
 * Tasks navigates home even when already active), which changes no pathname at all. Undefined
 * on desktop, where there is nothing to close.
 */
export const SidebarNavigateContext = React.createContext<(() => void) | undefined>(undefined)

export function useSidebarNavigate(): (() => void) | undefined {
  return React.useContext(SidebarNavigateContext)
}
