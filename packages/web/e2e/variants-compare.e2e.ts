import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForSettledSample } from './visual-ready'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
// fixture-server starts: 1

/** Pre-retirement records enter through the real history importer, with retained Git data. */
const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const groupId = 'retained-comparison'
let browser: AgentBrowser
let server: ChildProcess
let root: string
let baseUrl: string
let project: string
const scoped = (path: string) => `/p/${project}${path}`
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-retired-variants-e2e-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'QA')
  git(root, 'config', 'user.email', 'qa@cezar.test')
  writeFileSync(join(root, 'README.md'), '# Retained results\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-qm', 'init')
  const records = ['A', 'B'].map(variant => {
    const worktreePath = join(root, `result-${variant}`)
    const branch = `retained-${variant}`
    git(root, 'worktree', 'add', '-qb', branch, worktreePath)
    writeFileSync(join(worktreePath, 'notes.md'), `Approach ${variant}\n`)
    git(worktreePath, 'add', 'notes.md')
    git(worktreePath, 'commit', '-qm', `Approach ${variant}`)
    return { id: `retained-${variant}`, title: `Improve notes (${variant})`, task: 'Improve notes', workflow: 'quick-task', status: 'done', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), tokensUsed: 0, archived: variant === 'B', groupId, variant, worktreePath, branch, baseBranch: 'main', steps: [] }
  })
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(records))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], { env: fixtureServeEnv(root), stdio: 'ignore' })
  baseUrl = await waitForFixtureServer(server)
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`e2e-retired-variants-${process.pid}`)
  mkdirSync(artifactsDir, { recursive: true })
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('retired parallel variants', () => {
  it.each([{ width: 360, height: 640, theme: 'light' }, { width: 360, height: 640, theme: 'dark' }, { width: 1440, height: 900, theme: 'light' }, { width: 1440, height: 900, theme: 'dark' }])('$width $theme: old links show retained tasks and migration guidance', ({ width, height, theme }) => {
    browser.setViewport(width, height)
    browser.goto(`${baseUrl}${scoped(`/compare/${groupId}`)}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="retained-variant"]').length === 2`)
    browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
    expect(browser.text('h1')).toBe('Retained results')
    expect(browser.text('[data-route="compare"]')).toContain('Parallel variants are removed')
    expect(browser.text('[data-route="compare"]')).toContain('owned workers')
    expect(browser.text('[data-route="compare"]')).toContain('archived')
    expect(browser.count('[data-slot="variant-pick"]')).toBe(0)
    expect(waitForSettledSample(browser, `({ links: [...document.querySelectorAll('[data-slot="retained-variant"] a')].map(a => a.getAttribute('href')), overflow: document.documentElement.scrollWidth > innerWidth })`))
      .toEqual({ links: [scoped('/tasks/retained-A'), scoped('/tasks/retained-B')], overflow: false })
    browser.screenshot(`${artifactsDir}/retired-variants-${width}-${theme}.png`, { viewport: true })
  })

  it('refuses new candidates and winner selection without touching retained commits or worktrees', async () => {
    for (const variants of [2, 3]) {
      const response = await fetch(`${baseUrl}/api/v1/p/${project}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'Compare', workflow: 'quick-task', variants }) })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Parallel variants are removed')
    }
    const pick = await fetch(`${baseUrl}/api/v1/p/${project}/groups/${groupId}/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'retained-A' }) })
    expect(pick.status).toBe(410)
    for (const variant of ['A', 'B']) {
      const path = join(root, `result-${variant}`)
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(join(path, 'notes.md'), 'utf8')).toBe(`Approach ${variant}\n`)
      expect(git(path, 'log', '-1', '--format=%s')).toBe(`Approach ${variant}`)
    }
  })

  it('keeps missing old links actionable', () => {
    browser.goto(`${baseUrl}${scoped('/compare/missing-group')}`)
    browser.waitForFunction(`document.querySelector('[data-route="compare"]')?.textContent.includes('No retained results for this group')`)
    expect(browser.text('[data-route="compare"]')).toContain('Open Tasks to find individual results')
  })
})
