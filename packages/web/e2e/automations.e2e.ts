import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, readTestEnv } from './agent-browser'
import { applyContrastQaVariant, contrastQaVariants, restoreContrastQaDefaults } from './contrast'
import { stopFixtureServer } from './fixture-server'
import { pollFor, pollJson, waitForHealth } from './poll'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const shotsDir = resolve(import.meta.dirname, '../../../.ai/qa/screenshots/automations')
const sessionId = `e2e-automations-${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let automationId: string | undefined
/** `capabilities.automations` (#801) — the shared environment boots WITHOUT the opt-in, which is
 *  what a default cezar does, so the enabled-path cases below skip unless it was turned on. */
let automationsAvailable = false

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((response) => response.json())) as {
    capabilities: { automations: boolean }
  }
  automationsAvailable = health.capabilities.automations
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(async () => {
  browser?.close()
  if (automationId) await fetch(`${baseUrl}/api/v1/automations/${automationId}`, { method: 'DELETE' })
})

describe('automations on the shared environment', () => {
  // The default shape of the product, asserted in a real browser: nothing about automations is
  // reachable or advertised until an operator opts in. Before #801 this sidebar item was present
  // on every project with a GitHub remote, which is exactly what the flag exists to undo.
  it('is absent from the sidebar and refuses its API without the opt-in', async ({ skip }) => {
    skip(automationsAvailable, 'the shared environment explicitly enabled automations')
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    expect(browser.text('[data-slot="sidebar"]')).not.toContain('Automations')

    // The deep link still resolves — the route map is unchanged — but says the feature is off.
    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.body.textContent.includes('Automations are off')`)
    expect(browser.text('main')).toContain('CEZ_AUTOMATIONS=1')
    browser.screenshot(`${artifactsDir}/automations-disabled.png`)

    const refused = await fetch(`${baseUrl}/api/v1/automations`)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS')
  }, 60_000)

  it('creates a GitHub check paused, previews safely, enables from a baseline, and exposes the log', async ({ skip }) => {
    skip(
      !automationsAvailable,
      'automations are opt-in; run CEZ_AUTOMATIONS=1 npm run test:e2e -- --force',
    )
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
    automationId = automation!.id
    browser.waitForFunction(`document.body.textContent.includes('${name}') && document.body.textContent.includes('Paused')`)

    const preview = await fetch(`${baseUrl}/api/v1/automations/${automationId}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    }).then((response) => response.json()) as { checkId: string }
    const check = await pollFor(async signal => {
      const check = await pollJson<{ status: string; matches?: number; error?: string }>(`${baseUrl}/api/v1/automation-checks/${preview.checkId}`, signal)
      return ['complete', 'error'].includes(check.status) ? check : undefined
    }, () => `automation check ${preview.checkId} never completed`, { timeoutMs: 30_000, intervalMs: 500 })
    expect(check.status, check.error).toBe('complete')

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

/**
 * The schedule journey runs against its OWN fixture server, booted with the opt-in, so it runs in
 * CI instead of skipping the way the shared environment's enabled case does. The fixture has no
 * GitHub remote on purpose: a schedule needs none, and the GitHub segment must be disabled with
 * its reason while the schedule form still saves. `CEZ_DRY_RUN=1` keeps the launched task on the
 * bundled mock, so Run now touches no real agent CLI.
 */
describe('scheduled automations on an opted-in fixture server', () => {
  let root: string
  let base: string
  let project: string
  let server: ChildProcess
  let fixtureBrowser: AgentBrowser
  const name = `E2E weekly digest ${process.pid}`
  const prompt = `Scheduled e2e probe ${process.pid}`
  const scoped = (path: string) => `/p/${project}${path}`
  const light = contrastQaVariants.find((variant) => variant.id === 'desktop-light-comfortable')!
  const dark = contrastQaVariants.find((variant) => variant.id === 'desktop-dark-comfortable')!

  interface ListEntry { id: string; name: string; enabled: boolean; nextRunAt?: string }
  const listed = async () =>
    ((await fetch(`${base}/api/v1/automations`).then((response) => response.json())) as { automations: ListEntry[] }).automations

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-automations-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '--allow-empty', '-m', 'fixture')
    const probe = createServer()
    const port = await new Promise<number>((done) => probe.listen(0, '127.0.0.1', () => {
      const address = (probe.address() as { port: number }).port
      probe.close(() => done(address))
    }))
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
      env: fixtureServeEnv(root, { CEZ_AUTOMATIONS: '1' }), stdio: 'ignore',
    })
    await waitForHealth(base)
    project = await bootProjectId(base)
    mkdirSync(shotsDir, { recursive: true })
    fixtureBrowser = AgentBrowser.open(`e2e-automations-fixture-${process.pid}`)
    fixtureBrowser.setViewport(1440, 900)
  }, 60_000)

  afterAll(async () => {
    if (fixtureBrowser) {
      restoreContrastQaDefaults(fixtureBrowser)
      fixtureBrowser.close()
    }
    await stopFixtureServer(server)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('creates a weekly schedule paused, runs it by hand, enables, pauses and deletes it', async () => {
    const browser = fixtureBrowser
    browser.goto(`${base}${scoped('/automations/new')}`)
    // No remote: the GitHub segment is disabled and says why, and the schedule form is open.
    const kinds = browser.waitForValue(`(() => {
      const github = document.querySelector('[data-slot="automation-kind"] [data-value="github"]')
      const schedule = document.querySelector('[data-slot="automation-kind"] [data-value="schedule"]')
      return github && schedule ? { github: github.disabled, schedule: schedule.disabled } : null
    })()`) as { github: boolean; schedule: boolean }
    expect(kinds).toEqual({ github: true, schedule: false })

    browser.fill('#automation-name', name)
    browser.click('[role="group"][aria-label="Repeat"] button:nth-child(3)')
    browser.click('[role="group"][aria-label="Day of the week"] button:nth-child(2)')
    browser.fill('input[aria-label="Hour"]', '02')
    browser.fill('#automation-prompt', prompt)
    // The preview is computed from the form, so it must name Tuesdays 02:00 before Save.
    const preview = browser.waitForValue(`(() => {
      const items = [...document.querySelectorAll('ol[aria-label="Next 5 runs"] li')].map((li) => li.textContent)
      return items.length === 5 && items.every((text) => text.startsWith('Tue 02:00')) ? items : null
    })()`) as string[]
    expect(preview).toHaveLength(5)

    browser.screenshot(`${shotsDir}/automations-editor-dark.png`)
    applyContrastQaVariant(browser, light)
    browser.screenshot(`${shotsDir}/automations-editor-light.png`)
    applyContrastQaVariant(browser, dark)
    // Phone width: the same form in one column, GitHub segment still disabled, nothing sideways.
    browser.setViewport(390, 844)
    // The sample waits for the 390 px viewport to take effect, so it never reads the desktop layout.
    const phone = browser.waitForValue(`(() => {
      const form = document.querySelector('form.automation-editor')
      return form && window.innerWidth === 390 ? { overflow: document.documentElement.scrollWidth - window.innerWidth } : null
    })()`) as { overflow: number }
    expect(phone.overflow).toBeLessThanOrEqual(0)
    browser.screenshot(`${shotsDir}/automations-editor-390.png`, { viewport: true })
    browser.setViewport(1440, 900)

    browser.click('button[type="submit"]')
    browser.waitForFunction(`location.pathname === '${scoped('/automations')}'`)
    // Poll the server for the row the UI just saved: paused, with no run armed yet.
    const created = await pollFor(async () => (await listed()).find((item) => item.name === name),
      () => `automation ${name} never appeared in the list`, { timeoutMs: 15_000, intervalMs: 250 })
    expect(created.enabled).toBe(false)

    // The list shows the trigger label the schedule derives, and the paused row has no next run.
    const card = browser.waitForValue(`(() => {
      const card = [...document.querySelectorAll('[data-slot="automation-card"]')].find((node) => node.textContent.includes(${JSON.stringify(name)}))
      return card ? card.textContent : null
    })()`) as string
    expect(card).toContain('Tuesdays at 02:00')
    expect(card).toContain('Paused')
    expect(card).toContain('Next run: —')

    // Run now works while paused and launches an ordinary task.
    browser.click('[data-action="automation-run"]')
    browser.waitForFunction(`document.body.textContent.includes('Started task')`)
    const runs = await pollFor(async (signal) => {
      const all = await pollJson<Array<{ id: string; task: string; automationTrigger?: { trigger: string } }>>(`${base}/api/v1/runs`, signal)
      const match = all.filter((run) => run.task.includes(prompt))
      return match.length > 0 ? match : undefined
    }, () => 'the manual run never appeared in runs', { timeoutMs: 30_000, intervalMs: 500 })
    expect(runs[0]!.automationTrigger?.trigger).toBe('manual')

    // Under Tasks the new task is listed by its prompt.
    browser.goto(`${base}${scoped('/')}`)
    browser.waitForFunction(`document.body.textContent.includes(${JSON.stringify(prompt)})`)

    // The log carries the `manual` row.
    browser.goto(`${base}${scoped(`/automations/${created.id}/log`)}`)
    const logRows = browser.waitForValue(`(() => {
      const rows = [...document.querySelectorAll('ol[aria-label="Automation execution log"] li')].map((li) => li.textContent)
      return rows.some((row) => row.includes('Manual') && row.includes('Open task')) ? rows : null
    })()`) as string[]
    expect(logRows.length).toBeGreaterThan(0)
    browser.screenshot(`${shotsDir}/automations-log.png`)

    // Enable arms the next run; the list shows it.
    browser.goto(`${base}${scoped('/automations')}`)
    browser.click('[data-action="automation-toggle"]')
    const enabledCard = browser.waitForValue(`(() => {
      const card = [...document.querySelectorAll('[data-slot="automation-card"]')].find((node) => node.textContent.includes(${JSON.stringify(name)}))
      return card && /Next run: Tue 02:00/.test(card.textContent) ? card.textContent : null
    })()`) as string
    expect(enabledCard).toContain('Enabled')
    browser.screenshot(`${shotsDir}/automations-list-dark.png`)
    applyContrastQaVariant(browser, light)
    browser.screenshot(`${shotsDir}/automations-list-light.png`)
    restoreContrastQaDefaults(browser)
    // The enabled list on a phone: one column, nothing sideways. The shared-env iOS sweep only
    // sees the "off" page, so this is where the list's 390 px layout is asserted.
    browser.setViewport(390, 844)
    const phoneList = browser.waitForValue(`(() => {
      const card = document.querySelector('[data-slot="automation-card"]')
      return card && window.innerWidth === 390 ? { overflow: document.documentElement.scrollWidth - window.innerWidth } : null
    })()`) as { overflow: number }
    expect(phoneList.overflow).toBeLessThanOrEqual(0)
    browser.screenshot(`${shotsDir}/automations-list-390.png`, { viewport: true })
    browser.setViewport(1440, 900)
    expect((await listed()).find((item) => item.id === created.id)?.nextRunAt).toBeTruthy()

    // Pause clears the next run.
    browser.click('[data-action="automation-toggle"]')
    const pausedCard = browser.waitForValue(`(() => {
      const card = [...document.querySelectorAll('[data-slot="automation-card"]')].find((node) => node.textContent.includes(${JSON.stringify(name)}))
      return card && card.textContent.includes('Paused') && card.textContent.includes('Next run: —') ? card.textContent : null
    })()`) as string
    expect(pausedCard).toContain('Paused')

    // Delete goes through the editor's inline confirm.
    browser.goto(`${base}${scoped(`/automations/${created.id}`)}`)
    browser.click('[data-action="automation-delete"]')
    browser.click('[data-action="automation-delete-confirm"]')
    browser.waitForFunction(`location.pathname === '${scoped('/automations')}'`)
    await pollFor(async () => ((await listed()).some((item) => item.id === created.id) ? undefined : true),
      () => 'the deleted automation is still listed', { timeoutMs: 15_000, intervalMs: 250 })
  }, 180_000)
})
