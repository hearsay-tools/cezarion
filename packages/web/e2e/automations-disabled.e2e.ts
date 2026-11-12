import { type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
// fixture-server starts: 1

let root: string
let server: ChildProcess
let browser: AgentBrowser
let base: string
let project: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-automations-disabled-'))
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_AUTOMATIONS: '0' }), stdio: 'ignore',
  })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`e2e-automations-disabled-${process.pid}`)
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

it('hides automations and refuses its API only with the explicit opt-out', async () => {
  browser.goto(`${base}/p/${project}/automations`)
  browser.waitForFunction(`document.body.textContent.includes('Automations are off')`)
  expect(browser.text('main')).toContain('Unset CEZ_AUTOMATIONS')
  expect(browser.count('[data-slot="sidebar"] a[href$="/automations"]')).toBe(0)
  const refused = await fetch(`${base}/api/v1/automations`)
  expect(refused.status).toBe(409)
  expect(((await refused.json()) as { error: string }).error).toContain('unset CEZ_AUTOMATIONS')
}, 60_000)
