import { expect } from 'vitest'
import type { AgentBrowser } from './agent-browser'

/**
 * The A/B group row is the task row's skeleton (#617 01a): the same fixed two-line height at every
 * width, collapsed and expanded, in every density. Below 48rem the stylesheet floors every button
 * at 44px (#166, `styles/index.css`), which is what once grew a line-1-only group toggle from 19px
 * to 44px and the row from 47px to ~72px — so this measures the phone widths, not only desktop.
 *
 * Shared by `selection-states` (a hover-capable pointer) and `quick-list` (headless `hover: none`),
 * because the group row renders a different structure for each and both must keep the height.
 */
export function expectGroupRowHeightMatchesTaskRow(
  browser: AgentBrowser,
  { url, groupId, widths }: { url: string; groupId: string; widths: readonly number[] },
): void {
  type Heights = {
    density: string
    expanded: string | null
    group: number
    task: number
    toggle: number
    overlap: boolean
  }
  try {
    for (const width of widths) {
      const mobile = width < 768
      browser.setViewport(width, 900)
      browser.goto(url)
      if (mobile) {
        browser.click('[data-slot="mobile-top-bar"] button[aria-label^="Open projects"]')
        // The sheet slides in from the left. A click aimed at a row mid-slide lands on the scrim
        // and dismisses the drawer, so wait until its left edge has settled at 0 and stayed there.
        // Provenance: the local failure bundle (gitignored) from this helper's first run,
        // .ai/qa/failures/selection-states/keeps-the-group-row-a-task-row-s-height-at-1440-520-and-390px-with-a-pointer-617-1/
        // — probe.json: kind "wait-value" on the expanded group row inside the drawer at 520px,
        // lastValue null, openDialogs []; snapshot.txt: `button "Open menu" [expanded=false]`,
        // i.e. the expand click had dismissed the drawer. Reproduced with this single test
        // (`-t "keeps the group row a task row"`, primaryHoverType=2): unfixed 3/3 failed the same
        // way (lastValue null, drawer closed), fixed 3/3 passed.
        browser.waitForStable(
          `Math.round(document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().left ?? -1)`,
          { holdMs: 200, matcher: (left: number) => left === 0 },
        )
      }
      // Below md the aside is display:none and the drawer holds the list; measure the rows the
      // user can actually see.
      const scope = mobile ? '[data-slot="mobile-nav-drawer"] ' : '[data-slot="sidebar"] '
      const group = `${scope}[data-slot="group-row"][data-group-id="${groupId}"]`
      for (const density of ['comfortable', 'compact', 'ultra'] as const) {
        browser.evaluate(`(() => {
          if (${JSON.stringify(density)} === 'comfortable') delete document.documentElement.dataset.density
          else document.documentElement.dataset.density = ${JSON.stringify(density)}
        })()`)
        const heights = (expanded: 'true' | 'false') => `(() => {
          const density = document.documentElement.dataset.density ?? 'comfortable'
          if (density !== ${JSON.stringify(density)}) return null
          const row = document.querySelector(${JSON.stringify(group)})
          const toggle = row?.querySelector('[data-slot="group-tile"]')
          const compare = row?.querySelector('[data-slot="group-compare"]')
          const task = [...document.querySelectorAll(${JSON.stringify(`${scope}[data-slot="task-row"]`)})]
            .find((el) => !el.closest('[data-slot="variant-list"]'))
          if (!row || !toggle || !compare || !task || toggle.getAttribute('aria-expanded') !== ${JSON.stringify(expanded)}) return null
          const g = row.getBoundingClientRect(), t = toggle.getBoundingClientRect(), c = compare.getBoundingClientRect()
          if (g.height === 0) return null
          return { density, expanded: toggle.getAttribute('aria-expanded'),
            group: Math.round(g.height), task: Math.round(task.getBoundingClientRect().height), toggle: Math.round(t.height),
            // #166: neighbouring targets never share a hit area.
            overlap: t.left < c.right && c.left < t.right && t.top < c.bottom && c.top < t.bottom }
        })()`
        for (const expanded of ['false', 'true'] as const) {
          if (expanded === 'true') browser.click(`${group} [data-slot="group-tile"]`)
          // Wait, then read (e2e README): the density attribute, the drawer and the expand all land
          // a frame after the action that caused them, so the sample is taken once they have.
          const sample = browser.waitForValue(heights(expanded), (h: Heights | null) => h !== null) as Heights
          const label = `${width}px ${density} expanded=${expanded}: ${JSON.stringify(sample)}`
          expect(sample.group, label).toBe(sample.task)
          if (density === 'comfortable') expect(sample.group, label).toBe(47)
          expect(sample.toggle, label).toBeLessThanOrEqual(sample.group)
          if (mobile) expect(sample.toggle, label).toBeGreaterThanOrEqual(44)
          expect(sample.overlap, label).toBe(false)
        }
        browser.click(`${group} [data-slot="group-tile"]`)
        browser.waitForFunction(`document.querySelector(${JSON.stringify(`${group} [data-slot="group-tile"]`)})?.getAttribute('aria-expanded') === 'false'`)
      }
    }
  } finally {
    browser.evaluate(`delete document.documentElement.dataset.density`)
    browser.setViewport(1440, 900)
  }
}
