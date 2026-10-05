import * as React from 'react'

/**
 * Clicks that land on what a `text-overflow: ellipsis` line hid.
 *
 * The sidebar's meta line (`running · PR #4724 · PR #4712 · …`) truncates with an ellipsis, and
 * its references are `inline-flex` links — atomic inlines, which the ellipsis hides WHOLE rather
 * than cutting. Chromium stops painting such a box but keeps hit-testing it over its own rect, so
 * the blank space right of the `…` is a live link to a reference nobody can see: a click meant for
 * the row opened `/tasks/:id/pr/:n` instead of the session. Every hidden child is marked with
 * `data-ellipsis-hidden`, and `ELLIPSIS_HIDDEN_CLASS` on the line turns its pointer events off, so
 * the click falls through to the row. Focus and the accessible tree are left alone: the reference
 * stays reachable by keyboard, it is only the pointer that must not hit what is not painted.
 */

/** Put on the truncating line itself: a child the ellipsis hid takes no pointer events. */
export const ELLIPSIS_HIDDEN_CLASS = '[&>[data-ellipsis-hidden]]:pointer-events-none'

const ATTRIBUTE = 'data-ellipsis-hidden'

const ellipsisWidths = new Map<string, number>()

/** The `…` glyph's width in `line`'s font, measured once per font with an off-screen probe.
 *  Without layout (jsdom) the probe is 0 wide: fall back to one em, a safe over-estimate. */
function ellipsisWidth(line: HTMLElement): number {
  const style = getComputedStyle(line)
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily} ${style.letterSpacing}`
  const cached = ellipsisWidths.get(font)
  if (cached !== undefined) return cached
  const probe = document.createElement('span')
  probe.textContent = '…'
  probe.setAttribute('aria-hidden', 'true')
  Object.assign(probe.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre',
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    letterSpacing: style.letterSpacing,
  })
  document.body.appendChild(probe)
  const measured = probe.getBoundingClientRect().width
  probe.remove()
  const width = measured || parseFloat(style.fontSize) || 12
  // A font that has not loaded yet measures in its fallback: cache only once fonts are in.
  if (measured && (!document.fonts || document.fonts.status === 'loaded')) ellipsisWidths.set(font, width)
  return width
}

/**
 * The children of a left-to-right ellipsis line that the `…` hides: nothing while the content
 * fits, else every child whose right edge passes the point where the `…` begins (the browser
 * keeps an atomic inline only if it ends before that point). Exported for the unit test.
 */
export function ellipsisHiddenChildren(line: HTMLElement, ellipsis: number): Element[] {
  if (line.scrollWidth <= line.clientWidth) return []
  const box = line.getBoundingClientRect()
  const paddingRight = parseFloat(getComputedStyle(line).paddingRight) || 0
  const contentRight = box.left + line.clientLeft + line.clientWidth - paddingRight
  // Half a pixel of slack for subpixel layout: a chip that ends exactly at the `…` is painted.
  const limit = contentRight - ellipsis + 0.5
  return Array.from(line.children).filter((child) => child.getBoundingClientRect().right > limit)
}

/**
 * Keeps `data-ellipsis-hidden` on exactly the children of `ref` that its ellipsis hides, for as
 * long as the line is mounted: on a resize of the line or of any child (a reference's status glyph
 * lands and widens it), on a child added or replaced (the age dropping, a chip swapped for its
 * hover-card subtree), and once web fonts land. `key` re-runs it when the content changes. Off
 * when `enabled` is false, and without a ResizeObserver (jsdom), where nothing is ever hidden.
 */
export function useEllipsisHiddenChildren(ref: React.RefObject<HTMLElement | null>, enabled: boolean, key: string): void {
  React.useLayoutEffect(() => {
    const line = ref.current
    if (!enabled || !line || typeof ResizeObserver === 'undefined') return
    let live = true
    const sync = () => {
      if (!live) return
      const hidden = new Set(ellipsisHiddenChildren(line, ellipsisWidth(line)))
      for (const child of Array.from(line.children)) {
        if (child.hasAttribute(ATTRIBUTE) !== hidden.has(child)) child.toggleAttribute(ATTRIBUTE, hidden.has(child))
      }
    }
    const observer = new ResizeObserver(sync)
    const observed = new Set<Element>()
    const bind = () => {
      for (const child of Array.from(line.children)) {
        if (observed.has(child)) continue
        observed.add(child)
        observer.observe(child)
      }
    }
    observer.observe(line)
    bind()
    sync()
    // Attributes are ours, so only the child list is watched: toggling the mark cannot loop.
    const mutations = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
          bind()
          sync()
        })
    mutations?.observe(line, { childList: true })
    if (document.fonts && document.fonts.status !== 'loaded') void document.fonts.ready.then(sync)
    return () => {
      live = false
      observer.disconnect()
      mutations?.disconnect()
      for (const child of Array.from(line.children)) child.removeAttribute(ATTRIBUTE)
    }
  }, [ref, enabled, key])
}
