import type { AgentBrowser } from './agent-browser'

/** A section shell is not a mount gate for independently loaded settings controls. */
export function waitForSettingsControl(
  browser: AgentBrowser,
  selector: string,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  browser.waitForFunction(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)})
    if (!control) return false
    if (${enabled} && (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true')) return false
    return !(control instanceof HTMLSelectElement) || control.options.length > 0
  })()`)
}
