import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, getJson, readTestEnv } from './agent-browser'
import {
  applyContrastQaVariant,
  contrastQaVariants,
  contrastSampleExpression,
  focusWithKeyboard,
  restoreContrastQaDefaults,
  type ContrastQaVariant,
  type ContrastSample,
} from './contrast'
import { snapshotSharedHome } from './workspace-registry'

/**
 * New project (spec 2026-10-15-create-new-project, hearsay-tools/cezarion#1014) in a real browser
 * against the shared `CEZ_DRY_RUN=1` env: real `git`, fake `gh`. The checkout root is pointed at
 * a throwaway directory for the run, so nothing lands in a developer's `~/cezar/projects`, and the
 * registry is restored byte-for-byte afterwards.
 *
 * What only a browser proves: the keyboard path through the Add project menu into the dialog,
 * the owner radios' arrow keys, the dialog fitting a 360px screen, and text contrast in both
 * themes. Mocked GitHub (`gh` faked) does not prove live provisioning.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-create-project-${process.pid}`
const DIALOG = '[data-slot="create-project-dialog"]'
const NAME = '[data-slot="create-project-name"]'
const SUBMIT = '[data-slot="create-project-submit"]'
const GITHUB = '[data-slot="create-project-github"]'
const RAIL_ADD = 'button[aria-label="Add project"][data-origin="rail"]'

const comfortable = (width: number) =>
  contrastQaVariants.filter((v) => v.density === 'comfortable' && v.viewport.width === width)
const desktop = (theme: ContrastQaVariant['theme']) => comfortable(1440).find((v) => v.theme === theme)!

let browser: AgentBrowser
let baseUrl: string
let bootId: string
let projectsDir: string
let restoreHome: () => void

type Project = { id: string; name: string; root: string; source: string }

async function registered(name: string): Promise<Project | undefined> {
  const body = await getJson<{ projects: Project[] }>(`${baseUrl}/api/v1/projects`)
  return body.projects.find((project) => project.name === name)
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootId = await bootProjectId(baseUrl)
  restoreHome = snapshotSharedHome('config.json')
  projectsDir = realpathSync(mkdtempSync(join(tmpdir(), 'cezar-e2e-new-project-')))
  // An existing folder for the collision case — created here, never by the dialog.
  mkdirSync(join(projectsDir, 'e2e-np-taken'))
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectsDir }),
  })
  if (!response.ok) throw new Error(`could not point the checkout root at ${projectsDir}: ${response.status}`)
  browser = AgentBrowser.open(sessionId)
})

afterAll(() => {
  if (browser) {
    restoreContrastQaDefaults(browser)
    browser.close()
  }
  restoreHome?.()
  if (projectsDir) rmSync(projectsDir, { recursive: true, force: true })
})

/** Open the boot project and the New project dialog through the rail's Add project menu. */
function openDialogFromRail(variant: ContrastQaVariant): void {
  browser.goto(`${baseUrl}/p/${bootId}/`)
  applyContrastQaVariant(browser, variant)
  browser.click(RAIL_ADD)
  browser.click('[data-slot="add-project-new"]')
  browser.waitForFunction(`document.activeElement?.matches(${JSON.stringify(NAME)}) === true`)
}

/** The dialog answered `gh`: owner cards rendered and the switch enabled. */
function waitForOwners(): number {
  return browser.waitForValue<number>(
    `(() => {
      const cards = document.querySelectorAll('[data-slot="create-project-owner"]').length
      return cards > 0 && !document.querySelector(${JSON.stringify(GITHUB)}).disabled ? cards : null
    })()`,
  )
}

/** The page left the boot project for another one: answers that project's id. */
function waitForNewProjectPage(): string {
  return browser.waitForValue<string>(
    `(() => {
      const match = /^\\/p\\/([^/]+)\\//.exec(location.pathname)
      return match && match[1] !== ${JSON.stringify(bootId)} && !document.querySelector(${JSON.stringify(DIALOG)}) ? match[1] : null
    })()`,
  )
}

