import type { AgentBrowser } from './agent-browser'

/** Make React observe the clear before agent-browser's separate clear and insert steps. */
export function clearField(browser: Pick<AgentBrowser, 'evaluate' | 'waitForValue'>, selector: string): void {
  // The provider clears through React's value tracker, hiding the input event from React.
  // Clear through the native setter so a render between clear and insert restores ''.
  browser.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, '')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  browser.waitForValue(`document.querySelector(${JSON.stringify(selector)})?.value`, value => value === '')
}
