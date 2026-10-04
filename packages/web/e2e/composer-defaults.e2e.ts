import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiRun, CreateRunInput, RunRecord, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'

import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'
import { pollFor } from './poll'

const sessionId = `e2e-composer-defaults-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

async function putDefaults(autonomous: boolean | null, worktree: boolean | null): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ composerDefaults: { autonomous, worktree } }),
  })
  if (!response.ok) throw new Error(`workspace config update failed: ${response.status}`)
}

function choose(selector: string, value: string): void {
  browser.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLSelectElement)) throw new Error('select not found')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-composer-defaults-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# composer defaults fixture\n', 'utf8')
  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/skills/interactive-review.md'),
    '---\ndescription: Review a proposal with the user\ninteractive: true\n---\n\nAsk questions before writing the review.\n',
    'utf8',
  )
  writeFileSync(join(dataRoot, '.ai/skills/setup.md'),
    '---\ndescription: Set up SDLC\n---\n\nSet up this project.\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'],
    { env: { ...fixtureServeEnv(dataRoot), CEZ_AUTONOMOUS_DEFAULT: '' }, stdio: 'ignore' },
  )
  baseUrl = await waitForFixtureServer(server)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('configurable composer run defaults', () => {
  it('covers cold, interactive, and persisted workspace defaults', async () => {
    await putDefaults(null, null)
    try {
      browser.goto(`${baseUrl}/p/${bootProject}/new`)
      // A cold composer picks nothing: the source pill is the empty invitation, and the run it
      // would start is the plain built-in quick-task. Wait on the LABEL, not on the kind — an
      // unpicked pill reports `none` while it is still showing its loading ellipsis.
      browser.waitForFunction(
        `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('Skill')`,
      )
      expect(browser.evaluate(
        `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind`,
      )).toBe('none')
      expect(browser.evaluate(
        `document.querySelector('[data-slot="worktree-toggle"]')?.getAttribute('aria-checked')`,
      )).toBe('true')
      expect(browser.evaluate(
        `document.querySelector('[data-slot="autonomous-toggle"]')?.getAttribute('aria-checked')`,
      )).toBe('false')

      browser.click('[data-slot="source-pill"]')
      browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
      browser.waitForFunction(
        `document.querySelector('[data-slot="source-option"][data-source-ref="interactive-review"]') !== null`,
      )
      browser.evaluate(`{
        const item = document.querySelector('[data-slot="source-option"][data-source-ref="interactive-review"]')
        const label = item.querySelector('span')
        label.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        label.click()
      }`)
      browser.waitForFunction(
        `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind === 'skill'`,
      )
      browser.evaluate(`{ const el = document.querySelector('[data-slot="execution-options"]'); if (el) el.open = true }`)
      expect(browser.evaluate(`document.querySelector('[data-slot="execution-options"]')?.open`)).toBe(true)
      for (const slot of ['worktree-toggle', 'autonomous-toggle']) {
        expect(browser.evaluate(
          `document.querySelector('[data-slot="${slot}"]')?.disabled`,
        )).toBe(false)
        if (browser.evaluate(
          `document.querySelector('[data-slot="${slot}"]')?.getAttribute('aria-checked')`,
        ) !== 'true') {
          browser.click(`[data-slot="${slot}"]`)
        }
        expect(browser.evaluate(
          `document.querySelector('[data-slot="${slot}"]')?.getAttribute('aria-checked')`,
        )).toBe('true')
      }

      browser.goto(`${baseUrl}/settings/global/resources`)
      browser.waitForFunction(
        `document.querySelector('[data-slot="resources-composer-defaults"]') !== null`,
      )
      choose('[aria-label="Autonomous by default"]', 'on')
      browser.waitForFunction(
        `document.querySelector('[aria-label="Autonomous by default"]')?.value === 'on'`,
      )
      browser.goto(`${baseUrl}/settings/global/resources`)
      browser.waitForFunction(
        `document.querySelector('[aria-label="Autonomous by default"]')?.value === 'on'`,
      )
      const config = (await (await fetch(`${baseUrl}/api/v1/workspace/config`)).json()) as {
        composerDefaults: { autonomous: boolean | null }
      }
      expect(config.composerDefaults.autonomous).toBe(true)
    } finally {
      await putDefaults(null, null)
    }
  })

  it.each([
    { choice: 'unset', clicks: 0, expected: true },
    { choice: 'off', clicks: 1, expected: false },
    { choice: 'on', clicks: 2, expected: true },
  ])('/setup $choice: toggle, request and saved record agree (#458)', async ({ clicks, expected }) => {
    await putDefaults(null, null)
    const defaults = await getJson<WorkspaceConfigResponse>(`${baseUrl}/api/v1/workspace/config`)
    expect(defaults.composerDefaults.inheritedAutonomous).toBe('source-dependent')
    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)
    browser.evaluate(`localStorage.removeItem('cez-new-task-draft')`)
    // A full navigation resets the in-memory draft as well as browser storage.
    browser.goto(`${baseUrl}/p/${bootProject}/new?skill=setup`)
    browser.waitForFunction(`document.querySelector('[data-slot="source-pill"]')?.textContent.includes('setup')`)
    browser.evaluate(`{ document.querySelector('[data-slot="execution-options"]').open = true }`)
    browser.waitForFunction(`document.querySelector('[data-slot="autonomous-toggle"]')?.getAttribute('aria-checked') === 'true'`)
    for (let i = 0; i < clicks; i++) browser.click('[data-slot="autonomous-toggle"]')
    expect(browser.waitForValue(
      `document.querySelector('[data-slot="autonomous-toggle"]')?.getAttribute('aria-checked')`,
      value => value === String(expected),
    )).toBe(String(expected))
    // Retained draft choices survive a real reload, including an explicit false.
    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="source-pill"]')?.textContent.includes('setup')`)
    expect(browser.waitForValue(
      `document.querySelector('[data-slot="autonomous-toggle"]')?.getAttribute('aria-checked')`,
      value => value === String(expected),
    )).toBe(String(expected))
    // Observe the real fetch without changing its body, response or destination.
    browser.evaluate(`(() => {
      const original = window.fetch.bind(window)
      window.fetch = (input, init) => {
        if (init?.method === 'POST' && String(input).endsWith('/runs')) {
          window.__autonomousLaunch = JSON.parse(init.body)
        }
        return original(input, init)
      }
    })()`)
    browser.fill('[data-slot="composer"] textarea', 'Set up SDLC for this project')
    browser.click('[aria-label="Start task"]')
    const pathname = browser.waitForValue('location.pathname', value => typeof value === 'string' && value.includes('/tasks/')) as string
    const runId = pathname.split('/').pop()!
    const payload = browser.evaluate('window.__autonomousLaunch') as CreateRunInput
    expect(payload.autonomous).toBe(expected ? true : undefined)
    const record = await getJson<ApiRun>(
      `${baseUrl}/api/v1/runs/${runId}`,
    )
    expect(record.autonomous).toBe(expected)
    expect(record.workflowDef?.steps[0]?.skill).toBe('setup')
    // API agreement alone could miss a store write regression; inspect the flushed index too.
    await pollFor(() => {
      const records = JSON.parse(readFileSync(join(dataRoot, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[]
      return records.find(run => run.id === runId)?.autonomous === expected ? true : undefined
    }, () => `Run ${runId} did not persist autonomous=${expected}`)
  }, 90_000)
})
