import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { waitForSettledSample } from './visual-ready'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { focusWithKeyboard } from './contrast'
// fixture-server starts: 1

/**
 * Project tasks and All tasks as status groups with an origin filter (hearsay-tools/cezarion#1616):
 * the same groups, dots, origin chips and origin lines on both pages, at a phone and a desktop
 * width, in both themes.
 */

let browser: AgentBrowser
let server: ChildProcess
let root: string
let baseUrl: string
let project: string
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/task-status-groups')
const group = (label: string) => `[data-slot="task-status-group"][data-bucket="${label}"]`
const chip = (origin: string) => `[data-slot="origin-filter"] [data-origin="${origin}"]`
const fixture = (id: string, status: RunRecord['status'], extra: Partial<RunRecord> = {}): RunRecord => ({
  id, title: `Groups ${id}`, task: `Groups ${id}`, workflow: 'quick-task', status,
  archived: false, createdAt: '2026-10-20T10:00:00Z', tokensUsed: 0, steps: [], ...extra,
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-groups-'))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([
    fixture('review', 'review'),
    fixture('done', 'done'),
    fixture('failed', 'failed'),
    fixture('nightly', 'done', {
      automationTrigger: { automationId: 'nightly-sweep', automationRevision: 1, receiptId: 'r1', trigger: 'schedule', occurrenceAt: '2026-10-20T04:00:00Z' },
    }),
    fixture('old', 'done', { archived: true }),
  ]))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`groups-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
})

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

const pages = [
  { name: 'project', path: () => `/p/${project}/`, row: '[data-slot="task-card"], [data-slot="tasks-table"] tbody tr' },
  { name: 'global', path: () => '/tasks', row: '[data-slot="global-task-row"]' },
]

describe('task status groups and origin filter', () => {
  for (const page of pages) for (const width of [360, 1440]) for (const theme of ['light', 'dark']) {
    it(`groups ${page.name} tasks by status and filters by origin at ${width} ${theme}`, () => {
      browser.setViewport(width, width === 360 ? 640 : 900)
      browser.goto(`${baseUrl}${page.path()}`)
      browser.waitForFunction(`document.querySelector('${group('Finished')}') !== null`)
      browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'}); document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)

      // Needs you is yellow; Finished turns red because it holds a failure.
      expect(browser.waitForValue(`[...document.querySelectorAll('[data-slot="task-status-group"]')].map(g => g.dataset.bucket + ':' + g.dataset.tone).join(',')`,
        (value: string) => value === 'Needs you:pending,Finished:danger')).toBe('Needs you:pending,Finished:danger')
      expect(browser.text(`${group('Finished')} [data-slot="status-group-toggle"]`)).toContain('3')

      // The origin line names the automation's recorded id when no definition exists.
      expect(browser.text('body')).toContain('nightly-sweep')

      browser.click(chip('automations'))
      expect(browser.waitForValue(`document.querySelectorAll('[data-slot="task-status-group"]').length`, (count: number) => count === 1)).toBe(1)
      expect(browser.waitForValue('location.search', (search: string) => search.includes('origin=automations'))).toContain('origin=automations')
      expect(browser.text(group('Finished'))).toContain('Groups nightly')
      expect(browser.text(group('Finished'))).not.toContain('Groups done')

      // Nothing overflows, and the origin chips and group headings are 44px targets on a phone.
      const bounds = waitForSettledSample(browser, `(() => {
        const nodes = [...document.querySelectorAll('[data-slot="origin-filter"] button, [data-slot="status-group-toggle"]')].filter(el => el.checkVisibility());
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          small: nodes.filter(el => { const r = el.getBoundingClientRect(); return r.right > innerWidth || r.left < 0 || r.height < 44; }).map(el => el.textContent),
        };
      })()`) as { overflow: boolean; small: string[] }
      expect(bounds.overflow).toBe(false)
      if (width === 360) expect(bounds.small).toEqual([])

      focusWithKeyboard(browser, `${group('Finished')} [data-slot="status-group-toggle"]`)
      browser.press('Enter')
      expect(browser.waitForValue(`document.querySelector('${group('Finished')}').dataset.folded`, (folded: string) => folded === 'true')).toBe('true')
      browser.screenshot(join(artifacts, `${page.name}-${width}-${theme}.png`), { viewport: true })
      browser.press('Enter')
      expect(browser.waitForValue(`document.querySelector('${group('Finished')}').dataset.folded`, (folded: string) => folded === 'false')).toBe('false')
      browser.click(chip('all'))
      browser.waitForFunction(`!location.search.includes('origin=')`)
    })
  }
})
