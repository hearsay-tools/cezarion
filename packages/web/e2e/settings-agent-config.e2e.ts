import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  type ContrastSample,
  contrastQaVariants,
  contrastSampleExpression,
  restoreContrastQaDefaults,
} from './contrast'

/**
 * Settings → Agent config: the Pi pane (#322) against the shared dry-run environment. The
 * unit suite pins the descriptor table and the pane's DOM; this spec pins what only a real
 * browser can answer — the experience acceptance criteria: a Pi tab that is a 44×44 target at
 * 360×640, an MCP group that states why it is empty instead of vanishing, and AA contrast for
 * the tab and that note in both themes.
 *
 * Reachability: fully reachable — the listing needs no forge and no agent CLI (an absent file
 * is still listed, marked "absent"). Read-only: nothing here saves a file.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-agent-config-${process.pid}`

const TABS = '[data-slot="agent-config-agent"]'
const PI_TAB = `${TABS}[data-agent="pi"]`
const PI_MCP_EMPTY =
  '[data-slot="agent-config-group"][data-group="mcp"][data-agent="pi"] [data-slot="agent-config-group-empty"]'
const AA_NORMAL_TEXT = 4.5

let browser: AgentBrowser
let baseUrl: string

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

const gotoAgentConfig = () => {
  browser.goto(`${baseUrl}/settings/agent-config`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(PI_TAB)}) !== null`)
}

const rectOf = (selector: string) =>
  browser.evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { width: r.width, height: r.height } })()`,
  ) as { width: number; height: number }

const contrastOf = (selector: string) => browser.evaluate(contrastSampleExpression(selector)) as ContrastSample

describe('settings → agent config: the Pi pane', () => {
  it('offers a Pi tab after the other three and lists Pi’s catalogued files under it', () => {
    gotoAgentConfig()
    expect(browser.evaluate(`[...document.querySelectorAll(${JSON.stringify(TABS)})].map((el) => el.dataset.agent)`)).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
      'cursor',
    ])
    browser.click(PI_TAB)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(PI_MCP_EMPTY)}) !== null`)
    // Catalog order inside each group: settings (user → project), then memory (global, shared).
    expect(
      browser.evaluate(
        `[...document.querySelectorAll('[data-slot="agent-config-nav"] [data-slot="agent-config-file"] span.font-mono')].map((el) => el.textContent)`,
      ),
    ).toEqual(['~/.pi/agent/settings.json', '.pi/settings.json', '~/.pi/agent/AGENTS.md', 'AGENTS.md'])
    // No file is ever offered under MCP — the group is copy only.
    expect(
      browser.count('[data-slot="agent-config-group"][data-group="mcp"][data-agent="pi"] [data-slot="agent-config-file"]'),
    ).toBe(0)
  })

  // Both viewports × both themes at the default density — the matrix the craft checklist names.
  for (const variant of contrastQaVariants.filter((v) => v.density === 'comfortable')) {
    it(`${variant.id}: the Pi tab is a 44×44 target and the empty MCP note reads at AA`, () => {
      gotoAgentConfig()
      applyContrastQaVariant(browser, variant)
      try {
        // The acceptance criterion is the 44×44 target at ~360×640. On desktop the settings
        // stylesheet gives every panel button its 40px bar (settings-interiors.css), and the tab
        // must not fall below that either.
        const tab = rectOf(PI_TAB)
        expect(tab.width).toBeGreaterThanOrEqual(44)
        expect(tab.height).toBeGreaterThanOrEqual(variant.viewport.width === 360 ? 44 : 40)
        const idle = contrastOf(PI_TAB)
        expect(idle.ratio, `idle tab ${JSON.stringify(idle)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)

        browser.click(PI_TAB)
        browser.waitForFunction(`document.querySelector(${JSON.stringify(PI_MCP_EMPTY)}) !== null`)
        expect(browser.isVisible(PI_MCP_EMPTY)).toBe(true)
        expect(browser.text(PI_MCP_EMPTY)).toMatch(/No MCP/)
        expect(browser.text(PI_MCP_EMPTY)).toMatch(/extension/i)

        const selected = contrastOf(PI_TAB)
        expect(selected.ratio, `selected tab ${JSON.stringify(selected)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        const note = contrastOf(PI_MCP_EMPTY)
        expect(note.ratio, `empty note ${JSON.stringify(note)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)

        // The artifact records the tab row and the selected Pi state at 360 wide in each theme.
        // The note sits below the fold of the settings route's inner scroller, so its presence is
        // proven by the assertions above, not read off the picture.
        if (variant.viewport.width === 360) {
          browser.screenshot(`${artifactsDir}/settings-agent-config-pi-${variant.id}.png`, { viewport: true })
        }
      } finally {
        restoreContrastQaDefaults(browser)
      }
    })
  }
})
