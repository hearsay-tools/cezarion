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
const requestParentId = randomUUID(), requestWorkerId = randomUUID()
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
    record(requestParentId, 'Parent awaiting worker reply', { status: 'waiting', delegation: { ...rootMetadata([requestWorkerId]), wait: { ...wait(), workerIds: [], requestIds: [randomUUID()] } } }),
    record(requestWorkerId, 'Worker awaiting parent reply', { status: 'waiting', delegation: worker(requestWorkerId, requestParentId, { wait: { ...wait(), workerIds: [], requestIds: [randomUUID()] } }) }),
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

// Since #402 the panel has two homes: the Session tab reaches it through the unified run
// activity dock above the composer, while Changes / Commits / Files keep the header panel.
// The dock is also collapsed by default on a phone, so reaching the region is a click there
// and already open on a desktop — wait for whichever surface this tab rendered, then expand.
function reveal() {
  browser.waitForFunction(
    `document.querySelector('[data-slot="run-activity-dock"] > button') !== null || document.querySelector(${JSON.stringify(region)}) !== null`,
  )
  // Retried, not fired once: the card mounts as soon as the run record lands, and a tap
  // dispatched in that frame — right after an in-app navigation — can reach a button whose
  // handler React has not attached yet, which fails the whole spec for a timing reason.
  // The Workers row is normally already open; the second click covers a remembered collapse.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (browser.evaluate(`document.querySelector(${JSON.stringify(region)}) !== null`) === true) break
    browser.evaluate(`(() => {
      document.querySelector('[data-slot="run-activity-dock"] > button[aria-expanded="false"]')?.click()
      document.querySelector('[data-slot="run-activity-workers"] > button[aria-expanded="false"]')?.click()
      return true
    })()`)
  }
  browser.waitForFunction(`document.querySelector(${JSON.stringify(region)}) !== null`)
  browser.evaluate(`(() => {
    const disclosure = document.querySelector(${JSON.stringify(`${region} > button[aria-expanded="false"]`)})
    disclosure?.click()
  })()`)
}

function open(id = parentId, suffix = '') {
  browser.goto(`${base}${route(id)}${suffix}`)
  reveal()
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
    // In-app navigation, so the worker task arrives with its own dock state: collapsed at
    // phone width until `reveal` opens it.
    browser.waitForFunction(`location.pathname === '${route(ids[31]!)}'`)
    reveal()
    browser.waitForFunction(`document.querySelector('${region} a[aria-label="Parent task ${parentId}"]') !== null`)
    expect(browser.evaluate(`document.querySelector('${region} a[aria-label="Parent task ${parentId}"]').getAttribute('href')`)).toBe(route(parentId))
  }, 120_000)
}

