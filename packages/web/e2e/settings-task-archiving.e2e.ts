import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser, readTestEnv } from './agent-browser'
import { waitForConfig } from './poll'
import { waitForSettledSample } from './visual-ready'

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const field = '[data-slot="archive-on-merge-field"]'
const select = `${field} select`
let browser: AgentBrowser, base: string
let previousProject: boolean | null, previousGlobal: boolean | null
const patch = (path: string, archiveOnMerge: boolean | null) => fetch(`${base}/api/v1/${path}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ archiveOnMerge }),
})
beforeAll(async () => {
  base = readTestEnv().baseUrl
  previousProject = (await (await fetch(`${base}/api/v1/config`)).json()).archiveOnMerge
  previousGlobal = (await (await fetch(`${base}/api/v1/workspace/config`)).json()).archiveOnMerge
  await patch('config', null); await patch('workspace/config', false)
  mkdirSync(artifacts, { recursive: true })
  browser = AgentBrowser.open(`task-archiving-${process.pid}`)
})
afterAll(async () => {
  await patch('config', previousProject); await patch('workspace/config', previousGlobal)
  browser?.close()
})
function choose(index: number) {
  // The config write can be persisted while its UI save is still pending, and the select stays disabled.
  browser.waitForFunction(`document.querySelector('${select}')?.disabled === false`)
  browser.click(select); browser.press('Home')
  for (let i = 0; i < index; i++) browser.press('ArrowDown')
  browser.press('Enter')
  browser.waitForFunction(`document.querySelector('${select}')?.disabled === false`)
}
it('persists project overrides and inheritance at 360px in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    browser.setViewport(360, 640)
    browser.goto(`${base}/settings`)
    browser.waitForFunction(`document.querySelector('${select}') !== null`)
    browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
    choose(2)
    const explicit = await waitForConfig<{ archiveOnMerge: boolean | null; effectiveArchiveOnMerge: boolean; archiveOnMergeSource: string }>(base, c => c.archiveOnMerge === false, 'disabled task archiving')
    expect(explicit.archiveOnMergeSource).toBe('project')
    choose(0)
    const inherited = await waitForConfig<{ archiveOnMerge: boolean | null; effectiveArchiveOnMerge: boolean; archiveOnMergeSource: string }>(base, c => c.archiveOnMerge === null, 'inherited task archiving')
    expect(inherited).toMatchObject({ effectiveArchiveOnMerge: false, archiveOnMergeSource: 'global' })
    const layout = waitForSettledSample(browser, `(() => {
      const control = document.querySelector('${select}');
      if (!control) return null;
      return { height: control.getBoundingClientRect().height, labelled: !!document.querySelector('label[for="' + control.id + '"]'), overflow: document.documentElement.scrollWidth > innerWidth };
    })()`)
    expect(layout).toMatchObject({ labelled: true, overflow: false })
    expect((layout as { height: number }).height).toBeGreaterThanOrEqual(44)
    browser.screenshot(`${artifacts}/task-archiving-${theme}-360.png`, { viewport: true })
  }
})
it('exposes the global Tasks section and its persisted source', () => {
  browser.setViewport(1440, 900)
  browser.goto(`${base}/settings/global/tasks`)
  expect(browser.waitForValue(`document.querySelector('${field}')?.textContent`, value => typeof value === 'string' && value.includes('global setting'))).toContain('Currently disabled')
  const layout = waitForSettledSample(browser, `document.documentElement.scrollWidth <= innerWidth`)
  expect(layout).toBe(true)
  browser.screenshot(`${artifacts}/task-archiving-global.png`, { viewport: true })
})
