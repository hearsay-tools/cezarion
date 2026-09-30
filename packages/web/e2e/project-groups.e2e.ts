import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import { readSharedProjects, snapshotSharedHome, writeSharedProjects } from './workspace-registry'

/** Registry → rail → scoped project header, tabs and task list in a real browser. */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-project-groups-${process.pid}`
const repoRoot = resolve(import.meta.dirname, '../../..')

const DESKTOP = { width: 1440, height: 900 }

/** Seeded siblings of the boot project. Ids obey the registry's slug rule (`^[a-z0-9][a-z0-9-]*$`)
 *  and are prefixed so an interrupted run leaves something obviously disposable behind. */
const ALPHA = { id: 'e2e-alpha', name: 'e2e alpha' }
const BETA = { id: 'e2e-beta', name: 'e2e beta' }

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let seedDir: string
let restoreHome: () => void
let singleProject = false

let forgeAvailable = false

const scoped = (projectId: string, path: string) => `/p/${projectId}${path}`

/** The nav every group renders — the same health-gated list the flat shell uses. */
function expectedNavHrefs(projectId: string): string[] {
  return [
    scoped(projectId, '/'),
    scoped(projectId, '/git'),
    ...(projectId === bootProject && forgeAvailable ? [scoped(projectId, '/github')] : []),
    scoped(projectId, '/skills'),
    scoped(projectId, '/workflows'),
    scoped(projectId, '/settings'),
  ]
}

/** A real (if empty) git repo, so the registry probe answers `ok` rather than `not-git` and the
 *  group renders its expandable form instead of the "folder not found" row. */
function makeRepo(name: string): string {
  const root = join(seedDir, name)
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
  return root
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json())) as {
    forge: { available: boolean } | null
    capabilities: { followups: boolean; singleProject: boolean; automations: boolean }
  }
  forgeAvailable = health.forge?.available === true
  singleProject = health.capabilities.singleProject

  // `ui-state.json` too: the collapse assertion below reads it to prove nothing was written
  // there, and a developer's scratch home must not come out of this run holding a seeded map.
  restoreHome = snapshotSharedHome('config.json', 'ui-state.json')
  seedDir = mkdtempSync(join(tmpdir(), 'cezar-e2e-groups-'))

  // The boot entry as the registry already has it when it is registered — its `lastOpenedAt` is
  // what puts it first in the sidebar's most-recently-opened order, so the seeded siblings get
  // deliberately older ones rather than an empty string apiece.
  const existingBoot = readSharedProjects().find((project) => project.id === bootProject)
  const bootEntry =
    existingBoot ?? {
      id: bootProject,
      root: repoRoot,
      name: bootProject,
      addedAt: '2026-07-20T00:00:00Z',
      lastOpenedAt: '2026-07-20T12:00:00Z',
      source: 'local',
    }
  const alphaEntry = {
    ...ALPHA,
    root: makeRepo('alpha'),
    lastOpenedAt: '2026-07-19T12:00:00Z',
    source: 'local' as const,
  }
  writeSharedProjects(
    singleProject
      ? [bootEntry, alphaEntry]
      : [
          bootEntry,
          alphaEntry,
          { ...BETA, root: makeRepo('beta'), lastOpenedAt: '2026-07-18T12:00:00Z', source: 'local' },
        ],
  )

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
  restoreHome?.()
  if (seedDir) rmSync(seedDir, { recursive: true, force: true })
})

const nav = '[data-slot="sidebar"] nav[aria-label="Main"]'
const header = '[data-slot="sidebar"] [data-slot="project-header"]'
const mark = (id: string) => `[data-slot="rail-project"][data-project-id="${id}"] a`

function assertProject(projectId: string, path: string): void {
  expect(browser.waitForValue(`location.pathname`, value => value === scoped(projectId, path))).toBe(scoped(projectId, path))
  const expected = expectedNavHrefs(projectId)
  expect(browser.waitForValue(`Array.from(document.querySelectorAll('${nav} a')).map(a => new URL(a.href).pathname)`,
    value => JSON.stringify(value) === JSON.stringify(expected))).toEqual(expected)
  expect(browser.waitForValue(`Array.from(document.querySelectorAll('${nav} a[aria-current="page"]')).map(a => new URL(a.href).pathname)`,
    value => JSON.stringify(value) === JSON.stringify([scoped(projectId, path)]))).toEqual([scoped(projectId, path)])
  expect(browser.count('[data-slot="sidebar"] [data-slot="project-header"]')).toBe(1)
  // Git carries its own worktree list instead of the task list (#622); every other view keeps the task list.
  expect(browser.count('[data-slot="sidebar"] [data-slot="task-quick-list"]')).toBe(path === '/git' ? 0 : 1)
  expect(browser.count('[data-slot="sidebar"] [data-slot="git-sidebar"]')).toBe(path === '/git' ? 1 : 0)
  expect(browser.count('[data-slot="project-groups"], [data-slot="single-project-navigation"], [data-slot="repo-chip"]')).toBe(0)
}

describe('the project sidebar in a multi-project workspace', () => {
  it('keeps other projects on the rail and one scoped header and tab row in the sidebar', ({ skip }) => {
    if (singleProject) skip()
    browser.goto(baseUrl + scoped(bootProject, '/'))
    browser.waitForFunction(`document.querySelector('${mark(BETA.id)}') !== null`)
    assertProject(bootProject, '/')
    expect(browser.count('[data-slot="sidebar"] [data-slot="brand-wordmark"]')).toBe(0)
    expect(browser.waitForValue(`Array.from(document.querySelectorAll('[data-slot="rail-project"]')).map(el => el.dataset.projectId)`,
      value => Array.isArray(value) && value.length === 3)).toEqual([bootProject, ALPHA.id, BETA.id])
    browser.screenshot(`${artifactsDir}/sidebar-projects.png`)
  })

  it('switches every tab to the rail-selected project without inheriting its sibling forge', ({ skip }) => {
    if (singleProject) skip()
    browser.goto(baseUrl + scoped(bootProject, '/git'))
    assertProject(bootProject, '/git')
    browser.click(mark(ALPHA.id))
    assertProject(ALPHA.id, '/')
    expect(browser.waitForValue(`document.querySelector('${header} [data-slot="project-header-name"]')?.textContent`, value => value === ALPHA.name)).toBe(ALPHA.name)
    browser.click(`${nav} a[href="${scoped(ALPHA.id, '/git')}"]`)
    assertProject(ALPHA.id, '/git')
    expect(browser.waitForValue(`document.querySelectorAll('${nav} a[aria-label="GitHub"]').length`, value => value === 0)).toBe(0)
    browser.goto(baseUrl + scoped(ALPHA.id, '/git'))
    assertProject(ALPHA.id, '/git')
    browser.click(mark(bootProject))
    assertProject(bootProject, '/')
  })

  it('ignores legacy collapse pins so the current project stays available after reload', ({ skip }) => {
    if (singleProject) skip()
    browser.goto(baseUrl + scoped(ALPHA.id, '/'))
    browser.evaluate(`localStorage.setItem('cez-sidebar-collapsed', JSON.stringify({ '${ALPHA.id}': true, '${bootProject}': false }))`)
    try {
      browser.goto(baseUrl + scoped(ALPHA.id, '/'))
      assertProject(ALPHA.id, '/')
      expect(browser.waitForValue(`document.querySelector('${header}')?.getBoundingClientRect().width > 0`)).toBe(true)
      expect(browser.isVisible('[data-slot="project-task-navigation"]')).toBe(true)
    } finally {
      browser.evaluate(`localStorage.removeItem('cez-sidebar-collapsed')`)
    }
  })
})

describe('the constrained single-project workspace', () => {
  it('keeps the project header and tab navigation and removes every multi-project affordance', ({ skip }) => {
    if (!singleProject) skip()

    browser.goto(baseUrl + scoped(bootProject, '/'))
    browser.waitForFunction(
      `document.querySelector('[data-slot="sidebar"] nav[aria-label="Main"]') !== null`,
    )
    // Health resolves after the shell's first paint; before that the safe default preserves the
    // ordinary Add-project control. Wait for the capability-driven repaint, not merely the nav.
    browser.waitForFunction(`document.querySelector('button[aria-label="Add project"]') === null`)

    // The scratch registry still holds the two sibling rows seeded in beforeAll. The process
    // capability, rather than destructive fixture trimming, must collapse every UI consumer.
    expect(readSharedProjects().map((project) => project.id)).toEqual([bootProject, ALPHA.id])
    expect(browser.count('[data-slot="project-groups"]')).toBe(0)
    expect(browser.isVisible('[data-slot="sidebar"] nav[aria-label="Main"]')).toBe(true)
    expect(browser.count('button[aria-label="Add project"]')).toBe(0)

    browser.goto(`${baseUrl}/settings/global`)
    browser.waitForFunction(`document.querySelector('[data-slot="settings-nav"]') !== null`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="settings-nav"] [data-section="projects"]') === null`,
    )
    expect(browser.count('[data-slot="settings-nav"] [data-section="projects"]')).toBe(0)
    expect(browser.count('[data-slot="settings-index"] [data-section="projects"]')).toBe(0)

    browser.goto(`${baseUrl}/settings/global/projects`)
    browser.waitForFunction(`document.querySelector('[data-route="not-found"]') !== null`)
    expect(browser.count('[data-route="settings-global-projects"]')).toBe(0)

    browser.goto(baseUrl + scoped(bootProject, '/new'))
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    expect(browser.count('[data-slot="project-pill"]')).toBe(0)

    browser.screenshot(`${artifactsDir}/sidebar-single-project-constrained.png`)
  })
})
