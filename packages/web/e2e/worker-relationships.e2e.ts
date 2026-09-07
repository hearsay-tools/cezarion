import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const parentId = randomUUID(), orphanId = randomUUID(), absentId = randomUUID()
const waitingId = randomUUID(), askId = randomUUID(), emptyId = randomUUID()
const loadingId = randomUUID(), errorId = randomUUID()
const ids = Array.from({ length: 32 }, () => randomUUID())
const now = new Date().toISOString()
const region = '[aria-label="Task relationships"]'
let root: string, base: string, project: string, server: ChildProcess, browser: AgentBrowser
const observations: unknown[] = []
let diagnostic = ''
const route = (id: string) => `/p/${project}/tasks/${id}`
const record = (id: string, title: string, extra = {}) => ({ id, title, task: title, workflow: 'quick-task', runner: 'claude', status: 'done', createdAt: now, tokensUsed: 0, steps: [], ...extra })
const receipts = (workers: string[]) => workers.map(workerId => ({ workerId, requestId: randomUUID(), requestHash: 'a'.repeat(64) }))
const rootMetadata = (workers: string[]) => ({ role: 'root', permissions: [], receipts: receipts(workers) })
const wait = () => ({ id: randomUUID(), workerIds: [absentId], deadline: new Date(Date.now() + 3_600_000).toISOString(), phase: 'parked', outcomes: [] })
const worker = (id: string, parentRunId: string, extra = {}) => ({ role: 'worker', parentRunId, permissions: [], workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: join(root, '.ai/cezar/worktrees', id), branch: `cez/${id.slice(0, 8)}`, baselineSha: 'a'.repeat(40) }, ...extra })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-e2e-relationships-'))
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  mkdirSync(join(root, '.ai/cezar/runs'), { recursive: true })
  const runs = [
    record(parentId, 'Relationship parent with 32 workers', { delegation: rootMetadata(ids) }),
    ...ids.map((id, i) => record(id, `Owned worker ${i + 1}`, { archived: i === 31, delegation: worker(id, parentId, i === 0 ? { destroy: { requestedAt: now, phase: 'incomplete', remaining: ['branch'], error: 'Branch is checked out elsewhere' } } : {}) })),
    record(orphanId, 'Worker with unavailable parent', { delegation: worker(orphanId, absentId) }),
    record(waitingId, 'Waiting root fixture', { status: 'waiting', delegation: { ...rootMetadata([absentId]), wait: wait() } }),
    record(askId, 'Question root fixture', { status: 'waiting', delegation: { ...rootMetadata([absentId]), wait: wait() } }),
    record(emptyId, 'Empty root fixture', { delegation: rootMetadata([]) }),
    ...[loadingId, errorId].map(id => record(id, 'Relationship fault fixture', { delegation: rootMetadata([absentId]) })),
  ]
  writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify(runs))
  const events = [
    { seq: 1, ts: now, runId: askId, stepId: 'task', type: 'ask.requested', requestId: 'real-human-question', questions: [{ header: 'Choice', question: 'Which implementation should I use?', options: [{ label: 'Minimal', description: 'Small change' }, { label: 'Expanded', description: 'Wider change' }] }] },
    { seq: 2, ts: now, runId: askId, stepId: 'task', type: 'agent-input', input: { id: randomUUID(), source: 'agent', parentRunId: parentId, text: 'Preserve the human question', createdAt: now } },
  ]
  writeFileSync(join(root, '.ai/cezar/runs', `${askId}.ndjson`), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  // A second real registered project exercises the slim workspace index in Tasks/palette.
  const other = join(root, 'other-project')
  execFileSync('git', ['init', '-q', '-b', 'main', other])
  mkdirSync(join(root, '.cez-home'), { recursive: true })
  writeFileSync(join(root, '.cez-home/config.json'), JSON.stringify({ projects: [{ id: 'other-project', name: 'Other project', root: other, source: 'local', addedAt: now, lastOpenedAt: now }] }))
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('No fixture port')
  const port = address.port; await new Promise<void>(done => probe.close(() => done()))
  base = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root, { CEZ_DELEGATION: '0', CEZ_AUTONAME: '0' }), stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout?.on('data', chunk => { diagnostic += String(chunk) }); server.stderr?.on('data', chunk => { diagnostic += String(chunk) })
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/api/v1/health`)).ok) break } catch { /* starting */ }
    if (attempt === 80) throw Error(`Fixture boot failed: ${diagnostic}`)
    await new Promise(done => setTimeout(done, 250))
  }
  project = await bootProjectId(base)
  browser = AgentBrowser.open(`e2e-workers-${process.pid}`)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit }
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'worker-relationships-server.log'), diagnostic)
  writeFileSync(join(artifacts, 'worker-relationships-observations.json'), JSON.stringify(observations, null, 2))
  if (root) rmSync(root, { recursive: true, force: true })
})

function open(id = parentId, suffix = '') {
  browser.goto(`${base}${route(id)}${suffix}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(region)}) !== null`)
}

it('retains all 32 scoped links on Session, Changes, Commits and Files, including archived workers', () => {
  for (const suffix of ['', '/changes', '/commits', '/files']) {
    open(parentId, suffix)
    browser.waitForFunction(`document.querySelectorAll('${region} a').length === 32`)
    expect(browser.count(`${region} a`)).toBe(32)
    expect(browser.evaluate(`[...document.querySelectorAll('${region} a')].every(a => a.getAttribute('href').startsWith('/p/${project}/tasks/'))`)).toBe(true)
    expect(browser.text(region)).toContain('Cleanup incomplete')
    observations.push({ tab: suffix || 'Session', links: 32, scope: project })
  }
})

for (const [width, height] of [[1440, 900], [360, 640]]) for (const theme of ['light', 'dark']) {
  it(`${width}x${height} ${theme}: keyboard reaches last worker under sticky header with 44px targets`, () => {
    browser.setViewport(width!, height!)
    browser.goto(`${base}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-slot="appearance-theme"]') !== null`)
    browser.click(`[data-slot="appearance-theme"] [data-value="${theme}"]`)
    open()
    browser.waitForFunction(`document.querySelectorAll('${region} a').length === 32`)
    browser.setReducedMotion()
    browser.evaluate(`document.querySelector('${region} a').focus()`)
    for (let i = 1; i < 32; i++) browser.press('Tab')
    const facts = browser.evaluate(`(() => {
      const section = document.querySelector('${region}'); const list = section.querySelector('ul'); const links = [...section.querySelectorAll('a')];
      const last = links.at(-1), r = last.getBoundingClientRect(), container = list.getBoundingClientRect();
      return { focused: document.activeElement === last, visible: r.top >= Math.max(0, container.top) && r.bottom <= Math.min(innerHeight, container.bottom),
        scroll: list.scrollTop, minimumTarget: Math.min(...links.map(a => a.getBoundingClientRect().height)),
        overflow: document.documentElement.scrollWidth > innerWidth, theme: document.documentElement.classList.contains('light') === ${theme === 'light'},
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, focusRing: getComputedStyle(last).boxShadow,
        lastName: last.getAttribute('aria-label'), rect: { top: r.top, bottom: r.bottom, width: r.width } };
    })()`) as { focused: boolean; visible: boolean; scroll: number; minimumTarget: number; overflow: boolean; theme: boolean; reducedMotion: boolean; focusRing: string }
    observations.push({ width, height, selectedTheme: theme, ...facts })
    expect(facts.focused).toBe(true); expect(facts.visible).toBe(true); expect(facts.scroll).toBeGreaterThan(0)
    expect(facts.minimumTarget).toBeGreaterThanOrEqual(44); expect(facts.overflow).toBe(false)
    expect(facts.theme).toBe(true); expect(facts.reducedMotion).toBe(true); expect(facts.focusRing).not.toBe('none')
    browser.screenshot(join(artifacts, `workers-${width}-${theme}.png`), { viewport: true })
    browser.press('Enter')
    browser.waitForFunction(`location.pathname === '${route(ids[31]!)}' && document.querySelector('${region} a[aria-label="Parent task ${parentId}"]') !== null`)
    expect(browser.text(region)).toContain(parentId)
  }, 120_000)
}

