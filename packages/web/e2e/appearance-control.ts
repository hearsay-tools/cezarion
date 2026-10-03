import type { AgentBrowser } from './agent-browser'
import { settleVisual } from './visual-ready'

export type AppearanceControl = 'theme' | 'density' | 'width'

/** #795: appearance setup follows completed navigation, including late registry chrome.
 * Keep the existing 200ms/native/font/animation guards and the original selector input.
 * This local readiness rule does not block interactions with deliberately loading views. */
export function clickAppearanceControl(browser: AgentBrowser, control: AppearanceControl, value: string): void {
  const selector = `[data-slot="appearance-${control}"] [data-value="${value}"]`
  settleVisual(browser, selector, { idle: true })
  browser.click(selector)
  // The next hard navigation must carry the choice the native input actually committed.
  // Theme is browser-local; density/width still retain their specs' server persistence waits.
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked') === 'true'${control === 'theme'
    ? ` && localStorage.getItem('cez-theme') === ${JSON.stringify(value)} && document.documentElement.classList.contains('light') === ${value === 'light'}`
    : ''}`)
}
