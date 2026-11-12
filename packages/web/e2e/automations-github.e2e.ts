import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { pollFor, pollJson } from './poll'
// fixture-server starts: 1

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let root: string
let server: ChildProcess
let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let ghCalls: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-automations-github-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture')
  git('remote', 'add', 'origin', 'https://github.com/example/automation-fixture.git')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  ghCalls = join(root, 'gh-calls.ndjson')
  // Dry-run mocks agent CLIs and forge lists, but the automation poller still invokes gh.
  // This fixture supplies only an empty search response and refuses every other command.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const { appendFileSync } = await import('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghCalls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args.includes('/search/issues')) process.stdout.write('{"items":[]}');
else { process.stderr.write('Unexpected fixture gh command'); process.exitCode = 1; }
`, { mode: 0o755 })
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }), stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`e2e-automations-github-${process.pid}`)
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('GitHub automations on a default-on fixture server', () => {
  it('creates a GitHub check paused, previews safely, enables from a baseline, and exposes the log', async () => {
    const name = `E2E issue triage ${process.pid}`
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    // The editor opens on the schedule kind; this journey is the GitHub one.
    browser.click('[data-slot="automation-kind"] [data-value="github"]')
    browser.fill('#automation-name', name)
    browser.fill('#automation-prompt', 'Triage {{github.url}}')
    browser.click('button[type="submit"]')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/automations'`)

    const created = await fetch(`${baseUrl}/api/v1/automations`).then((response) => response.json()) as {
      automations: Array<{ id: string; name: string; enabled: boolean }>
    }
    const automation = created.automations.find((item) => item.name === name)
    expect(automation).toMatchObject({ enabled: false })
    const automationId = automation!.id
    browser.waitForFunction(`document.body.textContent.includes('${name}') && document.body.textContent.includes('Paused')`)

    const preview = await fetch(`${baseUrl}/api/v1/automations/${automationId}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    }).then((response) => response.json()) as { checkId: string }
    const check = await pollFor(async signal => {
      const check = await pollJson<{ status: string; matches?: number; error?: string | undefined }>(`${baseUrl}/api/v1/automation-checks/${preview.checkId}`, signal)
      return ['complete', 'error'].includes(check.status) ? check : undefined
    }, () => `automation check ${preview.checkId} never completed`, { timeoutMs: 30_000, intervalMs: 500 })
    expect(check.status, check.error).toBe('complete')
    expect(check.matches).toBe(0)
    expect(readFileSync(ghCalls, 'utf8')).toContain('/search/issues')

    await fetch(`${baseUrl}/api/v1/automations/${automationId}/enable`, { method: 'POST' })
    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.body.textContent.includes('${name}') && document.body.textContent.includes('Enabled')`)
    browser.screenshot(`${artifactsDir}/automations-enabled.png`)

    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automationId}/log`)
    browser.waitForFunction(`document.body.textContent.includes('Execution log') && document.body.textContent.includes('Enabled from a current-time baseline')`)
    expect(browser.text('main')).toContain('Baseline')
    expect(browser.text('main')).toContain('Preview')
    browser.screenshot(`${artifactsDir}/automations-execution-log.png`)
  }, 60_000)
})
