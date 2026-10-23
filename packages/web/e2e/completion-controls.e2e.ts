import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { AgentBrowser } from './agent-browser'
import { focusWithKeyboard } from './contrast'
import { stopFixtureServer } from './fixture-server'
import { pollFor } from './poll'
import { waitForSettledSample } from './visual-ready'

// Real production forms and CSS with a local API double. The parent integration tests cover
// coordinator/CI behavior; these tests pin the browser's exact requests and available actions.
const webRoot = resolve(import.meta.dirname, '..')
const viteCli = resolve(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js')
const fixtureDir = resolve(webRoot, '.e2e-fixtures', `completion-${process.pid}`)
const artifacts = resolve(webRoot, '../../.ai/qa/artifacts_e2e/completion-controls')
let browser: AgentBrowser
let server: ChildProcess
let url: string

beforeAll(async () => {
  mkdirSync(fixtureDir, { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(resolve(fixtureDir, 'index.html'), '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>')
  writeFileSync(resolve(fixtureDir, 'fixture.tsx'), `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClientProvider } from '@tanstack/react-query';
    import { MemoryRouter, Routes, Route } from 'react-router';
    import { createQueryClient } from '../../src/api/query-client';
    import { NewTaskRoute } from '../../src/routes/new-task';
    import { AutomationEditor } from '../../src/routes/automations/editor';
    import { RunHeader } from '../../src/routes/task-thread/run-header';
    import { Toaster } from '../../src/components/ui/toaster';
    import '../../src/styles/index.css';
    const view = new URLSearchParams(location.search).get('view') || 'new';
    let record = { id: 'task', title: 'Ship the change', task: 'Ship the change', workflow: 'quick-task',
      status: 'done', archived: false, tokensUsed: 0, steps: [], createdAt: '2026-10-01T00:00:00Z',
      archiveWhenDone: true, autoMergePr: true, pullRequestUrl: 'https://github.com/owner/repo/pull/42',
      completionAction: { id: '00000000-0000-4000-8000-000000000001', phase: 'blocked', message: 'Required checks have not passed for the current head.' } };
    window.requests = [];
    window.fetch = async (input, init = {}) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      window.requests.push({ path, method, body });
      const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (method === 'PATCH') { record = { ...record, ...body }; window.setRun?.(record); return json(record); }
      if (method !== 'GET') return json(path.endsWith('/runs') ? { id: 'created' } : { automation: { id: 'saved', revision: 2 } });
      if (path.endsWith('/run-summaries') || path.endsWith('/skills')) return json([]);
      if (path.endsWith('/health')) return json({ version: 'test', projects: [], bootProject: 'default', repoRoot: '/repo',
        repo: { root: '/repo', branch: 'main' }, defaultRunner: 'claude', checks: [{ name: 'claude', available: true }, { name: 'git', available: true }],
        capabilities: { followups: false, preview: false, localHandoff: false, automations: true } });
      if (path.endsWith('/providers/status')) return json({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] });
      if (path.endsWith('/workflows')) return json({ workflows: [{ name: 'quick-task', source: 'built-in', steps: [] }], issues: [] });
      if (path.endsWith('/repo')) return json({ info: { root: '/repo', branch: 'main' }, status: [], log: [], branches: ['main'], baseBranch: null });
      if (path.endsWith('/workspace/config')) return json({ agentDefaults: {}, composerDefaults: { inheritedAutonomous: 'source-dependent', inheritedWorktree: true } });
      if (path.endsWith('/config')) return json({ defaultRunner: 'claude', baseBranch: null, maxParallel: 2 });
      if (path.endsWith('/ui-state')) return json({});
      if (path.endsWith('/models')) return json({ runner: 'claude', models: [], source: 'unavailable', stale: false });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    };
    const automation = { id: 'automation', revision: 1, name: 'Ship daily', kind: 'schedule', enabled: false,
      schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Ship', archiveWhenDone: true, autoMergePr: true }, createdAt: '', updatedAt: '' };
    const client = createQueryClient();
    function Fixture() {
      const [run, setRun] = useState(record);
      window.setRun = setRun;
      const route = view === 'task' ? '/tasks/task' : view.startsWith('automation') ? '/automations/new' : '/new';
      return <QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><main className="min-w-0">
        <Routes><Route path="/new" element={<NewTaskRoute />} />
          <Route path="/automations/new" element={<AutomationEditor automation={view === 'automation-edit' ? automation : undefined} forge={{available: false}} timeZone="UTC" onSaved={() => window.saved = true} />} />
          <Route path="/tasks/task" element={<RunHeader run={run} />} />
          <Route path="/tasks/created" element={<p>Created task</p>} /></Routes>
      </main><Toaster /></MemoryRouter></QueryClientProvider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `)
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  url = `http://127.0.0.1:${port}/.e2e-fixtures/completion-${process.pid}/index.html`
  server = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webRoot, stdio: 'ignore' })
  await pollFor(async signal => (await fetch(url, { signal })).ok || undefined, () => 'completion browser fixture did not start', { tries: 60 })
  browser = AgentBrowser.open(`completion-${process.pid}`)
})

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  rmSync(fixtureDir, { recursive: true, force: true })
})

