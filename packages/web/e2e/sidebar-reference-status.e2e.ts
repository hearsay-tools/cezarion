import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, hoverVisiblePoint, type ContrastSample } from './contrast'
import { stopFixtureServer } from './fixture-server'
import { waitForHealth } from './poll'

// #677: real rows and real CSS. Only the external forge answer is deterministic.
const statuses = ['draft', 'review-required', 'changes-requested', 'checks-pending', 'checks-failing', 'ready', 'merged', 'closed', 'open', 'completed', 'not-planned'] as const
const cases = [...statuses, 'conflict'] as const
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/sidebar-reference-status')
const originalArgs = process.env.AGENT_BROWSER_ARGS
let browser: AgentBrowser
let server: ChildProcess
let root: string
let base: string
let project: string
const samples: Array<{ theme: string; state: string; status: string; glyph: ContrastSample; label: ContrastSample }> = []
const isIssue = (status: string) => ['open', 'completed', 'not-planned'].includes(status)
const row = (status: string) => `[data-slot="task-row"][data-run-id="ref-${status}"]`
const chip = (status: string) => `${row(status)} [data-slot="${isIssue(status) ? 'issue' : 'pr'}-chip"]`

beforeAll(async () => {
  process.env.AGENT_BROWSER_ARGS = [originalArgs, '--blink-settings=primaryHoverType=2'].filter(Boolean).join(',')
  root = mkdtempSync(join(tmpdir(), 'cez-ref-status-'))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  const now = Date.now()
  const records = cases.map((status, index) => ({
    id: `ref-${status}`, title: status, task: status, workflow: 'quick-task', runner: 'claude', status: 'done',
    createdAt: new Date(now - index * 60_000).toISOString(), finishedAt: new Date(now - index * 60_000).toISOString(),
    // Pinned rows bypass the sidebar recent-row cap, so every status is actually painted.
    tokensUsed: 0, archived: false, pinned: true,
    ...(isIssue(status) ? { referencedIssueUrl: `https://github.com/o/r/issues/${600 + index}` } : { pullRequestUrl: `https://github.com/o/r/pull/${600 + index}` }),
    steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 'reference-fixture' }],
  }))
  // Shared group issue and per-variant PRs travel through the same plain rendering.
  const variants = ['A', 'B'].map((variant, index) => ({
    ...records[0], id: `variant-${variant}`, title: 'Grouped references', groupId: 'references', variant,
    referencedIssueUrl: 'https://github.com/o/r/issues/609', pullRequestUrl: `https://github.com/o/r/pull/${605 + index}`,
  }))
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([...records, ...variants]))
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((done) => probe.close(() => done()))
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_SKILLS_AUTO_UPDATE: '0' }), stdio: 'ignore',
  })
  await waitForHealth(base)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`sidebar-reference-${process.pid}`)
  browser.setViewport(1440, 1100)
  browser.goto(base)
  mockForge()
  browser.goto(`${base}/p/${project}`)
  browser.waitForFunction(`document.querySelector('${chip('merged')} svg') !== null`)
}, 90_000)

