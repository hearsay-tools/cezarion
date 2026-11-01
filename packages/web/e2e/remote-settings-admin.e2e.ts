import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
// fixture-server starts: 1

/**
 * Remote settings administration (hearsay-tools/cezarion#2428): a remote cockpit (CEZ_REMOTE=1)
 * shows Agent config and worktree setup read-only until the host operator runs
 * `cez remote-settings enable`, then edits both under a warning, and is read-only again after
 * `disable`. The switch is the host CLI, never a browser action.
 */

let root: string
let env: NodeJS.ProcessEnv
let server: ChildProcess
let url: string
let project: string
let browser: AgentBrowser

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-remote-settings-'))
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' })
  execFileSync('git', ['-C', root, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' })
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  env = fixtureServeEnv(root, { CEZ_REMOTE: '1' })
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], { env, stdio: 'ignore' })
  url = await waitForFixtureServer(server)
  project = await bootProjectId(url)
  browser = AgentBrowser.open(`remote-settings-${process.pid}`)
})
afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  rmSync(root, { recursive: true, force: true })
})

/** The grant names this cockpit's listen port: the fixture listens on a random one. */
function hostSwitch(command: 'enable' | 'disable') {
  execFileSync(process.execPath, [cezarCli, 'remote-settings', command, '--port', new URL(url).port], { env, stdio: 'ignore' })
}

function openAgentConfig() {
  browser.goto(`${url}/p/${project}/settings/agent-config`)
  browser.waitForFunction(`document.querySelector('[data-slot="agent-config-agents"]') !== null`)
}

function openWorktrees() {
  browser.goto(`${url}/p/${project}/settings/worktrees`)
  browser.waitForFunction(`document.querySelector('[data-slot="worktree-setup-commands"]') !== null`)
}

const commandsReadOnly = `document.querySelector('[data-slot="worktree-setup-commands"]')?.readOnly`
const notice = `document.querySelector('[data-slot="remote-settings-notice"]')?.textContent ?? null`

describe('remote settings administration', () => {
  it('stays read-only by default, edits under a warning once enabled, and is read-only again after disable', () => {
    browser.setViewport(390, 844)

    openAgentConfig()
    expect(browser.waitForValue(`document.querySelector('[data-slot="agent-config-readonly"]')?.textContent`, value => typeof value === 'string'))
      .toContain('cez remote-settings enable')
    expect(browser.evaluate(notice)).toBeNull()
    openWorktrees()
    expect(browser.waitForValue(commandsReadOnly, value => value === true)).toBe(true)
    expect(browser.waitForValue(`document.querySelector('[data-slot="worktree-setup-readonly"]')?.textContent`, value => typeof value === 'string'))
      .toContain('cez remote-settings enable')

    hostSwitch('enable')
    openAgentConfig()
    expect(browser.waitForValue(notice, value => typeof value === 'string')).toContain('hooks and MCP servers')
    expect(browser.evaluate(`document.querySelector('[data-slot="agent-config-readonly"]')`)).toBeNull()
    openWorktrees()
    expect(browser.waitForValue(commandsReadOnly, value => value === false)).toBe(false)
    expect(browser.waitForValue(notice, value => typeof value === 'string')).toContain('These commands run on the machine running Cezarion')
    browser.fill('[data-slot="worktree-setup-commands"]', 'npm ci')
    browser.click('[data-action="worktree-setup-save"]')
    expect(browser.waitForValue(`document.querySelector('[data-action="worktree-setup-save"]')?.disabled`, value => value === true)).toBe(true)

    hostSwitch('disable')
    openWorktrees()
    expect(browser.waitForValue(commandsReadOnly, value => value === true)).toBe(true)
    expect(browser.waitForValue(`document.querySelector('[data-slot="worktree-setup-commands"]')?.value`, value => value === 'npm ci')).toBe('npm ci')
    expect(browser.evaluate(notice)).toBeNull()
  })
})