describe('New project', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`creates a local project from the keyboard, ${theme}`, async () => {
      browser.goto(`${baseUrl}/p/${bootId}/`)
      applyContrastQaVariant(browser, desktop(theme))
      // With no project registered (a server booted inside a task worktree) the rail's Add project
      // trigger is the page's first focusable control; in CI the boot project's mark comes first.
      // `focusWithKeyboard` reaches it through a real Tab either way (hearsay-tools/cezarion#1091).
      focusWithKeyboard(browser, RAIL_ADD)
      browser.press('Enter')
      // Radix focuses the first item of a menu opened from the keyboard: New project comes first.
      browser.waitForFunction(`document.activeElement?.getAttribute('data-slot') === 'add-project-new'`)
      browser.press('Enter')
      browser.waitForFunction(`document.activeElement?.matches(${JSON.stringify(NAME)}) === true`)
      // The switch starts off even though the dry-run gh is signed in.
      expect(waitForOwners()).toBe(2)
      const switchState = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(GITHUB)}).getAttribute('aria-checked')`)
      expect(switchState).toBe('false')

      const name = `e2e-np-local-${theme}`
      browser.fill(NAME, name)
      browser.waitForFunction(`!document.querySelector(${JSON.stringify(SUBMIT)}).disabled`)
      browser.press('Enter')
      const id = waitForNewProjectPage()

      const project = await registered(name)
      expect(project).toMatchObject({ id, source: 'local', root: join(projectsDir, name) })
      expect(existsSync(join(projectsDir, name, '.git'))).toBe(true)
    })
  }

  it('creates an empty private GitHub repository for an organisation chosen with the arrow keys', async () => {
    openDialogFromRail(desktop('dark'))
    waitForOwners()
    focusWithKeyboard(browser, GITHUB)
    browser.press('Space')
    browser.waitForFunction(`document.querySelector(${JSON.stringify(GITHUB)}).getAttribute('aria-checked') === 'true'`)
    // The personal account is chosen first; ArrowDown on the checked radio moves to the org.
    browser.evaluate(`document.querySelector('[data-slot="create-project-owner"] input:checked').focus()`)
    browser.press('ArrowDown')
    const owner = browser.waitForValue<string>(
      `document.querySelector('[data-slot="create-project-owner"] input:checked')?.value === 'dry-run-org' ? 'dry-run-org' : null`,
    )
    expect(owner).toBe('dry-run-org')

    browser.fill(NAME, 'e2e-np-github')
    browser.click(SUBMIT)
    const id = waitForNewProjectPage()
    expect(await registered('e2e-np-github')).toMatchObject({ id, source: 'checkout' })
  })

  it('creates a project from a suggested template', async () => {
    openDialogFromRail(desktop('light'))
    waitForOwners()
    browser.click(GITHUB)
    browser.click('[data-slot="create-project-start-template"]')
    browser.fill('[data-slot="create-project-template"]', 'hono')
    browser.click('[data-slot="create-project-template-option"]')
    const picked = browser.waitForValue<string>(
      `document.querySelector('[data-slot="create-project-template"]').value || null`,
    )
    expect(picked).toBe('w3cj/hono-open-api-starter')

    browser.fill(NAME, 'e2e-np-template')
    browser.click(SUBMIT)
    const id = waitForNewProjectPage()
    expect(await registered('e2e-np-template')).toMatchObject({ id, source: 'checkout' })
    // The dry-run clone is a real repository with the template's (fake) file in it.
    expect(existsSync(join(projectsDir, 'e2e-np-template', 'README.md'))).toBe(true)
  })

  it('explains an invalid name, and shows a collision verbatim', () => {
    openDialogFromRail(desktop('light'))
    browser.fill(NAME, 'bad/name')
    const hint = browser.waitForValue<string>(`document.querySelector('[data-slot="create-project-name-hint"]')?.textContent ?? null`)
    expect(hint).toContain('letters, digits')
    const disabled = browser.waitForValue<boolean>(`document.querySelector(${JSON.stringify(SUBMIT)}).disabled`, (v) => v === true)
    expect(disabled).toBe(true)

    browser.fill(NAME, 'e2e-np-taken')
    browser.click(SUBMIT)
    const error = browser.waitForValue<string>(`document.querySelector('[data-slot="create-project-error"]')?.textContent ?? null`)
    expect(error).toBe(`folder already exists: ${join(projectsDir, 'e2e-np-taken')}`)
  })

  for (const variant of comfortable(360)) {
    it(`fits a 360x640 screen from the Tools page, ${variant.theme}`, () => {
      browser.goto(`${baseUrl}/tools`)
      applyContrastQaVariant(browser, variant)
      // Health metadata moves the button after it first appears (hearsay-tools/cezarion#2000).
      browser.waitForFunction(`document.querySelector('[data-slot="tool-row"]') !== null &&
        document.querySelector('[aria-labelledby="add-project-heading"] dl')?.textContent.includes('Checkout folder') === true`)
      browser.click('[data-route="workspace-tools"] [data-action="new-project"]')
      browser.waitForFunction(`document.activeElement?.matches(${JSON.stringify(NAME)}) === true`)
      waitForOwners()

      const layout = browser.waitForValue<{ left: number; right: number; overflowX: number; submitBottom: number; ownersBelow: boolean }>(
        `(() => {
          const dialog = document.querySelector(${JSON.stringify(DIALOG)})
          const box = dialog.getBoundingClientRect()
          const name = document.querySelector(${JSON.stringify(NAME)}).getBoundingClientRect()
          const owners = document.querySelector('[data-slot="create-project-owners"]').getBoundingClientRect()
          const submit = document.querySelector(${JSON.stringify(SUBMIT)}).getBoundingClientRect()
          return { left: box.left, right: box.right - innerWidth, overflowX: dialog.scrollWidth - dialog.clientWidth,
            submitBottom: submit.bottom - innerHeight, ownersBelow: owners.top >= name.bottom }
        })()`,
      )
      expect(layout.left).toBeGreaterThanOrEqual(0)
      expect(layout.right).toBeLessThanOrEqual(0)
      expect(layout.overflowX).toBeLessThanOrEqual(0)
      // The footer stays on screen: the body scrolls, the Create button does not.
      expect(layout.submitBottom).toBeLessThanOrEqual(0)
      expect(layout.ownersBelow).toBe(true)

      for (const [target, label] of [
        [`${DIALOG} [data-slot="dialog-description"]`, 'description'],
        ['[data-slot="create-project-path"]', 'checkout path'],
        // Not an owner card: those are disabled (and dimmed) until GitHub is switched on.
        ['label:has([data-slot="create-project-start-empty"]) .text-muted-foreground', 'option detail'],
      ] as const) {
        const sample = browser.evaluate(contrastSampleExpression(target)) as ContrastSample
        expect(sample.ratio, `${variant.id} ${label} ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(4.5)
      }
      browser.screenshot(`${artifactsDir}/create-project-${variant.theme}-360.png`)
    })
  }
})
