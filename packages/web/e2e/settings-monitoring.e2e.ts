import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv, getJson } from './agent-browser'
import { stopFixtureServer } from './fixture-server'
import { pollFor, waitForHealth } from './poll'

/**
 * Global Resources monitoring controls against an isolated fixture server.
 *
 * The shared dry-run env's `CEZ_HOME` is mutated by preceding browser specs, and a client
 * navigation is not a reboot — #232 failed with `maxMonitoringSessions` still at 2 after the
 * UI dispatched 3. This spec owns its workspace config, captures the PUT, and kills/restarts
 * the process so restore is proven from disk.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-monitoring-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }

interface WorkspaceResources {
  maxMonitoringSessions: number
  monitoringWakeIntervalMinutes: number | null
}

interface WorkspaceConfig {
  resources: WorkspaceResources
}

type MutationRecord = { status: number; body: string }

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let cezHome: string
let baseUrl: string
let port: number

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const nextPort = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(nextPort))
    })
  })
}


function startServer(): ChildProcess {
  return spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
}

async function workspaceConfig(): Promise<WorkspaceConfig> {
  return getJson<WorkspaceConfig>(`${baseUrl}/api/v1/workspace/config`)
}

function diskResources(): string {
  const path = join(cezHome, 'config.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { resources?: unknown }
    return JSON.stringify(parsed.resources ?? null)
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

function mutations(): MutationRecord[] {
  return (browser.evaluate(`window.__cezWorkspaceMutations ?? []`) as MutationRecord[] | null) ?? []
}

function mutationFailure(label: string, stored: WorkspaceResources): string {
  return `${label}: stored=${JSON.stringify(stored)} mutations=${JSON.stringify(mutations())} disk=${diskResources()}`
}

async function waitForResources(
  check: (resources: WorkspaceResources) => boolean,
  label: string,
): Promise<WorkspaceConfig> {
  const stored = await pollFor(
    async () => {
      const resources = (await workspaceConfig()).resources
      return check(resources) ? resources : undefined
    },
    async () => mutationFailure(label, (await workspaceConfig()).resources),
  )
  return { resources: stored }
}

function installMutationSpy(): void {
  browser.evaluate(`(() => {
    if (window.__cezWorkspaceMutations) return true
    window.__cezWorkspaceMutations = []
    const orig = window.fetch.bind(window)
    window.fetch = async (input, init = {}) => {
      const res = await orig(input, init)
      const url = typeof input === 'string' ? input : (input && input.url) || String(input)
      const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
      if (String(url).includes('/workspace/config') && method === 'PUT') {
        window.__cezWorkspaceMutations.push({ status: res.status, body: await res.clone().text() })
      }
      return res
    }
    return true
  })()`)
}

async function waitForPut(
  check: (parsed: unknown, status: number) => boolean,
  label: string,
): Promise<MutationRecord> {
  const matched = await pollFor(
    () => {
      for (const mutation of mutations()) {
        let parsed: unknown = mutation.body
        try {
          parsed = JSON.parse(mutation.body) as unknown
        } catch {
          // Keep the raw body when the server did not answer JSON.
        }
        if (check(parsed, mutation.status)) return mutation
      }
      return undefined
    },
    async () => mutationFailure(`${label} PUT never observed`, (await workspaceConfig()).resources),
  )
  // A matching PUT that failed is a failure of this spec, not something to keep polling for.
  if (matched.status < 200 || matched.status >= 300) {
    throw new Error(mutationFailure(`${label} PUT ${matched.status} ${matched.body}`, (await workspaceConfig()).resources))
  }
  return matched
}

function choose(selector: string, value: string): void {
  browser.waitForFunction(
    `document.querySelector(${JSON.stringify(`${selector}:not([disabled])`)}) instanceof HTMLSelectElement`,
  )
  browser.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLSelectElement)) throw new Error('select not found')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

function gotoResources(): void {
  browser.goto(`${baseUrl}/settings/global/resources`)
  browser.waitForFunction(`document.querySelector('[data-slot="resources-section"]') !== null`)
  installMutationSpy()
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-settings-monitoring-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# monitoring settings fixture\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  cezHome = join(dataRoot, '.cez-home')
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(
    join(cezHome, 'config.json'),
    `${JSON.stringify({
      resources: {
        maxParallel: 2,
        maxMonitoringSessions: 2,
        monitoringWakeIntervalMinutes: null,
      },
    }, null, 2)}\n`,
    'utf8',
  )

  port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = startServer()
  await waitForHealth(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('global Resources monitoring controls', () => {
  it('persists capacity and interval mode through a cold reload', async () => {
    gotoResources()
    expect((await workspaceConfig()).resources.maxMonitoringSessions).toBe(2)

    choose('[data-slot="resources-max-monitoring"]', '3')
    await waitForPut((parsed) => {
      const resources = (parsed as { resources?: { maxMonitoringSessions?: number } }).resources
      return resources?.maxMonitoringSessions === 3
    }, 'capacity')
    await waitForResources((resources) => resources.maxMonitoringSessions === 3, 'capacity')

    if (browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-mode"]').getAttribute('aria-checked')`) !== 'true') {
      browser.click('[data-slot="resources-monitoring-wake-mode"]')
    }
    browser.waitForFunction(`document.querySelector('[data-slot="resources-monitoring-wake-interval"]:not([disabled])') !== null`)
    browser.fill('[data-slot="resources-monitoring-wake-interval"]', '7')
    browser.waitForFunction(`document.querySelector('[data-slot="resources-monitoring-wake-interval"]').value === '7'`)
    browser.waitForFunction(`document.querySelector('[data-action="resources-save-monitoring-wake"]:not([disabled])') !== null`)
    browser.click('[data-action="resources-save-monitoring-wake"]')
    await waitForPut((parsed) => {
      const resources = (parsed as { resources?: { monitoringWakeIntervalMinutes?: number | null } }).resources
      return resources?.monitoringWakeIntervalMinutes === 7
    }, 'interval')
    await waitForResources((resources) => resources.monitoringWakeIntervalMinutes === 7, 'interval')

    await stopFixtureServer(server)
    server = startServer()
    await waitForHealth(baseUrl)
    const restored = (await workspaceConfig()).resources
    expect(restored.maxMonitoringSessions, mutationFailure('cold GET capacity', restored)).toBe(3)
    expect(restored.monitoringWakeIntervalMinutes, mutationFailure('cold GET interval', restored)).toBe(7)

    gotoResources()
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-max-monitoring"]').value`))).toBe('3')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-mode"]').getAttribute('aria-checked')`))).toBe('true')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-interval"]').value`))).toBe('7')
    expect(browser.text('[data-slot="resources-section"]')).toContain('Capacity:')
    expect(browser.text('[data-slot="resources-section"]')).toContain('3 monitoring')
    browser.screenshot(`${artifactsDir}/settings-monitoring-controls.png`)
  })
})
