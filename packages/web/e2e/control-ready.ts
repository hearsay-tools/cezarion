import type { AgentBrowser } from './agent-browser'

/** Reveal a control in scrollable content and wait until its center receives pointer input. */
export function revealControl(browser: AgentBrowser, selector: string): void {
  const target = JSON.stringify(selector)
  browser.waitForFunction(`document.querySelector(${target}) !== null`)
  browser.evaluate(`document.querySelector(${target}).scrollIntoView({ block: 'center' })`)
  browser.waitForFunction(`(() => {
    const target = document.querySelector(${target})
    const rect = target.getBoundingClientRect()
    return !target.disabled && target.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })()`)
}
