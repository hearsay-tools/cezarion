import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pollFor, pollJson } from './poll'
import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import { readSharedProjects, writeSharedProjects } from './workspace-registry'

/**
 * Automatic Open Mercato skill updates against the real CEZ_DRY_RUN cockpit.
 *
 * Reachability: dry-run deliberately reports a deterministic `current` state with no tracked
 * installation, so this spec covers the inherited preference, its persisted override, the
 * honest no-marker navigation state, and the dry-run apply success/upgrade-notes hand-off. An
 * `available` marker is covered structurally by the app-shell unit suite; manufacturing one in
 * Chrome would require a production-only lock file and network-backed `npx skills check`.
 */

// Dated checkpoints are historical evidence; fresh E2E output belongs in ignored QA storage.
const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const workspaceConfig = resolve(import.meta.dirname, '../../../.ai/qa/cez-home/config.json')
const sessionId = `e2e-skills-update-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 }
const checkpointDir = resolve(
  import.meta.dirname,
  '../../../.ai/runs/2026-07-22-automatic-open-mercato-skills-updates/checkpoint-3-artifacts',
)
const screenshotNames = [
  'settings-skills-auto-update.png',
  'skills-navigation-current.png',
  'skills-update-success.png',
  'skills-mobile-navigation.png',
]
const qaArtifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let checkpoints: { name: string; bytes: Buffer }[]

let browser: AgentBrowser
let baseUrl: string
let projectId: string
let previousConfig: string | null = null

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw new Error(`cezar e2e: ${init?.method ?? 'GET'} ${path} answered ${response.status}`)
  return (await response.json()) as T
}

beforeAll(async () => {
  checkpoints = screenshotNames.map((name) => ({ name, bytes: readFileSync(resolve(checkpointDir, name)) }))
  // A previous run's screenshots must not satisfy the output assertion.
  for (const name of screenshotNames) rmSync(resolve(qaArtifactsDir, name), { force: true })
  baseUrl = readTestEnv().baseUrl
  projectId = await bootProjectId(baseUrl)
  previousConfig = existsSync(workspaceConfig) ? readFileSync(workspaceConfig, 'utf8') : null
  writeSharedProjects(readSharedProjects().filter((project) => project.id === projectId))
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  if (previousConfig === null) rmSync(workspaceConfig, { force: true })
  else writeFileSync(workspaceConfig, previousConfig, 'utf8')
  browser?.close()
})

describe('automatic Open Mercato skills updates', () => {
  it('shows the inherited global preference and persists an explicit override', async () => {
    browser.goto(`${baseUrl}/settings/global/skills`)
    browser.waitForFunction(`document.querySelector('[data-slot="skills-settings-section"]') !== null`)

    expect(browser.isVisible('[data-slot="skills-auto-update"]')).toBe(true)
    expect(browser.text('[data-slot="skills-settings-section"]')).toContain('On (default)')
    // Local run 1791473329082-3196347, lane-3-failures/skills-update/
    // shows-the-inherited-global-preference-and-persists-an-explicit-override-1/probe.json
    // (2026-10-08T15:36:09Z): the section existed, but this assertion received
    // "Checking tracked Open Mercato installations…" before the status query settled.
    expect(browser.waitForValue(`document.querySelector('[data-slot="skills-installation-status"]')?.textContent`,
      value => typeof value === 'string' && value.includes('No tracked Open Mercato installation found.'))).toContain(
      'No tracked Open Mercato installation found.',
    )
    browser.screenshot(`${artifactsDir}/settings-skills-auto-update.png`)

    browser.click('[data-slot="skills-auto-update"]')
    const saved = (wanted: boolean | null) => pollFor(async signal => {
      const config = await pollJson<{ skillsAutoUpdate: boolean | null }>(`${baseUrl}/api/v1/workspace/config`, signal)
      return config.skillsAutoUpdate === wanted ? config : undefined
    }, () => `workspace skillsAutoUpdate never persisted ${wanted}`, { timeoutMs: 10_000, intervalMs: 100 })
    let config = await saved(false)
    expect(config.skillsAutoUpdate).toBe(false)
    // Local run 1790759265447-4156089, lane-3-failures/skills-update/
    // shows-the-inherited-global-preference-and-persists-an-explicit-override-1:
    // the override persisted, but the disclosure stayed closed and its visible text omitted it.
    browser.waitForFunction('window.__cezIdle === true')
    browser.click('[data-slot="skills-settings-section"] details summary')
    const explanation = browser.waitForValue(`(() => {
      const details = document.querySelector('[data-slot="skills-settings-section"] details')
      return details?.open ? details.innerText : null
    })()`, value => typeof value === 'string' && value.includes('explicit workspace override'))
    expect(explanation).toContain('explicit workspace override')

    browser.click('[data-action="skills-use-default"]')
    config = await saved(null)
    expect(config.skillsAutoUpdate).toBeNull()
  })

  it('keeps the navigation marker absent for the dry-run current state', () => {
    browser.goto(`${baseUrl}/p/${projectId}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"] nav[aria-label="Main"]') !== null`)
    expect(browser.count('[data-slot="nav-update-marker"]')).toBe(0)
    expect(browser.count('[data-slot="sidebar"] nav[aria-label="Main"] a[aria-label="Skills"]')).toBe(1)
    browser.screenshot(`${artifactsDir}/skills-navigation-current.png`)
  })

  it('renders dry-run update success and the upgrade-notes hand-off', async () => {
    const state = await api<{ status: string; needsUpgradeNotes: boolean }>(
      '/api/v1/workspace/skills-update/apply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    )
    expect(state).toMatchObject({ status: 'current', needsUpgradeNotes: true })

    browser.goto(`${baseUrl}/p/${projectId}/skills?skill=__import`)
    browser.waitForFunction(`document.querySelector('[data-slot="skills-update-card"]') !== null`)
    expect(browser.text('[data-slot="skills-update-card"]')).toContain(
      'Installed Open Mercato skills are up to date.',
    )
    expect(browser.text('[data-slot="skills-upgrade-notes"]')).toContain('/om-apply-upgrade-notes')
    browser.screenshot(`${artifactsDir}/skills-update-success.png`)
  })

  it('keeps Skills reachable in mobile navigation without a false marker', () => {
    browser.setViewport(IPHONE.width, IPHONE.height)
    browser.goto(`${baseUrl}/p/${projectId}/`)
    // Skills lives in the tab bar's More sheet since #621 (the drawer is projects only).
    browser.click('[data-slot="mobile-tab-bar"] [data-tab="more"]')
    browser.waitForFunction(`document.querySelector('[data-slot="more-sheet"] a[data-more-row="/skills"]') !== null`)

    expect(browser.evaluate(`document.querySelector('[data-slot="more-sheet"] a[data-more-row="/skills"]')?.getAttribute('href')`)).toBe(`/p/${projectId}/skills`)
    expect(browser.count('[data-slot="more-sheet"] [data-slot="skills-update"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/skills-mobile-navigation.png`, { viewport: true })
  })

  it('preserves tracked checkpoints while producing fresh QA screenshots', () => {
    for (const { name, bytes } of checkpoints) {
      expect(readFileSync(resolve(checkpointDir, name)).equals(bytes), name).toBe(true)
      expect(readFileSync(resolve(qaArtifactsDir, name)).length, name).toBeGreaterThan(0)
    }
  })
})
