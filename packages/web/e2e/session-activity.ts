import type { AgentBrowser } from './agent-browser'
import { waitForSettledSample } from './visual-ready'

/** The Session activity card's folded summary (hearsay-tools/cezarion#1333). */
export const SESSION_ACTIVITY_SUMMARY = '[data-slot="run-activity-dock"] > button'

/**
 * Opens the Session activity card, then one of its rows, and returns once the row reports
 * `aria-expanded="true"`. Each toggle is a pointer click that runs only while its control still
 * reads collapsed, because disclosure memory may already hold either one open.
 */
export function openSessionActivityRow(browser: AgentBrowser, row: 'status-row' | 'workflow' | 'usage' | 'workspace'): void {
  const section = `[data-slot="run-activity-${row}"]`
  const head = `${section} > button`
  browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
  if (browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}').getAttribute('aria-expanded')`) === 'false') {
    browser.click(SESSION_ACTIVITY_SUMMARY)
  }
  browser.waitForFunction(`document.querySelector('${head}') !== null`)
  // Desktop bounds the activity card. Reveal a row inside its scroll area before sampling it.
  browser.evaluate(`document.querySelector('${head}').scrollIntoView({ block: 'nearest' })`)
  // hearsay-tools/cezarion#1372: CI 39506549486, cockpit-failures-shard-2 (12303973289),
  // .ai/qa/failures/task-github-items/on-a-phone-the-chip-lands-on-a-PR-tab-that-is-inside-the-viewport-1/:
  // Workspace stayed collapsed. A local pointer/identity probe found the same button move
  // up 124px when opening the card queued a thread ResizeObserver scroll. Reproduce with
  // `npm exec -- vitest run --config .ai/qa/1372/controlled.config.ts -t 'on a phone the chip lands'`
  // (scratch replay in .ai/qa/1372/proof-replay.md): deliver the native callback between the
  // provider's centre read and press; old 1/1 failed, settled 1/1 passed. Hold geometry and
  // centre hit-test readiness before the single click; row existence does not settle scroll.
  const expanded = waitForSettledSample<string>(browser, `(() => {
    const target = document.querySelector('${head}')
    if (!target) return null
    const box = target.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return hit && target.contains(hit) ? target.getAttribute('aria-expanded') : null
  })()`, () => true, head)
  if (expanded === 'false') {
    browser.click(head)
  }
  browser.waitForFunction(`document.querySelector('${head}')?.getAttribute('aria-expanded') === 'true'`)
  // Expansion can put a reference link under the stationary pointer and open its hover card
  // over another link. Evidence: .ai/qa/failures/task-github-items/on-a-phone-the-chip-lands-on-a-PR-tab-that-is-inside-the-viewport-1/;
  // the hearsay-tools/cezarion#1372 local follow-up found an Issue card covering PR centre (145, 640).
  // `npm exec -- vitest run --config .ai/qa/1372/hover.config.ts -t 'on a phone the chip lands'`
  // waits for that real hover card: pre-click readiness alone failed 1/1, this passed 1/1.
  // Keep the pointer on the settled heading, then observe the hover card's removal.
  waitForSettledSample(browser, `document.querySelector('${head}')?.getAttribute('aria-expanded') === 'true'`, expanded => expanded === true, section)
  browser.hover(head)
  browser.waitForFunction(`document.querySelector('[data-slot="reference-status-card"]') === null`)
}
