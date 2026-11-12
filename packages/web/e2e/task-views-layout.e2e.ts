import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { RunRecord } from '@open-mercato/cezar-api-client/contract/runs'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { seedRuns, recordedRun } from './seed-runs'
import { settleVisual } from './visual-ready'
import { dismissWithEscape } from './contrast'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { waitForHealth, pollFor, pollJson } from './poll'
import recordJson from './fixtures/thread-run.record.json'
// fixture-server starts: 1

const record = recordedRun(recordJson)

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/task-views')
let root: string, base: string, project: string, automationId: string
let server: ChildProcess, browser: AgentBrowser
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-task-views-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@cezar.test'); git('config', 'user.name', 'Fixture')
  writeFileSync(join(root, 'README.md'), '# Task views fixture\n'); git('add', '.'); git('commit', '-qm', 'Fixture')
  mkdirSync(join(root, '.ai/cezar/runs'), { recursive: true })
  const runs = ['A', 'B'].map((variant) => {
    const worktreePath = join(root, '.ai/cezar/worktrees', `fixture-${variant}`)
    git('worktree', 'add', '-b', `cez/fixture-${variant}`, worktreePath, 'main')
    writeFileSync(join(worktreePath, 'comparison.md'), `# Variant ${variant}\nDifferent implementation ${variant}.\n`)
    execFileSync('git', ['-C', worktreePath, 'add', 'comparison.md'])
    execFileSync('git', ['-C', worktreePath, 'commit', '-qm', `Variant ${variant}`])
    return ({ ...record, id: `fixture-${variant}`, title: `Validate task views (${variant})`, status: RUN_STATUS.done, archived: false, worktreePath, branch: `cez/fixture-${variant}`, inputTokens: 42000, outputTokens: 6000, costUsd: 0.42, peakRssBytes: 440401920, diffStat: { adds: 2, dels: 0, files: 1 } } satisfies Partial<RunRecord>)
  })
  seedRuns(root, runs)
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', root, '--port', '0', '--no-open'], { env: fixtureServeEnv(root, { CEZ_AUTOMATIONS: '1' }), stdio: 'ignore' })
  base = await waitForFixtureServer(server)
  project = await bootProjectId(base)
  // The fixture has no GitHub remote, so create refuses a GitHub automation (#766); a schedule needs none.
  const response = await fetch(`${base}/api/v1/automations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nightly review', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Review the open work on {{date}}', workflow: 'quick-task' }, enable: false }) })
  expect(response.ok).toBe(true)
  automationId = (await response.json()).automation.id
  browser = AgentBrowser.open(`task-views-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
}, 60_000)
afterAll(async () => { browser?.close(); await stopFixtureServer(server); if (root) rmSync(root, { recursive: true, force: true }) })
const scoped = (path: string) => `/p/${project}${path}`
const prepare = (width: number, theme: string, idle = true) => {
  // Appearance hydration can overwrite a cold-navigation override after the route mounts.
  if (idle) browser.waitForStable(`window.__cezIdle === true`, { holdMs: 200 })
  browser.setViewport(width, width < 768 ? 640 : 900)
  browser.evaluate(`document.documentElement.classList.toggle('light', '${theme}' === 'light'); document.documentElement.classList.toggle('dark', '${theme}' === 'dark'); document.documentElement.dataset.width = 'wide'`)
}
it('renders assigned task flows at 1440 Wide, 402 and 360 in both themes without page overflow', () => {
  const pages: Array<[string, string, string]> = [
    ['project', scoped('/'), '[data-slot="tasks-summary"], [data-slot="task-cards"]'], ['global', '/tasks?group=project', '[data-slot="global-task-row"]'],
    ['inbox', scoped('/inbox'), '[data-route="inbox"]'], ['automations', scoped('/automations'), '[data-route="automations"] [data-slot="automation-card"]'],
    ['editor', scoped(`/automations/${automationId}`), '#automation-name'],
  ]
  for (const width of [1440, 402, 360]) for (const theme of ['light', 'dark']) for (const [name, path, selector] of pages) {
    browser.goto(base + path)
    browser.waitForFunction(`document.querySelector('${selector}') !== null`)
    prepare(width, theme)
    const visualTarget = name === 'project' ? '[data-route="tasks"]' : selector
    settleVisual(browser, visualTarget, { theme, width: 'wide', idle: true })
    expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    if (name === 'editor') expect(browser.evaluate(`document.querySelector('.automation-editor [data-slot="switch"]').getBoundingClientRect().right <= innerWidth`)).toBe(true)
    browser.screenshot(join(artifacts, `${name}-${width}-${theme}.png`))
  }
}, 180_000)
it('persists column choices, filters projects, and expands mobile resources through real controls', async () => {
  const reset = await fetch(`${base}/api/v1/workspace/ui-state`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskTable: { expandedColumns: { branch: false } } }),
  })
  expect(reset.ok).toBe(true)
  browser.goto(base + scoped('/')); prepare(1440, 'light')
  browser.waitForFunction(`document.querySelector('[data-slot="tasks-summary"], [data-slot="task-cards"]') !== null`)
  browser.click('[data-slot="task-columns-trigger"]')
  browser.waitForFunction(`document.querySelector('[data-column-toggle="branch"]')?.checked === false`)
  browser.click('[data-column-toggle="branch"]')
  browser.waitForFunction(`document.querySelector('[data-column-toggle="branch"]')?.checked === true`)
  dismissWithEscape(browser, { content: '[data-slot="popover-content"]', focus: '[data-slot="task-columns-trigger"]' })
  const state = await pollFor(async signal => {
    const state = await pollJson<{ taskTable?: { expandedColumns?: { branch?: boolean | undefined } } }>(`${base}/api/v1/workspace/ui-state`, signal)
    return state.taskTable?.expandedColumns?.branch === true ? state : undefined
  }, () => 'workspace UI state never persisted expanded branch column', { timeoutMs: 10_000 })
  expect(state.taskTable?.expandedColumns?.branch).toBe(true)
  browser.goto(base + scoped('/')); prepare(360, 'dark')
  browser.waitForFunction(`document.querySelector('[data-slot="task-card"]') !== null`)
  const toggle = '[data-slot="task-card"][data-run-id="fixture-A"] [data-slot="mobile-resources-toggle"]'
  // The native click helper scrolls only outside the viewport, not past fixed phone navigation.
  browser.evaluate(`document.querySelector('${toggle}').scrollIntoView({ block: 'center', behavior: 'instant' })`)
  browser.waitForFunction(`(() => { const e = document.querySelector('${toggle}'); const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })()`)
  browser.click(toggle)
  expect(browser.waitForValue(`document.querySelector('[data-slot="task-card"][data-run-id="fixture-A"]')?.textContent.includes('Memory')`)).toBe(true)
  browser.screenshotElement('[data-slot="task-card"][data-run-id="fixture-B"]', join(artifacts, 'last-mobile-card-clear.png'))
  browser.goto(base + '/tasks?project=missing&group=project')
  browser.waitForFunction(`document.body.textContent.includes('No matching tasks')`)
  browser.click('[data-action="clear-filters"]')
  browser.waitForFunction(`document.querySelectorAll('[data-slot="global-task-row"]').length === 2`)
}, 60_000)
it('renders loading, retryable error, and filtered-empty states in both themes and phone widths', async () => {
  const faultFile = join(root, 'http-fault.txt')
  writeFileSync(faultFile, 'none')
  const port = await new Promise<number>((done) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => done(port)) }) })
  // AgentBrowser uses synchronous CLI calls: the fault proxy must own another event loop.
  const proxy = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer, request } from 'node:http';
    import { readFileSync } from 'node:fs';
    const [base, faultFile, port] = process.argv.slice(1);
    createServer((incoming, outgoing) => {
      const fault = readFileSync(faultFile, 'utf8');
      if (incoming.url.split('?')[0].endsWith('/run-summaries') && fault !== 'none') {
        const answer = () => { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'Fixture service unavailable' })); };
        if (fault === 'loading') { const timer = setInterval(() => { if (readFileSync(faultFile, 'utf8') !== 'loading') { clearInterval(timer); answer(); } }, 50); outgoing.on('close', () => clearInterval(timer)); }
        else answer();
        return;
      }
      const upstream = request(new URL(incoming.url, base), { method: incoming.method, headers: incoming.headers }, (response) => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
      upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); }); incoming.pipe(upstream); outgoing.on('close', () => upstream.destroy());
    }).listen(Number(port), '127.0.0.1');
  `, base, faultFile, String(port)], { stdio: 'ignore' })
  const origin = `http://localhost:${port}`
  await waitForHealth(origin, 'the fault-injecting proxy', { tries: 40, intervalMs: 100 })
  try {
    for (const width of [1440, 402, 360]) for (const theme of ['light', 'dark']) {
      writeFileSync(faultFile, 'loading')
      browser.goto(origin + scoped('/'))
      browser.waitForFunction(`document.querySelector('[aria-label="Loading tasks"]') !== null`)
      prepare(width, theme, false)
      browser.screenshot(join(artifacts, `loading-${width}-${theme}.png`))
      writeFileSync(faultFile, 'error')
      browser.waitForFunction(`document.body.textContent.includes('Could not load tasks')`)
      browser.screenshot(join(artifacts, `error-${width}-${theme}.png`))
      writeFileSync(faultFile, 'none')
      browser.click('[data-route="tasks"] [role="alert"] button')
      browser.waitForFunction(`document.querySelector('[data-slot="tasks-summary"], [data-slot="task-cards"]') !== null`)
      expect(browser.url()).toContain(scoped('/'))
      browser.fill('[aria-label="Search tasks"]', 'nothing-matches-this-fixture')
      browser.waitForFunction(`document.body.textContent.includes('No matching tasks')`)
      browser.screenshot(join(artifacts, `empty-${width}-${theme}.png`))
    }
  } finally { await stopFixtureServer(proxy) }
}, 90_000)
