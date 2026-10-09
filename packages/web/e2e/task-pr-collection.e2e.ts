import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, HOVER_POINTER_ARGS, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { dismissWithEscape, hoverVisiblePoint } from './contrast'
import { waitForSettledSample } from './visual-ready'

// hearsay-tools/cezarion#922: real persistence, summaries, routing and browser layout.
// Native-wire ingestion is covered separately by the exhaustive PR1/PR2 regressions.
const numbers = [128, 129, 130, 131, 132]
const id = 'collection'
const panel = '[data-slot="reference-overflow-list"]'
const row = `[data-slot="task-row"][data-run-id="${id}"]`
const globalRow = `[data-slot="global-task-row"][data-run-id="${id}"]`
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/issue-922')
let browser: AgentBrowser
let server: ChildProcess
let root: string
let base: string
let project: string
const taskPath = (number?: number) => `/p/${project}/tasks/${id}${number ? `/pr/${number}` : ''}`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-pr-collection-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(root, 'README.md'), '# PR collection fixture\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  git('remote', 'add', 'origin', 'git@github.com:mock/repo.git')
  const record = { id, title: 'Split work', task: 'Split work', workflow: 'quick-task', status: 'review',
    archived: false, pinned: true, createdAt: new Date().toISOString(), tokensUsed: 0, steps: [],
    pullRequests: numbers.map(number => ({ number, url: `https://github.com/mock/repo/pull/${number}`, source: 'created' })),
    issueNumber: 142 }
  const group = ['A', 'B'].map((variant, index) => ({ ...record, id: `group-${variant}`, title: 'Grouped work', groupId: 'collection-group', variant,
    runner: 'claude', inputTokens: 100000, outputTokens: 200000,
    pullRequests: [...record.pullRequests, ...Array.from({ length: 10 }, (_, n) => ({ number: 200 + index * 20 + n, url: `https://github.com/mock/repo/pull/${200 + index * 20 + n}`, source: 'created' }))] }))
  mkdirSync(join(root, '.ai/cezar'), { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([record, ...group,
    { ...record, id: 'long', title: 'Long collection', issueNumber: undefined, pullRequests: Array.from({ length: 25 }, (_, n) => ({ number: 300 + n, url: `https://github.com/mock/repo/pull/${300 + n}`, source: 'created' })) },
    { ...record, id: 'legacy', title: 'Legacy task', pullRequests: undefined, prNumber: 128, issueNumber: undefined }]))
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_SKILLS_AUTO_UPDATE: '0' }), stdio: 'ignore',
  })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`pr-collection-${process.pid}`, { launchArgs: HOVER_POINTER_ARGS })
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (root) rmSync(root, { recursive: true, force: true })
})

function assertDestinations() {
  const destinations = browser.waitForValue<string[]>(`(() => {
    const list = document.querySelector('${panel}')
    return list ? [...list.querySelectorAll('a')].map(a => a.getAttribute('href')) : null
  })()`)
  expect(destinations).toEqual([...numbers.map(taskPath), `/p/${project}/tasks/${id}/issue/142`])
}

/** A settled native tap. The row's reference line can re-wrap one re-render after the sample —
 *  instrumented runs measured the trigger sampled at y321 and painted at y349 400ms later
 *  (failure bundle searches-every-hidden-PR-…-12; the same race red the four-lane lane 2) —
 *  so a tap can land on geometry that moved. The retry is narrowed to exactly that: the effect
 *  wait failing while the target STAYED where it was sampled is a real failure and fails the
 *  spec right there, so an unrelated first-tap defect cannot pass behind a second tap. */
async function nativeTap(selector: string, effect?: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await browser.enableTouch()
    browser.waitForValue(`!!document.querySelector(${JSON.stringify(selector)})`)
    browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', inline: 'nearest' })`)
    const point = waitForSettledSample<{ x: number; y: number }>(browser, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`, () => true, selector)
    await browser.touchTapAt(point.x, point.y)
    if (effect === undefined) return
    try {
      browser.waitForValue(effect, undefined, { timeoutMs: 1_500, failure: 'tap had no effect' })
      return
    } catch {
      const moved = browser.waitForValue<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null
        const r = el.getBoundingClientRect()
        return Math.abs(r.x + r.width / 2 - ${point.x}) > 1 || Math.abs(r.y + r.height / 2 - ${point.y}) > 1
      })()`, (value): value is boolean => typeof value === 'boolean', { timeoutMs: 2_000, failure: 'tap target vanished after the tap' })
      if (!moved) throw new Error(`cezar e2e: tap had no effect and ${selector} stayed where it was sampled — not the re-wrap race, a real failure`)
    }
  }
  browser.waitForValue(`!!(${effect!})`)
}

