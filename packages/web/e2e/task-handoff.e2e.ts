import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { stopFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'
import { waitForHealth } from './poll'
import { applyContrastQaVariant, contrastSampleExpression, restoreContrastQaDefaults, type ContrastSample } from './contrast'

// "Hand off" (#589) against the real server: the project webhook is set through the same PATCH
// the settings page sends, the thread's button opens the dialog (a bottom sheet at 360px), and
// the hand-off lands as `notify: true` plus a thread line. CEZ_DRY_RUN=1 (fixtureServeEnv) means
// the delivery is logged as a run event and nothing leaves the machine.
let browser: AgentBrowser
let server: ChildProcess
let root: string
let baseUrl: string
let project: string
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/task-handoff')
const AA_NORMAL_TEXT = 4.5
const handoff = '[data-action="handoff"]'
const dialog = '[data-slot="handoff-dialog"]'
const submit = '[data-action="handoff-submit"]'
const chip = '[data-slot="notifying-chip"]'
const fixture = (id: string): RunRecord => ({
  id, title: `Hand off ${id}`, task: `Hand off ${id}`, workflow: 'quick-task', status: 'review',
  archived: false, createdAt: '2026-09-25T10:00:00Z', tokensUsed: 0, steps: [],
})

beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true })
  root = mkdtempSync(join(tmpdir(), 'cez-handoff-'))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([fixture('desktop'), fixture('mobile')]))
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  await waitForHealth(baseUrl, 'the hand-off fixture')
  project = await bootProjectId(baseUrl)
  const saved = await fetch(`${baseUrl}/api/v1/projects/${project}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhook: { url: 'https://bot.example/hooks/cez', token: 'e2e-token' } }),
  })
  if (!saved.ok) throw new Error(`webhook PATCH answered ${saved.status}`)
  browser = AgentBrowser.open(`handoff-${process.pid}`)
})

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

const openThread = (id: string) => {
  browser.goto(`${baseUrl}/p/${project}/tasks/${id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(handoff)}) !== null`)
}

/** Screenshots are evidence of the settled UI, so they wait out Radix's open/close animations. */
const settledShot = (name: string) => {
  browser.waitForFunction(`document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)`)
  browser.screenshot(join(artifacts, name))
}

const box = (selector: string) => browser.waitForValue(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 ? { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height } : null;
})()`) as { top: number; bottom: number; left: number; width: number; height: number }

describe('Hand off to webhook', () => {
  it('hands a task off from the desktop dialog with a note', async () => {
    browser.setViewport(1280, 800)
    openThread('desktop')
    browser.click(handoff)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(dialog)}) !== null`)
    const text = browser.waitForValue(`document.querySelector(${JSON.stringify(dialog)})?.textContent || null`) as string
    expect(text).toContain('bot.example/hooks/cez')
    expect(text).toContain('The note goes to the webhook only, not to the agent.')
    settledShot('desktop-dialog.png')

    browser.fill('[data-slot="handoff-note"]', 'Take over from here')
    browser.click(submit)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(chip)}) !== null`)
    const line = browser.waitForValue(`[...document.querySelectorAll('[data-icon="handoff"]')].map(el => el.textContent).find(t => t.includes('Take over from here')) || null`) as string
    expect(line).toMatch(/^Handed off to webhook · /)
    settledShot('desktop-notifying.png')

    const run = await getJson<RunRecord>(`${baseUrl}/api/v1/p/${project}/runs/desktop`)
    expect(run.notify).toBe(true)
  })

  it('is a bottom sheet with a full-width 44px action at 360×640', () => {
    browser.setViewport(360, 640)
    openThread('mobile')
    const trigger = box(handoff)
    expect(trigger.width).toBeGreaterThanOrEqual(44)
    expect(trigger.height).toBeGreaterThanOrEqual(44)
    browser.click(handoff)
    // Settled: the sheet has slid in when its bottom edge sits on the viewport's.
    const sheet = browser.waitForValue(`(() => {
      const el = document.querySelector(${JSON.stringify(dialog)});
      if (!el || el.getAnimations().some(a => a.playState === 'running')) return null;
      const r = el.getBoundingClientRect();
      return Math.abs(r.bottom - window.innerHeight) < 1 ? { left: r.left, width: r.width } : null;
    })()`) as { left: number; width: number }
    expect(sheet.left).toBe(0)
    expect(sheet.width).toBe(360)
    const action = box(submit)
    expect(action.height).toBeGreaterThanOrEqual(44)
    expect(action.width).toBeGreaterThanOrEqual(300)
    settledShot('mobile-sheet.png')
  })

  it('keeps AA contrast on the dialog text in light and dark', () => {
    for (const theme of ['dark', 'light'] as const) {
      applyContrastQaVariant(browser, { id: `mobile-${theme}`, theme, density: 'comfortable', viewport: { width: 360, height: 640 } })
      // `DialogContent` carries `duration-200` with the initial `transition-property: all`, so its
      // background eases for 200 ms after the theme class flips. The first local run sampled that
      // transition (light ink on the old dark card, 2.38:1; bundle
      // .ai/qa/failures/task-handoff/keeps-AA-contrast-…-1 shows the settled sheet light). Sample
      // only once no transition is running inside the dialog.
      browser.waitForFunction(`(() => {
        const el = document.querySelector(${JSON.stringify(dialog)});
        return Boolean(el) && el.getAnimations({ subtree: true }).every(a => a.playState !== 'running');
      })()`)
      for (const selector of [`${dialog} [data-slot="dialog-description"]`, `${dialog} label`, submit]) {
        const sample = browser.waitForValue(contrastSampleExpression(selector)) as ContrastSample
        expect(sample.ratio, `${theme} ${selector} ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
      }
      settledShot(`mobile-sheet-${theme}.png`)
    }
    restoreContrastQaDefaults(browser)
  })

  it('shows the stored webhook in project settings without its token', () => {
    browser.setViewport(360, 640)
    browser.goto(`${baseUrl}/p/${project}/settings`)
    const placeholder = browser.waitForValue(`document.querySelector('[data-slot="task-webhook-token"]')?.getAttribute('placeholder') || null`) as string
    expect(placeholder).toContain('Token set')
    const url = browser.waitForValue(`document.querySelector('[data-slot="task-webhook-url"]')?.value || null`) as string
    expect(url).toBe('https://bot.example/hooks/cez')
    expect(browser.evaluate(`document.body.innerHTML.includes('e2e-token')`)).toBe(false)
    browser.evaluate(`document.querySelector('[data-slot="task-webhook"]').scrollIntoView({ block: 'center' })`)
    settledShot('mobile-settings.png')
  })
})
