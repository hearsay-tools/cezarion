import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, readTestEnv } from './agent-browser'

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/inbox-retirement')
let browser: AgentBrowser
let base: string
beforeAll(() => {
  base = readTestEnv().baseUrl
  browser = AgentBrowser.open(`inbox-retirement-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
})
afterAll(() => browser?.close())
describe('removed generated inbox', () => {
  for (const width of [1440, 360]) for (const theme of ['light', 'dark']) {
    it(`shows file-export guidance at ${width}px in ${theme}`, () => {
      browser.setViewport(width, 640)
      browser.goto(`${base}/inbox`)
      browser.waitForFunction(`document.querySelector('[data-route="inbox"] h1')?.textContent === 'Inbox has been removed' && window.__cezIdle === true`)
      browser.evaluate(`document.documentElement.classList.toggle('light', '${theme}' === 'light'); document.documentElement.classList.toggle('dark', '${theme}' === 'dark')`)
      expect(browser.text('[data-route="inbox"]')).toContain('cp .ai/cezar/todos.json ./cezar-followups-export.json')
      expect(browser.count('[data-slot="todo-card"], [data-slot="inbox-count"]')).toBe(0)
      expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
      browser.screenshot(`${artifacts}/${width}-${theme}.png`)
      browser.click('[data-route="inbox"] a')
      browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
      expect(browser.count('[data-slot="generate-followups-toggle"]')).toBe(0)
    })
  }
})