afterAll(async () => {
  writeFileSync(join(artifacts, 'contrast.json'), JSON.stringify(samples, null, 2))
  browser?.close()
  if (originalArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
  else process.env.AGENT_BROWSER_ARGS = originalArgs
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

function mockForge() {
  browser.routeJson('**/github/ref-status?*', {
    available: true, recheckAfterMs: null, conflicts: [611],
    prs: Object.fromEntries(cases.flatMap((status, index) => isIssue(status) ? [] : [[600 + index, status === 'conflict' ? 'checks-pending' : status]])),
    issues: { 608: 'open', 609: 'completed', 610: 'not-planned' },
  })
}

function sample(theme: string, state: string, status: string) {
  const selector = chip(status)
  const result = browser.waitForValue(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const glyph = el?.querySelector('svg'), label = el?.querySelector('span')
    if (!glyph || !label) return null
    const rect = glyph.getBoundingClientRect(), text = label.getBoundingClientRect()
    return { glyph: ${contrastSampleExpression(`${selector} svg`)}, label: ${contrastSampleExpression(`${selector} > span`)},
      width: rect.width, height: rect.height, gap: text.left - rect.right,
      weight: getComputedStyle(label).fontWeight, fontSize: getComputedStyle(label).fontSize,
      color: getComputedStyle(label).color, metaColor: getComputedStyle(el.parentElement).color,
      border: getComputedStyle(el).borderWidth, background: getComputedStyle(el).backgroundColor }
  })()`) as { glyph: ContrastSample; label: ContrastSample; width: number; height: number; gap: number; weight: string; fontSize: string; color: string; metaColor: string; border: string; background: string }
  samples.push({ theme, state, status, glyph: result.glyph, label: result.label })
  expect(result.glyph.ratio, `${theme}/${state}/${status} glyph`).toBeGreaterThanOrEqual(3)
  expect(result).toMatchObject({ width: 10, height: 10, gap: 4, fontSize: '11.5px', border: '0px', background: 'rgba(0, 0, 0, 0)' })
  if (status === 'conflict') {
    expect(result.label.ratio, `${theme}/${state} conflict label`).toBeGreaterThanOrEqual(4.5)
    expect(result.weight).toBe('500')
    expect(result.label.foreground).toBe(result.glyph.foreground)
  } else expect(result.color).toBe(result.metaColor)
}

describe('sidebar reference status (#677)', () => {
  for (const theme of ['dark', 'light', 'system']) {
    it(`${theme}: all statuses retain glyph and label contrast on default, hovered and selected rows`, () => {
      browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
      browser.goto(`${base}/p/${project}`)
      browser.waitForFunction(`document.querySelector('${chip('conflict')} svg') !== null`)
      browser.moveTo(0, 0)
      for (const status of cases) sample(theme, 'default', status)
      browser.screenshot(join(artifacts, `${theme}-default.png`), { viewport: true })
      for (const status of cases) {
        // Hover the title, not the reference: the status panel must not mask row paint.
        hoverVisiblePoint(browser, `${row(status)} [data-slot="task-row-title"]`)
        sample(theme, 'hover', status)
        browser.click(`${row(status)} [data-slot="task-row-title"]`)
        browser.waitForFunction(`document.querySelector('${row(status)}[data-active="true"]') !== null`)
        browser.moveTo(0, 0)
        sample(theme, 'selected', status)
      }
      browser.screenshot(join(artifacts, `${theme}-selected-conflict.png`), { viewport: true })
    }, 180_000)
  }

  it('paints the shared group reference and each variant reference', () => {
    browser.goto(`${base}/p/${project}`)
    const group = '[data-slot="group-row"][data-group-id="references"]'
    browser.waitForFunction(`document.querySelector('${group} [data-slot="issue-chip"] svg') !== null`)
    const shared = browser.waitForValue(`document.querySelector('${group} [data-slot="issue-chip"] svg').getAttribute('class')`)
    expect(shared).toContain('text-merged-text')
    browser.click(`${group} [data-slot="group-tile"]`)
    for (const [variant, tone] of [['A', 'text-success'], ['B', 'text-merged-text']]) {
      const glyph = browser.waitForValue(`document.querySelector('[data-run-id="variant-${variant}"] [data-slot="pr-chip"] svg')?.getAttribute('class')`)
      expect(glyph).toContain(tone)
    }
  })

  it('desktop hover keeps Resolve conflicts reachable and delivers the numbered prompt', () => {
    browser.goto(`${base}/p/${project}`)
    hoverVisiblePoint(browser, chip('conflict'))
    browser.waitForFunction(`document.querySelector('[data-slot="reference-conflict-action"]:not([disabled])') !== null`)
    expect(browser.waitForValue(`getComputedStyle(document.querySelector('${chip('conflict')} > span')).textDecorationLine`)).toBe('underline')
    sample('desktop', 'reference-hover', 'conflict')
    // Capture only this fixture's outgoing continuation, leaving the delivery code real.
    browser.evaluate(`(() => {
      const original = window.fetch
      window.__referenceSent = null
      window.fetch = async (input, init) => {
        if (String(input).endsWith('/runs/ref-conflict/continue')) {
          window.__referenceSent = JSON.parse(init.body)
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return original(input, init)
      }
    })()`)
    browser.click('[data-slot="reference-conflict-action"]')
    const sent = browser.waitForValue(`window.__referenceSent`) as { text: string }
    expect(sent.text).toContain('611')
    expect(sent.text.toLowerCase()).toContain('conflict')
    browser.waitForFunction(`document.querySelector('[data-slot="reference-status-card"]') === null`)
  })

  it('360px inert rows retain status while the task header keeps full chips', () => {
    browser.close()
    if (originalArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
    else process.env.AGENT_BROWSER_ARGS = originalArgs
    browser = AgentBrowser.open(`sidebar-reference-touch-${process.pid}`)
    browser.goto(base)
    mockForge()
    browser.setViewport(360, 640)
    browser.setReducedMotion()
    for (const theme of ['dark', 'light']) {
      browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
      browser.goto(`${base}/p/${project}`)
      browser.click('[aria-label^="Open projects"]')
      expect(browser.waitForValue(`matchMedia('(hover: none)').matches`)).toBe(true)
      browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]')?.getBoundingClientRect().x === 0`)
      for (const status of cases) {
        const selector = `[data-slot="mobile-nav-drawer"] ${chip(status)}`
        const inert = browser.waitForValue(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!el?.querySelector('svg')) return null
          return { tag: el.tagName, inert: el.dataset.inert, links: el.querySelectorAll('a, button, [tabindex]').length,
            tone: el.querySelector('svg').getAttribute('class'), rowHeight: el.closest('[data-slot="task-row"]').getBoundingClientRect().height }
        })()`) as { tag: string; inert: string; links: number; tone: string; rowHeight: number }
        expect(inert).toMatchObject({ tag: 'SPAN', inert: 'true', links: 0 })
        expect(inert.rowHeight).toBeGreaterThanOrEqual(44)
        expect(inert.tone).not.toContain('text-accent')
      }
      expect(browser.waitForValue(`getComputedStyle(document.querySelector('[data-slot="mobile-nav-drawer"] ${chip('checks-pending')} svg')).animationName`)).toBe('none')
      browser.screenshot(join(artifacts, `${theme}-360-inert.png`), { viewport: true })
      browser.evaluate(`document.querySelector('[data-slot="mobile-nav-drawer"] ${chip('conflict')}').scrollIntoView({ block: 'center' })`)
      browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"] ${chip('conflict')}').getBoundingClientRect().bottom < innerHeight`)
      browser.screenshot(join(artifacts, `${theme}-360-conflict.png`), { viewport: true })
    }
    browser.goto(`${base}/p/${project}/tasks/ref-conflict`)
    browser.waitForFunction(`document.querySelector('[aria-label="Show run details"]') !== null`)
    browser.evaluate(`document.querySelector('[aria-label="Show run details"]').focus()`)
    browser.press('Enter')
    const header = browser.waitForValue(`(() => {
      const el = document.querySelector('[data-slot="run-meta"] [data-slot="pr-chip"]')
      if (!el || el.getBoundingClientRect().height === 0) return null
      return { tag: el.tagName, tone: el.className, height: el.getBoundingClientRect().height }
    })()`) as { tag: string; tone: string; height: number }
    expect(header.tag).toBe('A')
    expect(header.tone).toContain('text-conflict')
    expect(header.tone).toContain('border-conflict')
    expect(header.height).toBeGreaterThanOrEqual(44)
  }, 90_000)
})
