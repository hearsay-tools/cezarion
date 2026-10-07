import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'
import { waitForConfig, waitForStatus } from './poll'

/**
 * Worktree setup (hearsay-tools/cezarion#917, spec `.ai/specs/2026-10-07-worktree-setup.md`)
 * end to end: setup commands saved in Settings → Worktrees run in the next task's worktree before
 * its first agent turn, and the thread shows the "Ran …" card and the done note.
 *
 * Own fixture server over its own git repo, like `review-gate.e2e.ts`: saving the setting writes
 * that repo's `.ai/cezar/config.json`, never the shared environment's, so no other spec can start
 * a task that runs these commands. The server binds loopback, so the cockpit is local and the
 * field is editable.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-worktree-setup-${process.pid}`
const marker = `cez-e2e-setup-${process.pid}`
const command = `echo ${marker} > "$CEZ_PROJECT_ROOT/.setup-ran"`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string

interface ConfigAnswer {
  worktreeSetup: { commands: string[]; timeoutSeconds: number } | null
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-setup-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# worktree setup e2e fixture repo\n', 'utf8')
  writeFileSync(join(dataRoot, '.gitignore'), '.setup-ran\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('worktree setup from Settings to the task thread', () => {
  it('saves setup commands through Settings → Worktrees', async () => {
    browser.goto(`${baseUrl}/settings/worktrees`)
    // Editable once health confirms a local cockpit: the field is read-only until then.
    browser.waitForFunction(
      `(() => { const box = document.querySelector('[data-slot="worktree-setup-commands"]'); return box !== null && !box.readOnly })()`,
    )
    browser.fill('[data-slot="worktree-setup-commands"]', command)
    browser.waitForFunction(`document.querySelector('[data-action="worktree-setup-save"]:not([disabled])') !== null`)
    browser.click('[data-action="worktree-setup-save"]')
    const saved = await waitForConfig<ConfigAnswer>(
      baseUrl,
      (config) => config.worktreeSetup?.commands[0] === command,
      'worktreeSetup saved',
    )
    expect(saved.worktreeSetup).toEqual({ commands: [command], timeoutSeconds: 900 })
    browser.screenshot(`${artifactsDir}/worktree-setup-settings-desktop.png`)
  }, 60_000)

  it('reads well on a 360px phone', () => {
    browser.setViewport(360, 640)
    browser.waitForFunction(`document.querySelector('[data-slot="worktree-setup-commands"]') !== null`)
    const fits = browser.waitForValue(
      `(() => { const box = document.querySelector('[data-slot="worktree-setup-commands"]').getBoundingClientRect(); const save = document.querySelector('[data-action="worktree-setup-save"]').getBoundingClientRect(); return box.right <= innerWidth && save.height >= 44 ? { right: box.right, saveHeight: save.height } : null })()`,
    )
    expect(fits).toBeTruthy()
    browser.evaluate(`document.querySelector('[data-slot="worktree-setup-commands"]').scrollIntoView({ block: 'center' }) ?? true`)
    browser.screenshot(`${artifactsDir}/worktree-setup-settings-phone.png`)
    browser.setViewport(1440, 900)
  })

  it('runs the commands before the first agent turn and shows them in the thread', async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'Read the project notes.', workflow: 'quick-task' }),
      })
    ).json()) as { id: string }
    await waitForStatus(baseUrl, created.id, ['waiting', 'review', 'done'])
    expect(readFileSync(join(dataRoot, '.setup-ran'), 'utf8').trim()).toBe(marker)

    browser.goto(`${baseUrl}/tasks/${created.id}`)
    const card = browser.waitForValue(
      `[...document.querySelectorAll('[data-slot="tool-card"]')].map((el) => el.textContent).find((text) => text.includes('${marker}')) ?? null`,
    )
    expect(card).toContain('Ran')
    const note = browser.waitForValue(
      `[...document.querySelectorAll('[data-slot="note-line"]')].map((el) => el.textContent).find((text) => text.includes('worktree setup done in')) ?? null`,
    )
    expect(note).toMatch(/worktree setup done in \d+s/)
    browser.evaluate(
      `[...document.querySelectorAll('[data-slot="tool-card"]')].find((el) => el.textContent.includes('${marker}')).scrollIntoView({ block: 'center' }) ?? true`,
    )
    browser.screenshot(`${artifactsDir}/worktree-setup-thread.png`)
    await fetch(`${baseUrl}/api/v1/runs/${created.id}/finish`, { method: 'POST' })
  }, 120_000)
})