it('shows unavailable parent with retry, successful empty state, worker wait and preserved human ask attribution', () => {
  browser.setViewport(1440, 900)
  open(orphanId)
  browser.waitForFunction(`document.querySelector('${region}').textContent.includes('Parent record unavailable')`)
  expect(browser.text(region)).toContain(absentId)
  expect(browser.snapshot()).toContain('Retry parent task')
  browser.click(`${region} button`)
  expect(browser.text(region)).toContain(absentId)
  open(emptyId); browser.waitForFunction(`document.querySelector('${region}').textContent.includes('No workers')`)
  open(waitingId); expect(browser.text(region)).toContain('Waiting on workers')
  expect(browser.count('[data-slot="ask-card"]')).toBe(0)
  open(askId)
  browser.waitForFunction(`document.body.textContent.includes('Which implementation should I use?')`)
  expect(browser.snapshot()).toContain('Minimal')
  expect(browser.text('[data-slot="paused-hint"]')).toContain('waiting for your reply')
  expect(browser.text('header [data-slot="pill"]')).toContain('needs you')
  expect(browser.text('body')).toContain('Agent input')
  expect(browser.count('[data-slot="user-bubble"]')).toBe(1) // the original human task, never an agent-input bubble
  expect(browser.text('[data-slot="user-bubble"]')).not.toContain('Preserve the human question')
  browser.screenshot(join(artifacts, 'workers-preserved-ask.png'), { viewport: true })
})

