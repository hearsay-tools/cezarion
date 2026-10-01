import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import { stopFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { waitForHealth } from './poll'

/**
 * Task GitHub item tabs (#692) end-to-end: a task that references an own-repo PR and issue gets
 * one tab per item, and the header chips open those tabs instead of GitHub.
 *
 * The fixture repo carries a github.com `origin`, so the project's repo resolves, and
 * `CEZ_DRY_RUN=1` answers every forge read from the built-in mock — whose PR #128 and issue #142
 * are the numbers the seeded run references. The run is seeded through `runs.json` (cezar's
 * documented state contract): no agent has to run, and nothing here depends on a live GitHub.
 */

const PR = 128
const ISSUE = 142
const sessionId = `e2e-task-github-items-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const runId = 'task-items-1'
const scoped = (path: string) => `/p/${bootProject}${path}`
const tabs = '[data-slot="run-tabs"]'
const activeTab = `${tabs} a[aria-current="page"]`
const prChip = '[data-slot="run-meta"] [data-slot="pr-chip"]'

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-items-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# task item tabs e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')
  git('remote', 'add', 'origin', 'git@github.com:mock/repo.git')

  const seeded: RunRecord = {
    id: runId,
    title: 'Fix the login refresh',
    task: 'Fix the login refresh.',
    workflow: 'quick-task',
    status: 'review',
    archived: false,
    createdAt: '2026-09-30T10:00:00Z',
    tokensUsed: 0,
    steps: [],
    prNumber: PR,
    issueNumber: ISSUE,
  }
  mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([seeded], null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

/** Opens the task, clicks the header PR chip and returns once the PR tab is the active one. */
function openPrFromChip({ revealDetails = false } = {}) {
  browser.goto(`${baseUrl}${scoped(`/tasks/${runId}`)}`)
  // On a phone the meta row (and its chips) sits behind the details toggle.
  if (revealDetails) browser.click('button[aria-label="Show run details"]')
  browser.click(prChip)
  return browser.waitForValue<string | null>(
    `(() => {
      const active = document.querySelector('${activeTab}')?.textContent ?? ''
      return location.pathname.endsWith('/pr/${PR}') && active.includes('#${PR}') ? active : null
    })()`,
  )
}

describe('task GitHub item tabs against the dry-run mock', () => {
  it('the header PR chip opens the PR tab with its merge box, and the issue tab shows the issue body', () => {
    const active = openPrFromChip()
    expect(active).toContain(`#${PR}`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/tasks/${runId}/pr/${PR}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-merge-box"]') !== null`)

    browser.click(`${tabs} a[href$="/issue/${ISSUE}"]`)
    const body = browser.waitForValue<string | null>(
      `(() => {
        const body = document.querySelector('[data-slot="gh-body"]')?.textContent ?? ''
        return location.pathname.endsWith('/issue/${ISSUE}') && body.includes('Repro: log in, hit reload') ? body : null
      })()`,
    )
    expect(body).toContain('Repro: log in, hit reload')
    expect(browser.text(activeTab)).toContain(`#${ISSUE}`)
  })

  it('on a phone the chip lands on a PR tab that is inside the viewport', () => {
    browser.setViewport(390, 844)
    openPrFromChip({ revealDetails: true })
    const rect = browser.waitForValue<{ left: number; right: number; width: number }>(
      `(() => {
        const tab = document.querySelector('${activeTab}')
        if (!tab) return null
        const r = tab.getBoundingClientRect()
        return r.left >= 0 && r.right <= innerWidth ? { left: r.left, right: r.right, width: innerWidth } : null
      })()`,
    )
    expect(rect.right).toBeLessThanOrEqual(rect.width)
  })
})
