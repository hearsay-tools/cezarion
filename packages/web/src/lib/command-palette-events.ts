/** The programmatic-open seam: a window event rather than a context, so chrome that must stay
 *  presentational (the sidebar hint today, an onboarding nudge tomorrow) can open the palette
 *  without threading a setter through the tree. */
export const OPEN_COMMAND_PALETTE_EVENT = 'cezar:open-command-palette'

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))
}