const switches = '[data-slot="completion-controls"] [role="switch"]'
const checked = () => browser.evaluate(`[...document.querySelectorAll('${switches}')].map(el => el.getAttribute('aria-checked'))`)
function open(view: string, theme = 'dark') {
  browser.goto(`${url}?view=${view}`)
  browser.evaluate(`document.documentElement.classList.toggle('light', ${theme === 'light'})`)
}
function keyboardSwitches() {
  focusWithKeyboard(browser, `${switches}:first-of-type`)
  expect(waitForSettledSample(browser, `getComputedStyle(document.activeElement).outlineStyle !== 'none'`)).toBe(true)
  browser.press('Space')
  browser.press('Tab')
  browser.press('Space')
}
function assertLayout() {
  const sizes = waitForSettledSample(browser, `(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    targets: [...document.querySelectorAll('.completion-control, [data-slot="completion-status"] :is(a, button), [data-slot="run-actions-menu"] [role="menuitemcheckbox"]')].map(el => ({width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height})) }))()`
  ) as { overflow: boolean; targets: Array<{ width: number; height: number }> }
  expect(sizes.overflow).toBe(false)
  expect(sizes.targets.length).toBeGreaterThan(0)
  for (const target of sizes.targets) {
    expect(target.width).toBeGreaterThanOrEqual(44)
    expect(target.height).toBeGreaterThanOrEqual(44)
  }
}

it.each([{ width: 360, theme: 'dark' }, { width: 360, theme: 'light' }, { width: 1440, theme: 'light' }])('persists a new-task draft and submits keyboard choices at $width px in $theme', ({ width, theme }) => {
  browser.setViewport(width, width === 360 ? 640 : 900)
  open('new', theme)
  browser.evaluate(`localStorage.removeItem('cez-new-task-draft')`)
  open('new', theme)
  browser.waitForFunction(`document.querySelectorAll('${switches}').length === 2`)
  expect(checked()).toEqual(['false', 'false'])
  keyboardSwitches()
  expect(checked()).toEqual(['true', 'true'])
  assertLayout()
  browser.screenshot(resolve(artifacts, `new-${theme}-${width}.png`), { viewport: true })
  open('new', theme)
  browser.waitForFunction(`document.querySelectorAll('${switches}').length === 2`)
  expect(checked()).toEqual(['true', 'true'])
  browser.fill('textarea[aria-label="Describe a task for the agent"]', 'Ship it')
  browser.click('button[aria-label="Start task"]')
  const body = browser.waitForValue(`window.requests.find(request => request.method === 'POST' && request.path.endsWith('/runs'))?.body`) as Record<string, unknown>
  expect(body).toMatchObject({ archiveWhenDone: true, autoMergePr: true })
}, 120_000)