it('shows unavailable parent with retry, successful empty state, worker wait and preserved human ask attribution', () => {
  browser.setViewport(1440, 900)
  open(orphanId)
  browser.waitForFunction(`document.querySelector('${region}').textContent.includes('Parent record unavailable')`)
  expect(browser.evaluate(`[...document.querySelectorAll('${region} a')].some(a => a.getAttribute('aria-label')?.includes('${absentId}'))`)).toBe(true)
  expect(browser.snapshot()).toContain('Retry parent task')
  browser.evaluate(`(() => { const buttons = [...document.querySelectorAll('${region} button')]; buttons.find(button => button.textContent.includes('Retry')).click(); })()`)
  expect(browser.evaluate(`[...document.querySelectorAll('${region} a')].some(a => a.getAttribute('aria-label')?.includes('${absentId}'))`)).toBe(true)
  open(emptyId); browser.waitForFunction(`document.querySelector('${region}').textContent.includes('No workers')`)
  open(waitingId); expect(browser.text(region)).toContain('Waiting on workers')
  expect(browser.count('[data-slot="ask-card"]')).toBe(0)
  // The real server derives attention from the seeded ask.requested event.
  // Visit both lists before the ask detail so its history cannot prime attention.
  browser.goto(`${base}/p/${project}/`)
  const projectAsk = `[data-slot="task-row"][data-run-id="${askId}"]`
  browser.waitForFunction(`document.querySelector('${projectAsk} [aria-label="needs you"]') !== null`)
  expect(browser.count(`${projectAsk} [aria-label="needs you"]`)).toBe(1)
  expect(browser.count(`${projectAsk} [aria-label="waiting on workers"]`)).toBe(0)
  browser.goto(`${base}/tasks`)
  const globalAsk = `[data-slot="global-task-row"][data-run-id="${askId}"]`
  browser.waitForFunction(`document.querySelector('${globalAsk}')?.textContent.includes('needs you')`)
  expect(browser.text(globalAsk)).not.toContain('waiting on workers')
  observations.push({ pendingHumanAsk: 'project and global lists need you before detail history loads' })
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
  expect(browser.evaluate(`[...document.querySelectorAll('${region} a')].some(a => a.getAttribute('aria-label')?.includes('${absentId}'))`)).toBe(true)
  expect(browser.text(region)).not.toContain('No workers')
  browser.evaluate(`window.__relationshipMode = 'error'`)
  navigate(errorId)
  browser.waitForFunction(`document.querySelector('${region}')?.textContent.includes('Could not load relationships')`)
  expect(browser.evaluate(`[...document.querySelectorAll('${region} a')].some(a => a.getAttribute('aria-label')?.includes('${absentId}'))`)).toBe(true)
  expect(browser.snapshot()).toContain('Retry relationships')
  browser.evaluate(`window.__relationshipMode = 'success'`)
  // Pause a retry on an already loaded run: a completely uncached run cannot
  // mount its relationships while its own detail request is offline.
  browser.setOffline(true)
  browser.evaluate(`(() => { const buttons = [...document.querySelectorAll('${region} button')]; buttons.find(button => button.textContent.includes('Retry')).click(); })()`)
  browser.waitForFunction(`document.querySelector('${region}')?.textContent.includes('Offline')`)
  expect(browser.evaluate(`[...document.querySelectorAll('${region} a')].some(a => a.getAttribute('aria-label')?.includes('${absentId}'))`)).toBe(true)
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


it('keeps request waits consistent in threads, global tasks and the palette at phone and desktop widths', () => {
  for (const [width, height] of [[1440, 900], [360, 640]] as const) for (const theme of ['light', 'dark']) {
    browser.setViewport(width, height)
    browser.goto(`${base}/settings/appearance`)
    browser.waitForFunction(`document.querySelector('[data-slot="appearance-theme"]') !== null`)
    browser.click(`[data-slot="appearance-theme"] [data-value="${theme}"]`)
    for (const [id, label] of [[requestParentId, 'Waiting on worker replies'], [requestWorkerId, 'Waiting on parent reply']] as const) {
      open(id)
      browser.waitForFunction(`document.querySelector('[data-slot="paused-hint"]') !== null`)
      expect(browser.text('[data-slot="paused-hint"]')).toContain(label)
      expect(browser.text(region)).toContain(label)
      expect(browser.count('[data-slot="ask-card"]')).toBe(0)
      expect(browser.evaluate('document.documentElement.scrollWidth > innerWidth')).toBe(false)
      browser.screenshot(join(artifacts, `request-wait-${id === requestWorkerId ? 'worker' : 'parent'}-${width}-${theme}.png`), { viewport: true })
      observations.push({ requestWait: id === requestWorkerId ? 'worker' : 'parent', width, height, theme, label, overflow: false })
    }
  }
  browser.goto(`${base}/tasks`)
  for (const [id, label] of [[requestParentId, 'waiting on worker replies'], [requestWorkerId, 'waiting on parent reply']] as const) {
    const row = `[data-slot="global-task-row"][data-run-id="${id}"]`
    browser.waitForFunction(`document.querySelector('${row}') !== null`)
    expect(browser.text(row)).toContain(label)
    expect(browser.text(row)).not.toContain('needs you')
  }
  browser.press('Control+k')
  browser.waitForFunction(`document.querySelector('[cmdk-input]') !== null`)
  browser.fill('[cmdk-input]', 'Worker awaiting parent reply')
  browser.waitForFunction(`document.querySelector('[cmdk-list] [aria-label="waiting on parent reply"]') !== null`)
  expect(browser.count('[cmdk-list] [aria-label="needs you"]')).toBe(0)
  browser.press('Escape')
}, 120_000)