it('retains known IDs during loading, request error and offline pause, then retries real relationships', () => {
  open(emptyId)
  // Fault only the browser's relationship fetch boundary; the app, cache, routing,
  // DOM and all successful responses still use the actual fixture server.
  browser.evaluate(`(() => { const original = window.fetch.bind(window); window.__relationshipMode = 'loading';
    window.__relationshipFetch = original; window.fetch = (input, options) => {
      if (String(input).includes('/relationships')) {
        if (window.__relationshipMode === 'loading') return new Promise(() => {});
        if (window.__relationshipMode === 'error') return Promise.resolve(new Response('{"error":"fixture unavailable"}', { status: 503 }));
      }
      return original(input, options);
    }; return true; })()`)
  const navigate = (id: string) => browser.evaluate(`history.pushState({}, '', '${route(id)}'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  navigate(loadingId)
  browser.waitForFunction(`document.querySelector('${region}')?.textContent.includes('Loading relationships')`)
  expect(browser.text(region)).toContain(absentId)
  expect(browser.text(region)).not.toContain('No workers')
  browser.evaluate(`window.__relationshipMode = 'error'`)
  navigate(errorId)
  browser.waitForFunction(`document.querySelector('${region}')?.textContent.includes('Could not load relationships')`)
  expect(browser.text(region)).toContain(absentId)
  expect(browser.snapshot()).toContain('Retry relationships')
  browser.evaluate(`window.__relationshipMode = 'success'`)
  // Pause a retry on an already loaded run: a completely uncached run cannot
  // mount its relationships while its own detail request is offline.
  browser.setOffline(true)
  browser.click(`${region} button`)
  browser.waitForFunction(`document.querySelector('${region}')?.textContent.includes('Offline')`)
  expect(browser.text(region)).toContain(absentId)
  browser.screenshot(join(artifacts, 'workers-offline.png'), { viewport: true })
  browser.evaluate(`window.fetch = window.__relationshipFetch; true`)
  browser.setOffline(false)
  browser.waitForFunction(`document.querySelector('${region}')?.textContent.includes('Record unavailable')`)
  observations.push({ loading: 'known ID retained', error: 'known ID retained; real retry succeeds', offline: 'paused; reconnect fetch succeeds' })
})

it('global Tasks and cross-project palette retain worker labels and parked-root status', () => {
  browser.goto(`${base}/tasks`)
  browser.waitForFunction(`document.querySelector('[data-slot="global-task-row"][data-run-id="${waitingId}"]') !== null`)
  expect(browser.text(`[data-slot="global-task-row"][data-run-id="${waitingId}"]`)).toContain('waiting on workers')
  expect(browser.text('body')).toContain('Worker')
  browser.press('Control+k')
  browser.waitForFunction(`document.querySelector('[cmdk-input]') !== null`)
  browser.fill('[cmdk-input]', 'Waiting root fixture')
  browser.waitForFunction(`document.querySelector('[cmdk-list]')?.textContent.includes('Waiting root fixture')`)
  expect(browser.count('[cmdk-list] [aria-label="waiting on workers"]')).toBe(1)
  browser.fill('[cmdk-input]', 'Owned worker 1')
  browser.waitForFunction(`document.querySelector('[cmdk-list]')?.textContent.includes('Owned worker 1')`)
  expect(browser.text('[cmdk-list]')).toContain('Worker')
  browser.press('Escape')
  observations.push({ globalTasks: 'worker label and waiting on workers', palette: 'cross-project index matches local status' })
})