it('creates with both switches off by default, then sends saved automation switches explicitly off', () => {
  browser.setViewport(360, 640)
  open('automation-new', 'light')
  browser.waitForFunction(`document.querySelectorAll('${switches}').length === 2`)
  expect(checked()).toEqual(['false', 'false'])
  keyboardSwitches()
  browser.fill('#automation-name', 'Ship daily')
  browser.fill('#automation-prompt', 'Ship')
  assertLayout()
  browser.click('button[type="submit"]')
  const created = browser.waitForValue(`window.requests.find(request => request.method === 'POST' && request.path.endsWith('/automations'))?.body`) as { task: Record<string, unknown> }
  expect(created.task).toMatchObject({ archiveWhenDone: true, autoMergePr: true })
  open('automation-edit')
  browser.waitForFunction(`document.querySelectorAll('${switches}').length === 2`)
  expect(checked()).toEqual(['true', 'true'])
  expect(browser.text('form')).toContain('Existing tasks keep their settings.')
  keyboardSwitches()
  expect(checked()).toEqual(['false', 'false'])
  browser.click('button[type="submit"]')
  const updated = browser.waitForValue(`window.requests.find(request => request.method === 'PUT')?.body`) as { task: Record<string, unknown> }
  expect(updated.task).toMatchObject({ archiveWhenDone: false, autoMergePr: false })
}, 120_000)

it.each([{ width: 360, theme: 'light' }, { width: 360, theme: 'dark' }, { width: 1440, theme: 'dark' }])('exposes blocked completion and edits existing-task settings at $width px in $theme', ({ width, theme }) => {
  browser.setViewport(width, width === 360 ? 640 : 900)
  open('task', theme)
  browser.waitForFunction(`document.querySelector('[data-slot="completion-status"] [role="status"]') !== null`)
  expect(browser.text('[data-slot="completion-status"]')).toContain('Required checks have not passed for the current head.')
  expect(browser.evaluate(`document.querySelector('[data-slot="completion-status"] [role="status"]').getAttribute('aria-live')`)).toBe('polite')
  const disable = '[data-slot="completion-status"] button'
  focusWithKeyboard(browser, disable)
  browser.press('Enter')
  browser.waitForFunction(`window.requests.some(request => request.method === 'PATCH' && request.body.autoMergePr === false)`)
  browser.click('button[aria-label="Run actions"]')
  assertLayout()
  const archive = '[data-slot="run-actions-menu"] [data-slot="archive-when-done"]'
  browser.click(archive)
  browser.waitForFunction(`window.requests.some(request => request.method === 'PATCH' && request.body.archiveWhenDone === false)`)
  assertLayout()
  browser.screenshot(resolve(artifacts, `task-${theme}-${width}.png`), { viewport: true })
}, 120_000)

it.each(['light', 'dark'])('updates completion status and keeps archive blockers keyboard accessible on a phone in %s', theme => {
  browser.setViewport(360, 640)
  open('task', theme)
  browser.waitForFunction(`document.querySelector('[data-slot="completion-status"]') !== null`)
  browser.evaluate(`window.setRun({ id: 'task', title: 'Ship', task: 'Ship', workflow: 'quick-task', status: 'done', archived: false,
    tokensUsed: 0, steps: [], createdAt: '', archiveWhenDone: true,
    completionAction: { id: '00000000-0000-4000-8000-000000000001', phase: 'pending', message: 'Waiting for archive checks.' },
    archiveBlocker: { message: 'A worker has an open PR.', runId: 'worker', pullRequestUrl: 'https://github.com/owner/repo/pull/43' } })`)
  browser.waitForFunction(`document.querySelector('[data-slot="completion-status"]').textContent.includes('Archive blocked')`)
  expect(browser.text('[data-slot="completion-status"]')).toContain('Completion pending')
  expect(browser.evaluate(`[...document.querySelectorAll('[data-slot="completion-status"] a')].map(el => el.getAttribute('href'))`)).toEqual(['/tasks/worker', 'https://github.com/owner/repo/pull/43'])
  expect(browser.count('[data-slot="archive-action"]')).toBe(1)
  assertLayout()
  focusWithKeyboard(browser, '[data-slot="archive-action"]')
  expect(waitForSettledSample(browser, `document.activeElement === document.querySelector('[data-slot="archive-action"]')`)).toBe(true)
  browser.screenshot(resolve(artifacts, `blocker-${theme}-360.png`), { viewport: true })
  browser.press('Enter')
  browser.waitForFunction(`document.querySelector('[role="alertdialog"]') !== null`)
  expect(browser.text('[role="alertdialog"]')).toContain('You can restore it from Archived.')
}, 120_000)
