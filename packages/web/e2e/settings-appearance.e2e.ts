import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Global settings shell + Appearance (R6 Step 1.3; moved to the global area in the
 * multi-project step 3.5) end-to-end against the shared dry-run environment.
 *
 * Reachability: everything here is honestly reachable — the settings routes need no forge, no
 * agent CLI and no seeded runs. The suite mutates exactly two stores and restores/neutralizes
 * both: the WORKSPACE `ui-state.json` (saved in beforeAll, restored in afterAll — the inbox
 * suite's save/restore discipline) and the browser session's localStorage theme mirror
 * (flipped back to dark in the same spec, and the session is unique per run anyway).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

// Appearance persists in the WORKSPACE ui-state since step 3.5. `.ai/scripts/test-env-up.sh`
// pins `CEZ_HOME` under `.ai/qa/cez-home`, so that — not the developer's `~/.cezar`, and not
// the repo's `.ai/cezar` — is the file this suite reads and restores.
const cezHomeDir = resolve(import.meta.dirname, '../../../.ai/qa/cez-home')
const uiStateFile = resolve(cezHomeDir, 'ui-state.json')

let browser: AgentBrowser
let baseUrl: string
let previousUiState: string | null = null

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  previousUiState = existsSync(uiStateFile) ? readFileSync(uiStateFile, 'utf8') : null
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave a developer's cockpit wearing this test's appearance.
  if (previousUiState === null) rmSync(uiStateFile, { force: true })
  else writeFileSync(uiStateFile, previousUiState, 'utf8')
  browser?.close()
})

/** The PUT behind an appearance click is fire-and-forget from the UI's point of view — poll
 *  the API until the write lands rather than assume it beat this assertion. */
async function waitForServerAppearance(check: (appearance: Record<string, unknown>) => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/v1/workspace/ui-state`)
    const state = (await res.json()) as { appearance?: Record<string, unknown> }
    if (state.appearance && check(state.appearance)) return state.appearance
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('ui-state.json never showed the expected appearance')
}

describe('settings → appearance against the live dry-run server', () => {
  it('the shell renders the registry sections — hidden ones absent, active one marked', () => {
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-route="settings-global-appearance"]') !== null`)

    // The GLOBAL nav: the original sections plus skills and Agent Accounts,
    // and nothing project-scoped.
    const nav = '[data-slot="settings-nav"][data-scope="global"]'
    expect(browser.evaluate(`[...document.querySelectorAll('${nav} [data-section]')].map(el => el.dataset.section).sort()`)).toEqual(['accounts', 'appearance', 'notifications', 'projects', 'resources', 'skills'])
    expect(browser.count(`${nav} [data-section="appearance"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="notifications"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="resources"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="skills"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="projects"]`)).toBe(1)
    // Project sections live in the OTHER area; hidden registry entries are nowhere at all.
    expect(browser.count(`${nav} [data-section="agents"]`)).toBe(0)
    expect(browser.count(`${nav} [data-section="bookmarklets"]`)).toBe(0)
    expect(browser.count(`${nav} [data-section="mcp"]`)).toBe(0)
    expect(browser.count(`${nav} [aria-current="page"][data-section="appearance"]`)).toBe(1)
  })

  it('flipping the theme flips the root class and persists across a reload', () => {
    browser.click('[data-slot="appearance-theme"] [data-value="light"]')
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)

    // A fresh navigation: the pre-paint script must re-apply the choice before the bundle.
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)
    expect(browser.count('[data-slot="appearance-theme"] [data-value="light"][aria-checked="true"]')).toBe(1)

    // Back to dark so every other suite screenshots the default palette.
    browser.click('[data-slot="appearance-theme"] [data-value="dark"]')
    browser.waitForFunction(`!document.documentElement.classList.contains('light')`)
  })

  it('keeps the sole accent wired while omitting its one-choice control', async () => {
    // A legacy server value is still accepted. On boot the appearance mechanism normalizes it
    // to the sole Cezarion family and mirrors that canonical value for the next pre-paint.
    await fetch(`${baseUrl}/api/v1/workspace/ui-state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appearance: { accent: 'violet', density: 'comfortable', width: 'wide' } }),
    })
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(
      `localStorage.getItem('cez-accent') === 'cezarion' && document.querySelector('[data-slot="appearance-width"] [data-value="wide"]')?.getAttribute('aria-checked') === 'true'`,
    )
    expect(browser.count('[data-slot="appearance-accent"]')).toBe(0)
    expect(browser.evaluate(`document.documentElement.dataset.accent`)).toBeNull()

    // Saving another appearance field writes the complete normalized object, proving accent is
    // still connected rather than deleted along with the redundant control.
    browser.click('[data-slot="appearance-density"] [data-value="compact"]')
    const appearance = await waitForServerAppearance((a) => a.accent === 'cezarion' && a.density === 'compact')
    expect(appearance.accent).toBe('cezarion')
    browser.click('[data-slot="appearance-density"] [data-value="comfortable"]')
    await waitForServerAppearance((a) => a.density === 'comfortable')
    browser.click('[data-slot="appearance-width"] [data-value="narrow"]')
    await waitForServerAppearance((a) => a.density === 'comfortable' && a.width === 'narrow')
    browser.waitForFunction(`document.documentElement.dataset.density === undefined`)
  })

  it('compact density measurably tightens the spacing scale', async () => {
    const header = `document.querySelector('[data-route="settings-global-appearance"] header')`
    const section = `document.querySelector('[data-slot="appearance-section"]')`
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(70)
    expect(Number(browser.evaluate(`parseFloat(getComputedStyle(${section}).rowGap)`))).toBe(28)

    browser.click('[data-slot="appearance-density"] [data-value="compact"]')
    browser.waitForFunction(`document.documentElement.dataset.density === 'compact'`)
    // Compact spacing reduces the route header gap by 1px while preserving its title/context.
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(69)
    expect(Number(browser.evaluate(`parseFloat(getComputedStyle(${section}).rowGap)`))).toBe(24.5)
    await waitForServerAppearance((a) => a.density === 'compact')

    browser.screenshot(`${artifactsDir}/settings-appearance.png`)

    // Neutralize for the rest of the suite run (afterAll restores the file itself too).
    browser.click('[data-slot="appearance-density"] [data-value="comfortable"]')
    browser.waitForFunction(
      `document.documentElement.dataset.density === undefined && document.documentElement.dataset.accent === undefined`,
    )
  })
})
