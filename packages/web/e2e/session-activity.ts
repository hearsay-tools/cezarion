import type { AgentBrowser } from './agent-browser'

/** The Session activity card's folded summary (hearsay-tools/cezarion#1333). */
export const SESSION_ACTIVITY_SUMMARY = '[data-slot="run-activity-dock"] > button'

/**
 * Opens the Session activity card, then one of its rows, and returns once the row reports
 * `aria-expanded="true"`. Each toggle is a pointer click that runs only while its control still
 * reads collapsed, because disclosure memory may already hold either one open.
 */
export function openSessionActivityRow(browser: AgentBrowser, row: 'status-row' | 'workflow' | 'usage' | 'workspace'): void {
  const head = `[data-slot="run-activity-${row}"] > button`
  browser.waitForFunction(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}') !== null`)
  if (browser.evaluate(`document.querySelector('${SESSION_ACTIVITY_SUMMARY}').getAttribute('aria-expanded')`) === 'false') {
    browser.click(SESSION_ACTIVITY_SUMMARY)
  }
  browser.waitForFunction(`document.querySelector('${head}') !== null`)
  if (browser.evaluate(`document.querySelector('${head}').getAttribute('aria-expanded')`) === 'false') {
    // Desktop bounds the activity card. Reveal a row inside its scroll area before clicking.
    browser.evaluate(`document.querySelector('${head}').scrollIntoView({ block: 'nearest' })`)
    browser.click(head)
  }
  browser.waitForFunction(`document.querySelector('${head}')?.getAttribute('aria-expanded') === 'true'`)
}
