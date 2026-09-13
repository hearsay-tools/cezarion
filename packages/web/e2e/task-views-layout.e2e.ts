import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/thread-run.record.json'

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
    return { ...record, id: `fixture-${variant}`, title: `Validate task views (${variant})`, status: 'done', groupId: 'fixture-group', variant, archived: false, worktreePath, branch: `cez/fixture-${variant}`, inputTokens: 42000, outputTokens: 6000, costUsd: 0.42, peakRssBytes: 440401920, diffStat: { adds: 2, dels: 0, files: 1 } }
  })
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(runs))
  writeFileSync(join(root, '.ai/cezar/todos.json'), JSON.stringify([
    { id: 'follow-up', summary: 'Validate task layouts on desktop and mobile.', suggestedPrompt: 'Check task views.', runnable: true, taskId: 'fixture-A' },
    { id: 'note', summary: 'Review the proposed chain before starting work.', runnable: false, taskId: 'fixture-B' },
  ]))
  const port = await new Promise<number>((done) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => done(port)) }) })
  base = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root, { CEZ_FOLLOWUPS: '1', CEZ_AUTOMATIONS: '1' }), stdio: 'ignore' })
  for (let attempt = 0; attempt < 60; attempt++) { try { if ((await fetch(`${base}/api/v1/health`)).ok) break } catch {} await new Promise((done) => setTimeout(done, 250)) }
  project = await bootProjectId(base)
  const response = await fetch(`${base}/api/v1/automations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Review new pull requests', events: ['pull_request.opened'], intervalSeconds: 86400, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}', workflow: 'quick-task' }, enable: false }) })
  expect(response.ok).toBe(true)
  automationId = (await response.json()).automation.id
  browser = AgentBrowser.open(`task-views-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
}, 60_000)
afterAll(() => { browser?.close(); server?.kill(); if (root) rmSync(root, { recursive: true, force: true }) })
const scoped = (path: string) => `/p/${project}${path}`
const prepare = (width: number, theme: string) => {
  browser.setViewport(width, 1000)
  browser.evaluate(`document.documentElement.classList.toggle('light', '${theme}' === 'light'); document.documentElement.classList.toggle('dark', '${theme}' === 'dark'); document.documentElement.dataset.width = 'wide'`)
}
it('renders assigned task flows at 1440 Wide, 402 and 360 in both themes without page overflow', () => {
  const pages = [
    ['project', scoped('/'), '[data-slot="tasks-table"]'], ['global', '/tasks?group=project', '[data-slot="global-task-row"]'],
    ['inbox', scoped('/inbox'), '[data-slot="todo-card"]'], ['automations', scoped('/automations'), '[data-route="automations"] article'],
    ['editor', scoped(`/automations/${automationId}`), '#automation-name'], ['compare', scoped('/compare/fixture-group'), '[data-slot="variant-column"]'],
  ]
  for (const width of [1440, 402, 360]) for (const theme of ['light', 'dark']) for (const [name, path, selector] of pages) {
    browser.goto(base + path)
    browser.waitForFunction(`document.querySelector('${selector}') !== null`)
    prepare(width, theme)
    if (name === 'inbox') browser.click('[data-slot="todo-instructions-toggle"]')
    expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    if (name === 'editor') expect(browser.evaluate(`document.querySelector('.automation-editor input[type="checkbox"]').getBoundingClientRect().right <= innerWidth`)).toBe(true)
    browser.evaluate('new Promise((done) => setTimeout(done, 250))')
    browser.screenshot(join(artifacts, `${name}-${width}-${theme}.png`))
  }
}, 180_000)
it('persists column choices, filters projects, and expands mobile resources through real controls', async () => {
  browser.goto(base + scoped('/')); prepare(1440, 'light')
  browser.waitForFunction(`document.querySelector('[data-slot="tasks-table"]') !== null`)
  browser.click('[data-slot="task-columns-trigger"]')
  browser.click('[data-column-toggle="branch"]')
  browser.press('Escape')
  const state = await fetch(`${base}/api/v1/workspace/ui-state`).then((r) => r.json())
  expect(state.taskTable.expandedColumns.branch).toBe(true)
  browser.goto(base + scoped('/')); prepare(360, 'dark')
  browser.waitForFunction(`document.querySelector('[data-slot="task-card"]') !== null`)
  browser.click('[data-slot="task-card"]:first-child [data-slot="mobile-resources-toggle"]')
  expect(browser.text('[data-slot="task-card"]:first-child')).toContain('Memory')
  browser.goto(base + '/tasks?project=missing&group=project')
  browser.waitForFunction(`document.body.textContent.includes('No matching tasks')`)
  browser.click('[data-action="clear-filters"]')
  browser.waitForFunction(`document.querySelectorAll('[data-slot="global-task-row"]').length === 2`)
}, 60_000)
it('keeps comparison selection behind confirmation and acknowledges a note through the API', () => {
  browser.goto(base + scoped('/compare/fixture-group')); prepare(402, 'light')
  browser.waitForFunction(`document.querySelector('[data-slot="variant-pick"]') !== null`)
  browser.click('[data-slot="variant-column"]:first-child [data-slot="variant-pick"]')
  browser.waitForFunction(`document.querySelector('[data-slot="confirm-pick"]') !== null`)
  expect(browser.text('[role="alertdialog"]')).toContain('no undo')
  browser.click('[data-slot="alert-dialog-cancel"]')
  browser.goto(base + scoped('/inbox'))
  browser.waitForFunction(`document.querySelector('[data-action="todo-acknowledge"]') !== null`)
  browser.click('[data-action="todo-acknowledge"]')
  browser.waitForFunction(`document.querySelectorAll('[data-slot="todo-card"]').length === 1`)
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
      if (incoming.url.endsWith('/runs') && fault !== 'none') {
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
  for (let attempt = 0; attempt < 40; attempt++) { try { if ((await fetch(origin + '/api/v1/health')).ok) break } catch {} await new Promise((done) => setTimeout(done, 100)) }
  try {
    for (const width of [1440, 402, 360]) for (const theme of ['light', 'dark']) {
      writeFileSync(faultFile, 'loading')
      browser.goto(origin + scoped('/'))
      browser.waitForFunction(`document.querySelector('[aria-label="Loading tasks"]') !== null`)
      prepare(width, theme)
      browser.screenshot(join(artifacts, `loading-${width}-${theme}.png`))
      writeFileSync(faultFile, 'error')
      browser.waitForFunction(`document.body.textContent.includes('Could not load tasks')`)
      browser.screenshot(join(artifacts, `error-${width}-${theme}.png`))
      writeFileSync(faultFile, 'none')
      browser.click('[data-route="tasks"] [role="alert"] button')
      browser.waitForFunction(`document.querySelector('[data-slot="tasks-table"]') !== null`)
      expect(browser.url()).toContain(scoped('/'))
      browser.fill('[aria-label="Search tasks"]', 'nothing-matches-this-fixture')
      browser.waitForFunction(`document.body.textContent.includes('No matching tasks')`)
      browser.screenshot(join(artifacts, `empty-${width}-${theme}.png`))
    }
  } finally { proxy.kill() }
}, 90_000)
