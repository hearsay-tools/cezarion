import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser } from './agent-browser'
import { createTabFixture } from './tab-fixture'

let fixture: Awaited<ReturnType<typeof createTabFixture>>
let browser: AgentBrowser
beforeAll(async () => {
  fixture = await createTabFixture(process.cwd(), { taskList: 'project', taskListSizes: { active: 150, archived: 0, projects: 1 } })
  browser = AgentBrowser.open(`task-list-virtual-${process.pid}`)
  browser.setViewport(1440, 900)
  browser.goto(`${fixture.origin}/p/boot/?tasks=virtual`)
  browser.waitForFunction(`document.querySelector('[data-virtualized="true"] [data-slot="task-summary-row"]') !== null`)
})
afterAll(async () => { browser?.close(); await fixture?.stop() })

it('bounds rows, preserves focused controls and expansion, and follows pathname scroll rules', () => {
  const count = browser.waitForValue(`document.querySelectorAll('[data-slot="task-summary-row"]').length`) as number
  expect(count).toBeGreaterThan(0)
  expect(count).toBeLessThan(150)
  const first = browser.waitForValue(`document.querySelector('[data-slot="task-summary-row"]').dataset.runId`) as string
  const row = `[data-slot="task-summary-row"][data-run-id="${first}"]`
  browser.click(`${row} button[aria-label^="Show resources"]`)
  browser.waitForFunction(`document.querySelector('${row} button[aria-expanded="true"]') !== null`)
  // Focus is pinned with its keyboard neighbours even when the viewport moves far away.
  browser.evaluate(`document.querySelector('${row} a').focus();document.querySelector('[data-slot="main"]').scrollTop=7000`)
  expect(browser.waitForValue(`document.activeElement?.closest('[data-run-id]')?.dataset.runId`)).toBe(first)
  browser.waitForFunction(`document.querySelector('[data-slot="main"]').scrollTop > 1000`)
  expect(browser.waitForValue(`document.querySelector('${row}') !== null`)).toBe(true)
  browser.evaluate(`document.querySelector('input[aria-label="Search tasks"]').focus();document.querySelector('[data-slot="main"]').scrollTop=7000`)
  browser.waitForFunction(`document.querySelector('${row}') === null`)
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=0`)
  browser.waitForFunction(`document.querySelector('${row} button[aria-expanded="true"]') !== null`)
  browser.click(`${row} [data-slot="row-rename"]`)
  browser.fill(`${row} input[aria-label="Task title"]`, 'Pinned rename draft')
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=7000`)
  expect(browser.waitForValue(`document.activeElement?.value`)).toBe('Pinned rename draft')
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=0`)
  browser.click(`${row} button[aria-label="Cancel rename"]`)
  // The measurement override is a query change: it must retain the page offset.
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=500`)
  browser.evaluate(`history.replaceState(null,'','?tasks=flat');window.dispatchEvent(new PopStateEvent('popstate'))`)
  browser.waitForFunction(`document.querySelector('[data-virtualized="false"]') !== null`)
  expect(browser.waitForValue(`document.querySelector('[data-slot="main"]').scrollTop`)).toBeGreaterThan(0)
  browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop=0`)
  browser.click(`${row} a`)
  browser.waitForFunction(`location.pathname.endsWith('/tasks/${first}')`)
  expect(browser.waitForValue(`document.querySelector('[data-slot="main"]').scrollTop`)).toBe(0)
})
