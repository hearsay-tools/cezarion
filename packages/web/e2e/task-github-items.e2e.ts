import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForSettledSample } from './visual-ready'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

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

  server = spawnFixtureServer([cezarCli, 'serve', '--repo', dataRoot, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  baseUrl = await waitForFixtureServer(server)
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
  it.each([
    { width: 360, height: 640, theme: 'light' },
    { width: 360, height: 640, theme: 'dark' },
    { width: 1280, height: 900, theme: 'light' },
    { width: 1280, height: 900, theme: 'dark' },
  ])('preserves issue and PR label colours at $width×$height in $theme', ({ width, height, theme }) => {
    browser.setViewport(width, height)
    for (const { kind, number, label, fill } of [
      { kind: 'issue', number: ISSUE, label: 'bug', fill: 'rgba(215, 58, 74, 0.133)' },
      { kind: 'pr', number: PR, label: 'tests', fill: 'rgba(197, 222, 245, 0.133)' },
    ]) {
      browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/${kind}/${number}`)}`)
      browser.waitForValue(`document.querySelector('[data-slot="gh-label"][data-label="${label}"]') !== null`)
      browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
      const facts = browser.waitForValue<{ fill: string; inside: boolean; text: string }>(`(() => {
        const chip = document.querySelector('[data-slot="gh-label"][data-label="${label}"]')
        if (!chip || !document.documentElement.classList.contains('${theme}')) return null
        const rect = chip.getBoundingClientRect()
        return { fill: getComputedStyle(chip).backgroundColor,
          inside: rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth, text: chip.textContent }
      })()`)
      expect(facts.fill).toBe(fill)
      expect(facts.inside).toBe(true)
      expect(facts.text).toBe(label)
      const evidence = resolve(import.meta.dirname, '../../../.ai/qa/issue-735')
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, `${kind}-${width}-${theme}.json`), JSON.stringify(facts, null, 2))
      browser.screenshot(join(evidence, `${kind}-${width}-${theme}.png`), { viewport: true })
    }
  })

  it('the header PR chip opens the PR tab with its merge box, and the issue tab shows the issue body', () => {
    const active = openPrFromChip()
    expect(active).toContain(`#${PR}`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/tasks/${runId}/pr/${PR}`)}`)
    // Visible, not merely mounted: a nonzero box with a visible computed style, read as one sample.
    const mergeBox = waitForSettledSample<{ width: number; height: number }>(browser,
      `(() => {
        const box = document.querySelector('[data-slot="gh-merge-box"]')
        if (!box) return null
        const r = box.getBoundingClientRect()
        const style = getComputedStyle(box)
        const shown = r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility === 'visible'
        return shown ? { width: r.width, height: r.height } : null
      })()`,
    )
    expect(mergeBox.height).toBeGreaterThan(0)

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

  it('offers the same keyboard-accessible issue handoff at 360×640 in light and dark themes', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/issue/${ISSUE}`)}`)
    for (const theme of ['light', 'dark']) {
      browser.waitForValue(`document.querySelector('[data-slot="gh-custom-prompt"]') !== null`)
      browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
      browser.fill('[data-slot="gh-custom-prompt"]', `Draft in ${theme}`)
      browser.press('Tab')
      const facts = waitForSettledSample<{ inside: boolean; overflow: boolean; height: number }>(browser, `(() => {
        const panel = document.querySelector('[data-slot="gh-hand"]')
        const input = panel?.querySelector('textarea')
        if (!panel || !input || !panel.contains(document.activeElement) || input === document.activeElement) return null
        const rect = panel.getBoundingClientRect()
        return { inside: rect.left >= 0 && rect.right <= innerWidth,
          overflow: panel.scrollWidth > panel.clientWidth, height: input.getBoundingClientRect().height }
      })()`)
      expect(facts.inside).toBe(true)
      expect(facts.overflow).toBe(false)
      expect(facts.height).toBeGreaterThanOrEqual(44)
      const evidence = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
      mkdirSync(evidence, { recursive: true })
      browser.screenshot(join(evidence, `handoff-360-${theme}.png`), { viewport: true })
    }
  })

  it('on a phone the chip lands on a PR tab that is inside the viewport', () => {
    browser.setViewport(390, 844)
    openPrFromChip({ revealDetails: true })
    const rect = waitForSettledSample<{ left: number; right: number; width: number }>(browser,
      `(() => {
        const tab = document.querySelector('${activeTab}')
        if (!tab) return null
        const r = tab.getBoundingClientRect()
        return { left: r.left, right: r.right, width: innerWidth }
      })()`,
    )
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(rect.width)
  })
})