describe('complete task PR collection', () => {
  it('opens all five item tabs, including items behind header overflow', () => {
    browser.setViewport(1280, 900)
    for (const number of numbers) {
      browser.goto(`${base}${taskPath()}`)
      const direct = `[data-slot="run-tabs"] a[href$="/pr/${number}"]`
      const available = browser.waitForValue<boolean>(`(() => {
        if (!document.querySelector('[data-slot="run-tabs"]')) return null
        return !!document.querySelector('${direct}')
      })()`, value => typeof value === 'boolean')
      if (!available) browser.click('[data-slot="run-tabs"] button[aria-label$="more linked items"]')
      browser.click(available ? direct : `[role="menuitem"][href$="/pr/${number}"]`)
      expect(browser.waitForValue(`location.pathname.endsWith('/pr/${number}')`)).toBe(true)
      expect(browser.waitForValue(`(() => { const text = document.querySelector('[data-slot="run-tabs"] [aria-current="page"]')?.textContent; return text?.includes('#${number}') ? text : null })()`)).toContain(`#${number}`)
    }
  })

  it('keeps every sidebar reference reachable with hover and keyboard in both themes', () => {
    browser.setViewport(1280, 900)
    for (const theme of ['light', 'dark']) {
      browser.goto(`${base}/p/${project}`)
      browser.evaluate(`document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${theme}')`)
      const trigger = `${row} [data-slot="reference-overflow"]`
      const facts = waitForSettledSample<{ count: number; labels: string[]; title: string; fits: boolean }>(browser, `(() => {
        const el = document.querySelector('${row}'), button = el?.querySelector('[data-slot="reference-overflow"]')
        if (!button) return null
        const box = button.getBoundingClientRect(), line = el.getBoundingClientRect()
        return { count: el.querySelectorAll('[data-slot="pr-chip"]').length,
          labels: [...el.querySelectorAll('[data-slot="pr-chip"]')].map(e => e.textContent), title: button.title,
          fits: box.width > 0 && box.left >= line.left && box.right <= line.right }
      })()`)
      expect(facts.count).toBeLessThanOrEqual(2)
      expect(facts.labels.every(label => /^#\d+$/.test(label))).toBe(true)
      expect(facts.title).toContain('PR #132')
      expect(facts.fits).toBe(true)
      hoverVisiblePoint(browser, trigger)
      assertDestinations()
      browser.moveTo(0, 0)
      browser.waitForValue(`document.querySelector('${panel}') === null`)
      browser.evaluate(`document.querySelector('${trigger}').focus()`)
      browser.press('Enter')
      assertDestinations()
      dismissWithEscape(browser, { content: panel, focus: trigger })
      browser.screenshot(join(artifacts, `sidebar-${theme}.png`), { viewport: true })
    }
    const legacy = browser.waitForValue(`document.querySelector('[data-run-id="legacy"] [data-slot="pr-chip"]')?.textContent`)
    expect(legacy).toBe('#128')
  })

  it('keeps group and variant overflow operable at narrow pointer widths', () => {
    browser.setViewport(1280, 900)
    browser.goto(`${base}/p/${project}`)
    browser.evaluate(`localStorage.setItem('cez-sidebar-width', '264')`)
    browser.goto(`${base}/p/${project}`)
    const group = '[data-slot="group-row"][data-group-id="collection-group"]'
    const trigger = `${group} [data-slot="reference-overflow"]`
    const available = waitForSettledSample<boolean>(browser, `(() => {
      const el = document.querySelector('${trigger}'); if (!el) return null
      return !el.closest('[data-ellipsis-hidden]') && getComputedStyle(el).pointerEvents !== 'none'
    })()`)
    expect(available).toBe(true)
    hoverVisiblePoint(browser, trigger)
    browser.waitForValue(`!!document.querySelector('${panel}')`)
    browser.moveTo(0, 0)
    browser.waitForValue(`document.querySelector('${panel}') === null`)
    browser.click(`${group} [data-slot="group-tile"]`)
    const variant = '[data-run-id="group-A"] [data-slot="reference-overflow"]'
    const usable = waitForSettledSample<boolean>(browser, `(() => {
      const el = document.querySelector('${variant}'); if (!el) return null
      return !el.closest('[data-ellipsis-hidden]') && getComputedStyle(el).pointerEvents !== 'none'
    })()`)
    expect(usable).toBe(true)
    hoverVisiblePoint(browser, variant)
    expect(browser.waitForValue(`document.querySelector('${panel}')?.textContent`)).toContain('#209')
    browser.moveTo(0, 0)
    browser.waitForValue(`document.querySelector('${panel}') === null`)
  })

  it('searches every hidden PR and opens global overflow at 320px and 360px', async () => {
    browser.close()
    browser = AgentBrowser.open(`pr-collection-mobile-${process.pid}`)
    for (const width of [320, 360]) {
      browser.setViewport(width, 640)
      browser.goto(`${base}/tasks`)
      const search = (query: string, matches: boolean, legacy = false) => {
        browser.fill('input[aria-label="Search tasks across projects"]', query)
        // The row also exists before search. Wait for the debounced URL and its results.
        // Provenance: CI run 37916953893 browser shard 3 failure bundle (artifact
        // cockpit-failures-shard-3) probed /tasks?q=%23132 at 360px when nativeTap
        // fired on a stale page; locally a 10 s search debounce reproduces it (the old
        // row wait passed with q=null instead of #128) and this settlement wait is green.
        expect(browser.waitForValue(`(() => {
          return new URLSearchParams(location.search).get('q') === ${JSON.stringify(query)} &&
            document.querySelector('input[aria-label="Search tasks across projects"]')?.value === ${JSON.stringify(query)} &&
            !!document.querySelector('${globalRow}') === ${matches} &&
            !!document.querySelector('[data-slot="global-task-row"][data-run-id="legacy"]') === ${legacy} &&
            !document.querySelector('[data-slot="global-task-row"][data-run-id="long"]')
        })()`)).toBe(true)
      }
      search('#999999', false)
      for (const number of numbers) {
        search(`#${number}`, true, number === 128)
      }
      const trigger = `${globalRow} [data-slot="reference-overflow"]`
      await nativeTap(trigger, `document.querySelector('${panel}') !== null`)
      assertDestinations()
      expect(browser.waitForValue(`location.pathname`)).toBe('/tasks')
      dismissWithEscape(browser, { content: panel, focus: trigger })
      await nativeTap(trigger, `document.querySelector('${panel}') !== null`)
      await nativeTap(`${panel} a[href$="/pr/132"]`, `location.pathname === '${taskPath(132)}'`)
      expect(browser.waitForValue(`location.pathname === '${taskPath(132)}'`)).toBe(true)
      browser.screenshot(join(artifacts, `mobile-${width}.png`), { viewport: true })
    }
  })

  it('scrolls a long collection inside a small touch viewport', async () => {
    browser.setViewport(360, 640)
    browser.goto(`${base}/tasks`)
    browser.fill('input[aria-label="Search tasks across projects"]', 'Long collection')
    browser.evaluate(`document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')`)
    browser.waitForValue(`!!document.querySelector('[data-slot="global-task-row"][data-run-id="long"] [data-slot="reference-overflow"]')`)
    browser.evaluate(`document.querySelector('[data-slot="global-task-row"][data-run-id="long"] [data-slot="reference-overflow"]').focus()`)
    browser.press('Enter')
    const sizes = waitForSettledSample<{ height: number; client: number; scroll: number }>(browser, `(() => {
      const el = document.querySelector('${panel}'); if (!el) return null
      return { height: el.getBoundingClientRect().height, client: el.clientHeight, scroll: el.scrollHeight }
    })()`, () => true, panel)
    expect(sizes.height).toBeLessThanOrEqual(624)
    expect(sizes.scroll).toBeGreaterThan(sizes.client)
    browser.evaluate(`document.querySelector('${panel} a[href$="/pr/324"]').scrollIntoView({ block: 'nearest' })`)
    await nativeTap(`${panel} a[href$="/pr/324"]`, `location.pathname.endsWith('/tasks/long/pr/324')`)
    expect(browser.waitForValue(`location.pathname.endsWith('/tasks/long/pr/324')`)).toBe(true)
  })

  it('touch overflow is outside the group toggle and never toggles or navigates', async () => {
    browser.close()
    browser = AgentBrowser.open(`pr-collection-touch-${process.pid}`)
    browser.setViewport(1280, 900)
    browser.goto(`${base}/p/${project}`)
    const single = `${row} [data-slot="reference-overflow"]`
    const hitArea = waitForSettledSample<number>(browser, `(() => {
      const el = document.querySelector('${single}'); if (!el) return null
      let top = el.getBoundingClientRect().top, bottom = el.getBoundingClientRect().bottom
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowY === 'hidden') { const r = parent.getBoundingClientRect(); top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom) }
      }
      return bottom - top
    })()`)
    expect(hitArea).toBeGreaterThanOrEqual(44)
    const group = '[data-slot="group-row"][data-group-id="collection-group"]'
    const trigger = `${group} [data-slot="reference-overflow"]`
    const target = browser.waitForValue<{ x: number; y: number; nested: boolean; height: number }>(`(() => {
      const el = document.querySelector('${trigger}'); if (!el) return null
      const r = el.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2,
        nested: !!el.closest('[data-slot="group-tile"]'), height: r.height }
    })()`)
    expect(target.nested).toBe(false)
    expect(target.height).toBeGreaterThanOrEqual(44)
    await nativeTap(trigger, `document.querySelector('${panel}') !== null`)
    const state = browser.waitForValue<{ open: boolean; expanded: string; path: string }>(`(() => {
      if (!document.querySelector('${panel}')) return null
      return { open: true, expanded: document.querySelector('${group} [data-slot="group-tile"]').getAttribute('aria-expanded'), path: location.pathname }
    })()`)
    expect(state).toEqual({ open: true, expanded: 'false', path: `/p/${project}` })
  })
})
