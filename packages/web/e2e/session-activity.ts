import type { AgentBrowser } from './agent-browser'

/** The Session activity card's folded summary (hearsay-tools/cezarion#1333). */
export const SESSION_ACTIVITY_SUMMARY = '[data-slot="run-activity-dock"] > button'

/**
 * Opens the Session activity card, then one of its rows, and returns once the row reports
 * `aria-expanded="true"`. Each toggle is a programmatic click that runs only while its control
 * still reads collapsed: the card sits above the composer, where a following thread can move a
 * coordinate click onto another element, and disclosure memory may already hold either one open.
 */
export function openSessionActivityRow(browser: AgentBrowser, row: 'status-row' | 'workflow' | 'usage' | 'workspace'): void {
  const head = `[data-slot="run-activity-${row}"] > button`
  browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
  browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}[aria-expanded="false"]')?.click()`)
  browser.waitForFunction(`document.querySelector('${head}') !== null`)
  browser.evaluate(`document.querySelector('${head}[aria-expanded="false"]')?.click()`)
  browser.waitForFunction(`document.querySelector('${head}')?.getAttribute('aria-expanded') === 'true'`)
}
