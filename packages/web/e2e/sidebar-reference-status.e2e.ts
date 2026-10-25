import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForSettledSample } from './visual-ready'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { contrastSampleExpression, hoverVisiblePoint, type ContrastSample } from './contrast'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { openSessionActivityRow } from './session-activity'
// fixture-server starts: 1

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
  execFileSync('git', ['-C', root, 'init', '-q'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'e2e@cezar.test'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'cezar e2e'])
  writeFileSync(join(root, 'README.md'), '# Reference status fixture\n')
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'init'])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/o/r.git'])
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
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(records))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root), stdio: 'ignore',
  })
  base = await waitForFixtureServer(server)
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
  const result = waitForSettledSample(browser, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const glyph = el?.querySelector('svg:not([data-slot="reference-kind"])'), label = el?.querySelector('span')
    if (!glyph || !label) return null
    const rect = glyph.getBoundingClientRect(), text = label.getBoundingClientRect()
    return { glyph: ${contrastSampleExpression(`${selector} svg:not([data-slot="reference-kind"])`)}, label: ${contrastSampleExpression(`${selector} > span`)},
      width: rect.width, height: rect.height, gap: text.left - el.querySelector('[data-slot="reference-kind"]').getBoundingClientRect().right,
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

  it('desktop hover keeps Resolve conflicts reachable and delivers the numbered prompt', () => {
    browser.goto(`${base}/p/${project}`)
    // Hover the chip only after the sidebar has finished hydrating. Until the project's repository URL
    // and the forge status arrive, the quick list paints a bare external link and then re-creates every
    // chip (in-app link, hover card, `data-conflicting`) under a stationary pointer. Chrome answers that
    // swap with `pointerover` on the new chip, and only sometimes with the `pointerout` on the old target
    // that React derives `onPointerEnter` from; without it the card's open timer never starts, while CSS
    // `:hover` still applies. The final form is the chip with its hover card and conflict action.
    // Evidence: this test failed with "predicate never became truthy: document.querySelector('[data-slot=
    // "reference-conflict-action"]:not([disabled])') !== null" (bundle
    // .ai/qa/failures/sidebar-reference-status/desktop-hover-keeps-Resolve-conflicts-reachable-and-delivers-the-numbered-prompt-1/:
    // probe.json `kind: wait-fn` with no open dialog, snapshot.txt the `conflict#611` link `expanded=false`;
    // `cockpit-failures-shard-3` artifacts of CI run 40226458126 (job 121268830602) and run 40233020461
    // (jobs 121289165017 and 121292450976), hearsay-tools/cezarion#1848). Reproduce with the README's
    // "Specs that boot their own server" delay recipe (GET /health and /projects held 1000 ms) and
    // `npm run test:e2e -- sidebar-reference-status.e2e.ts -t 'desktop hover keeps Resolve conflicts'` —
    // 6 of 10 runs failed before (4 with this error, 2 with the underline check below), 10 of 10 passed
    // after; with no delay, 0 of 10 failed before and 10 of 10 passed after.
    browser.waitForStable(`document.querySelector('${chip('conflict')}[data-conflicting="true"][aria-haspopup="dialog"]') !== null && window.__cezIdle === true`, { holdMs: 150 })
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

  it('touch-pointer inert rows retain status while the 360px task header keeps full chips', () => {
    browser.close()
    if (originalArgs === undefined) delete process.env.AGENT_BROWSER_ARGS
    else process.env.AGENT_BROWSER_ARGS = originalArgs
    browser = AgentBrowser.open(`sidebar-reference-touch-${process.pid}`)
    browser.goto(base)
    mockForge()
    // The inert row is a `hover: none` affordance, not a width one. The phone drawer no longer
    // holds the quick list (#621), so the rows are measured in the desktop sidebar of this
    // hover-less browser; the 360px half of the test is the task header below.
    browser.setViewport(1440, 900)
    browser.setReducedMotion()
    for (const theme of ['dark', 'light']) {
      browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
      browser.goto(`${base}/p/${project}`)
      expect(browser.waitForValue(`matchMedia('(hover: none)').matches`)).toBe(true)
      for (const status of cases) {
        const selector = `[data-slot="sidebar"] ${chip(status)}`
        const inert = waitForSettledSample(browser, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!el?.querySelector('svg:not([data-slot="reference-kind"])')) return null
          return { tag: el.tagName, inert: el.dataset.inert, links: el.querySelectorAll('a, button, [tabindex]').length,
            tone: el.querySelector('svg:not([data-slot="reference-kind"])').getAttribute('class'), rowHeight: el.closest('[data-slot="task-row"]').getBoundingClientRect().height }
        })()`) as { tag: string; inert: string; links: number; tone: string; rowHeight: number }
        expect(inert).toMatchObject({ tag: 'SPAN', inert: 'true', links: 0 })
        expect(inert.rowHeight).toBeGreaterThanOrEqual(44)
        expect(inert.tone).not.toContain('text-accent')
      }
      expect(browser.waitForValue(`getComputedStyle(document.querySelector('[data-slot="sidebar"] ${chip('checks-pending')} svg:not([data-slot="reference-kind"])')).animationName`)).toBe('none')
      browser.screenshot(join(artifacts, `${theme}-touch-inert.png`), { viewport: true })
      browser.evaluate(`document.querySelector('[data-slot="sidebar"] ${chip('conflict')}').scrollIntoView({ block: 'center' })`)
      browser.waitForFunction(`document.querySelector('[data-slot="sidebar"] ${chip('conflict')}').getBoundingClientRect().bottom < innerHeight`)
      browser.screenshot(join(artifacts, `${theme}-touch-conflict.png`), { viewport: true })
    }
    browser.setViewport(360, 640)
    browser.goto(`${base}/p/${project}/tasks/ref-conflict`)
    // The task's chips live in the Session activity card's Workspace row (hearsay-tools/cezarion#1333).
    openSessionActivityRow(browser, 'workspace')
    const header = waitForSettledSample(browser, `(() => {
      const el = document.querySelector('[data-slot="run-activity-workspace"] [data-slot="pr-chip"]')
      if (!el || el.getBoundingClientRect().height === 0) return null
      return { tag: el.tagName, tone: el.className, height: el.getBoundingClientRect().height }
    })()`) as { tag: string; tone: string; height: number }
    expect(header.tag).toBe('A')
    expect(header.tone).toContain('text-conflict')
    expect(header.tone).toContain('border-conflict')
    expect(header.height).toBeGreaterThanOrEqual(44)
  }, 90_000)
})
