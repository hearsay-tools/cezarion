import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, readTestEnv } from './agent-browser'

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let browser: AgentBrowser
let base: string
beforeAll(() => {
  base = readTestEnv().baseUrl
  mkdirSync(artifacts, { recursive: true })
  browser = AgentBrowser.open(`settings-sidebar-${process.pid}`)
})
afterAll(() => browser?.close())

const sidebar = '[data-slot="settings-sidebar"]'

describe('Settings view sidebar (#622)', () => {
  for (const theme of ['light', 'dark']) {
    it(`${theme}: navigates between project and global sections without duplicate desktop navigation`, () => {
      browser.setViewport(1440, 900)
      browser.goto(`${base}/settings/agents`)
      browser.waitForFunction(`document.querySelector('${sidebar} [data-section="agents"][aria-current="page"]') !== null`)
      browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
      const facts = browser.waitForValue(`(() => {
        const row = document.querySelector('${sidebar} [data-section="agents"]');
        const nav = document.querySelector('${sidebar}');
        if (!row || !nav) return null;
        return { height: row.getBoundingClientRect().height, groups: [...nav.querySelectorAll('nav')].map(n => n.dataset.scope),
          duplicate: document.querySelector('[data-slot="main"] [data-slot="settings-nav"]') !== null,
          taskList: document.querySelector('[data-slot="task-quick-list"]') !== null };
      })()`)
      expect(facts).toEqual({ height: 32, groups: ['project', 'global'], duplicate: false, taskList: false })
      // Board "Screen · Settings view, sections": 12px body padding and gap, no heading, a General
      // row leading the project group only (owner request, beyond the board), and a one-line "<Section> · <project>" main header with a rule below (15/600, 16/28).
      const board = browser.waitForValue(`(() => {
        const nav = document.querySelector('${sidebar}'); const header = document.querySelector('[data-slot="settings-main-header"]');
        if (!nav || !header) return null;
        const h1 = header.querySelector('h1'); const hs = getComputedStyle(header); const ns = getComputedStyle(nav);
        // The shell's list container owns the 12px inset; the body only spaces its groups.
        return { pad: getComputedStyle(nav.closest('[data-slot="project-task-navigation"]')).padding, gap: ns.rowGap, heading: nav.querySelector('h2') !== null,
          rows: [...nav.querySelectorAll('nav')].map(n => [...n.querySelectorAll('a')].map(a => a.textContent)),
          headerPad: hs.padding, rule: hs.borderBottomWidth, title: h1.innerText.startsWith('Agents · '),
          titleSize: getComputedStyle(h1).fontSize, titleWeight: getComputedStyle(h1).fontWeight };
      })()`)
      expect(board).toEqual({
        pad: '12px', gap: '12px', heading: false,
        rows: [['General', 'Agents', 'Agent config', 'Worktrees', 'Bookmarklets', 'Prompt templates'], ['Appearance', 'Notifications', 'Resources', 'Skills', 'Agent accounts', 'Projects']],
        headerPad: '16px 28px', rule: '1px', title: true, titleSize: '15px', titleWeight: '600',
      })
      browser.screenshot(`${artifacts}/settings-sidebar-${theme}.png`, { viewport: true })
      browser.click(`${sidebar} [data-section="appearance"]`)
      expect(browser.waitForValue(`document.querySelector('${sidebar} [data-section="appearance"][aria-current="page"]')?.getAttribute('href')`)).toBe('/settings/global/appearance')
      browser.waitForFunction(`document.querySelector('[data-route="settings-global-appearance"]') !== null`)
      browser.goto(`${base}/settings/global/appearance`)
      browser.waitForFunction(`document.querySelector('${sidebar} [data-section="appearance"][aria-current="page"]') !== null`)
      // The project index has its own sidebar row, General, and the Settings view tab lands there too.
      browser.click(`${sidebar} [data-section="general"]`)
      browser.waitForFunction(`document.querySelector('[data-route="settings"]') !== null`)
      expect(browser.waitForValue(`document.querySelector('${sidebar} [aria-current="page"]')?.dataset.section`)).toBe('general')
      // In-app, not a goto: right after a cold load the view tabs are still settling, and a
      // click there landed on Workflows (failure bundle light-navigates-…-2, probe.json).
      browser.click(`${sidebar} [data-section="agents"]`)
      browser.waitForFunction(`document.querySelector('[data-route="settings-agents"]') !== null`)
      browser.click('[data-slot="view-tabs"] a[aria-label="Settings"]')
      expect(browser.waitForValue(`document.querySelector('[data-route="settings"]') && document.querySelector('${sidebar} [aria-current="page"]')?.dataset.section`)).toBe('general')
      browser.click('[data-slot="view-tabs"] a[aria-label="Tasks"]')
      browser.waitForFunction(`document.querySelector('[data-slot="task-quick-list"]') !== null && document.querySelector('${sidebar}') === null`)
    })
  }

  it('keeps the mobile section picker and index cards at 360px', () => {
    browser.setViewport(360, 640)
    browser.goto(`${base}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-route="settings-global-appearance"]') !== null`)
    browser.click('.settings-section-picker summary')
    browser.click('[data-slot="settings-nav-mobile"] [data-section="resources"]')
    browser.waitForFunction(`document.querySelector('[data-route="settings-global-resources"]') !== null`)
    const facts = browser.waitForValue(`(() => {
      const picker = document.querySelector('.settings-section-picker');
      if (!picker || picker.querySelector('summary')?.textContent !== 'Resources') return null;
      return { open: picker.open, sidebarHidden: getComputedStyle(document.querySelector('[data-slot="sidebar"]')).display === 'none',
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`)
    expect(facts).toEqual({ open: false, sidebarHidden: true, overflow: false })
    // The global area has no index, so its picker has no General entry; the project one does.
    expect(browser.count('[data-slot="settings-nav-mobile"] [data-slot="settings-nav-index"]')).toBe(0)
    browser.goto(`${base}/settings/agents`)
    browser.waitForFunction(`document.querySelector('[data-route="settings-agents"]') !== null`)
    browser.click('.settings-section-picker summary')
    browser.click('[data-slot="settings-nav-mobile"] [data-slot="settings-nav-index"]')
    browser.waitForFunction(`document.querySelector('[data-route="settings"]') !== null`)
    expect(browser.isVisible('[data-slot="settings-index"]')).toBe(true)
    browser.screenshot(`${artifacts}/settings-sidebar-mobile.png`, { viewport: true })
  })
})
