/* Whether the desktop project rail is unfolded (#711): the pure half, shaped like
 * `lib/sidebar-width.ts` and stored next to it for the same reason. Unfolding the rail spends
 * 172px of main-column width, which is a question about the SCREEN you sit at, not about the
 * workspace: the same checkout on a laptop and on an ultrawide wants two answers, and
 * `~/.cezar/config.json` can hold only one. No config key, no `CEZ_*` flag.
 */

/** Namespaced `cez-` like `cez-sidebar-width` and `cez-theme`. `'1'` is expanded; anything else,
 *  an absent key included, is the default: collapsed. */
export const PROJECT_RAIL_EXPANDED_STORAGE_KEY = 'cez-project-rail-expanded'

/** The two widths, in CSS pixels. Collapsed is the slice-2 rail; expanded fits full names. */
export const PROJECT_RAIL_COLLAPSED_WIDTH = 60
export const PROJECT_RAIL_EXPANDED_WIDTH = 232

/** Expanding must leave the main column at least this wide, or the rail stays collapsed. */
export const MIN_MAIN_WIDTH_FOR_EXPANDED_RAIL = 640

/**
 * Whether the window has room for the expanded rail beside a sidebar of `sidebarWidth`. The
 * layout pushes rather than overlays, so the main column is what pays: viewport minus the
 * expanded rail minus the sidebar must stay at or above the floor.
 */
export function railCanExpand(viewportWidth: number, sidebarWidth: number): boolean {
  return viewportWidth - PROJECT_RAIL_EXPANDED_WIDTH - sidebarWidth >= MIN_MAIN_WIDTH_FOR_EXPANDED_RAIL
}

/** The stored choice, or collapsed when storage is empty, unreadable (private mode) or junk. */
export function readStoredRailExpanded(): boolean {
  try {
    return localStorage.getItem(PROJECT_RAIL_EXPANDED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeStoredRailExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(PROJECT_RAIL_EXPANDED_STORAGE_KEY, expanded ? '1' : '0')
  } catch {
    // Private mode / storage disabled: the choice still applies for this page.
  }
}
