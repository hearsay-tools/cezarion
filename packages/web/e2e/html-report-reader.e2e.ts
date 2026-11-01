import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
// fixture-server starts: 1

// hearsay-tools/cezarion#2400: a published HTML report opens in the sandboxed reader. A probe
// server in its own process records every request, so the spec can prove that none leaves the
// frame, layer by layer: the whole pipeline, the sandbox alone, and the CSP alone.
const runId = randomUUID()
const evidenceDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_issue-2400')
let root: string
let baseUrl: string
let server: ChildProcess
let probe: ChildProcess
let probeOrigin: string
let hitsFile: string
let browser: AgentBrowser
let publication: { id: string; link: string; markdown: string }

const FRAME = '[data-slot="html-report-frame"]'
const LINK = '[data-slot="user-bubble"] a[data-streamdown="link"]'

function reportHtml(origin: string): string {
  return `<!doctype html><html><head><title>Probe report</title>
<meta http-equiv="refresh" content="0;url=${origin}/refresh">
<link rel="stylesheet" href="${origin}/css">
<style>@import url("${origin}/import"); body{margin:0;font:16px sans-serif}
#toc,#ext{position:absolute;left:0;display:block;width:240px;height:48px} #toc{top:0} #ext{top:64px} .tall{height:4000px;padding-top:140px}</style>
<script>parent.document.title='owned';fetch('${origin}/fetch');new Image().src='${origin}/script-img';localStorage.setItem('cez-report-probe','1');top.location='${origin}/top'</script>
</head><body>
<a id="toc" href="#s2">Section two</a><a id="ext" href="${origin}/ext">External</a>
<img src="${origin}/img" alt=""><img src="/api/v1/health?probe=relative" alt="">
<form action="${origin}/form" method="post"><input name="q"></form>
<div class="tall">Quarterly results</div><h2 id="s2">Section two body</h2></body></html>`
}

function hits(): { path: string; referer: string | null }[] {
  if (!existsSync(hitsFile)) return []
  return readFileSync(hitsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { path: string; referer: string | null })
}

/** Absence needs a real-time window: nothing observable happens when every probe is blocked. */
function expectCockpitUntouched(path: string): void {
  // bound: 1500 ms outlasts a 0 s meta refresh, the script's requests and image loads of a
  // two-kilobyte document on a loopback probe; a slower host can only pass falsely, never fail.
  browser.waitForStable<string>(`[document.title, location.pathname, localStorage.getItem('cez-report-probe')].join('|')`, {
    holdMs: 1500,
    matcher: value => !value.includes('owned') && value.split('|')[1] === path && value.endsWith('|'),
  })
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-html-reader-')))
  hitsFile = join(root, 'hits.ndjson')
  probe = spawn(process.execPath, ['-e', `
    const http = require('node:http'); const fs = require('node:fs')
    const s = http.createServer((req, res) => { fs.appendFileSync(process.argv[1], JSON.stringify({ path: req.url, referer: req.headers.referer ?? null }) + '\\n'); res.setHeader('content-type', 'text/html'); res.end('<p>probe</p>') })
    s.listen(0, '127.0.0.1', () => console.log(s.address().port))`, hitsFile], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<string>((done, fail) => {
    probe.stdout!.once('data', chunk => done(String(chunk).trim()))
    probe.once('exit', code => fail(new Error(`probe server exited with ${code}`)))
  })
  probeOrigin = `http://127.0.0.1:${port}`

  const project = join(root, 'project')
  execFileSync('git', ['init', '-q', '-b', 'main', project])
  mkdirSync(join(project, '.ai/cezar/runs'), { recursive: true })
  const env = fixtureServeEnv(project)
  mkdirSync(env.CEZ_HOME!, { recursive: true })
  writeFileSync(join(env.CEZ_HOME!, 'config.json'), JSON.stringify({ projects: [{ id: 'reader', root: project }] }))
  const source = join(root, 'probe-report.html')
  writeFileSync(source, reportHtml(probeOrigin))
  publication = JSON.parse(execFileSync(process.execPath, [cezarCli, 'artifact', 'publish', source], {
    cwd: project, env: { ...env, CEZ_TASK_ID: runId, CEZ_ARTIFACTS_DIR: join(project, '.ai/cezar/runs', `${runId}-artifacts`) }, encoding: 'utf8',
  }))
  rmSync(source)
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the long task description.`).join('\n\n')
  const run: RunRecord = {
    id: runId, task: `${filler}\n\nRead ${publication.markdown} now.\n\n${filler}`, title: 'HTML report reader', workflow: 'quick-task',
    status: 'done', archived: false, createdAt: '2026-11-01T08:00:00Z', tokensUsed: 0, steps: [],
  }
  writeFileSync(join(project, '.ai/cezar/runs.json'), JSON.stringify([run]))
  mkdirSync(evidenceDir, { recursive: true })
  server = spawnFixtureServer([cezarCli, 'serve', '--repo', project, '--port', '0', '--no-open'], { env })
  baseUrl = await waitForFixtureServer(server)
  expect(await bootProjectId(baseUrl)).toBe('reader')
  browser = AgentBrowser.open(`html-reader-${process.pid}`)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (probe && probe.exitCode === null) await new Promise(done => { probe.once('exit', done); probe.kill() })
  if (root) rmSync(root, { recursive: true, force: true })
})

const threadPath = () => `/p/reader/tasks/${runId}`
const readerPath = () => `${threadPath()}/report`

it('opens the published link in the reader inside cezarion, with no request leaving the frame', () => {
  browser.goto(baseUrl + threadPath())
  const href = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(LINK)})?.getAttribute('href')`)
  expect(href).toBe(`${readerPath()}?artifact=${publication.id}`)
  browser.evaluate(`document.querySelector(${JSON.stringify(LINK)}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  const before = browser.waitForStable<number>(`Math.round(document.querySelector(${JSON.stringify(LINK)}).getBoundingClientRect().top)`, { holdMs: 300, matcher: value => typeof value === 'number' })
  browser.click(LINK)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null && location.pathname === ${JSON.stringify(readerPath())}`)
  expect(browser.waitForValue<boolean>(`document.querySelector('[data-slot="link-safety-dialog"]') === null`)).toBe(true)
  expect(browser.evaluate(`document.querySelector(${JSON.stringify(FRAME)}).getAttribute('sandbox')`)).toBe('allow-popups allow-popups-to-escape-sandbox')
  expect(browser.text('[data-slot="html-report-blocked"]')).toContain('Blocked for your safety')
  expectCockpitUntouched(readerPath())
  expect(hits()).toEqual([])
  browser.screenshot(join(evidenceDir, 'reader-desktop.png'), { viewport: true })

  // An in-page anchor scrolls the report and adds a history entry; reader Back still leaves in one step.
  const box = browser.evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(FRAME)}).getBoundingClientRect())`) as string
  const frame = JSON.parse(box) as { left: number; top: number }
  const length = browser.evaluate('history.length') as number
  browser.tapAt(frame.left + 60, frame.top + 20)
  browser.waitForFunction(`history.length === ${length + 1}`)
  browser.click('[data-slot="report-bar"] button[aria-label="Back"]')
  browser.waitForFunction(`location.pathname === ${JSON.stringify(threadPath())} && document.querySelector(${JSON.stringify(LINK)}) !== null`)
  const after = browser.waitForStable<number>(`Math.round(document.querySelector(${JSON.stringify(LINK)}).getBoundingClientRect().top)`, { holdMs: 300, matcher: value => typeof value === 'number' })
  expect(Math.abs(after - before)).toBeLessThanOrEqual(4)
})

it('blocks scripts, navigation and storage by the sandbox alone, on unprepared HTML', () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  // The spec's own frame, built with the reader's sandbox and the raw report (no cleanup, no CSP).
  browser.evaluate(`(() => { const raw = document.createElement('iframe'); raw.id = 'raw-probe'
    raw.setAttribute('sandbox', document.querySelector(${JSON.stringify(FRAME)}).getAttribute('sandbox'))
    raw.srcdoc = ${JSON.stringify(reportHtml(probeOrigin))}; document.body.append(raw) })()`)
  expectCockpitUntouched(readerPath())
  const paths = hits().map(hit => hit.path)
  for (const scripted of ['/fetch', '/script-img', '/top', '/refresh']) expect(paths).not.toContain(scripted)
  // Without the CSP the frame may load passive resources; that is the CSP's job, tested next.
  rmSync(hitsFile, { force: true })
})

it('blocks every request by the CSP alone, on unprepared HTML', () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  browser.evaluate(`(() => { const meta = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(document.querySelector(${JSON.stringify(FRAME)}).getAttribute('srcdoc'))[0]
    const raw = document.createElement('iframe'); raw.id = 'csp-probe'
    raw.setAttribute('sandbox', document.querySelector(${JSON.stringify(FRAME)}).getAttribute('sandbox'))
    raw.srcdoc = ${JSON.stringify(reportHtml(probeOrigin))}.replace('<head>', '<head>' + meta); document.body.append(raw) })()`)
  expectCockpitUntouched(readerPath())
  expect(hits()).toEqual([])
})

// The external link's new tab is not driven here: agent-browser attaches to every new tab and
// cannot attach to a noreferrer popup (see artifact-project-links.e2e.ts). html-report.test.ts
// pins the rewrite; the PR records a raw-CDP check of the opened tab.
it('renders external links for a new tab without opener or referrer', () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  const srcdoc = browser.waitForValue<string>(`document.querySelector(${JSON.stringify(FRAME)})?.getAttribute('srcdoc')`)
  expect(srcdoc).toContain(`<a id="ext" href="${probeOrigin}/ext" target="_blank" rel="noopener noreferrer">`)
})

it('fits one full-screen surface with 44-pixel controls at 360×640 in light and dark', () => {
  browser.setViewport(360, 640)
  for (const theme of ['dark', 'light']) {
    browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
    browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
    browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
    const layout = browser.waitForStable<string>(`JSON.stringify({
      surface: document.querySelector('[data-route="task-report"]').getBoundingClientRect(),
      controls: [...document.querySelectorAll('[data-slot="report-bar"] button, [data-slot="report-bar"] a')].map(el => { const r = el.getBoundingClientRect(); return [el.textContent.trim() || el.getAttribute('aria-label'), r.width, r.height] }),
    })`, { holdMs: 300, matcher: value => typeof value === 'string' })
    const { surface, controls } = JSON.parse(layout) as { surface: DOMRect; controls: [string, number, number][] }
    expect([surface.x, surface.y, surface.width, surface.height]).toEqual([0, 0, 360, 640])
    expect(controls.map(([name]) => name)).toEqual(['Back', 'Source', 'Download'])
    for (const [name, width, height] of controls) expect(Math.min(width, height), name).toBeGreaterThanOrEqual(44)
    browser.screenshot(join(evidenceDir, `reader-360-${theme}.png`), { viewport: true })
  }
  browser.setViewport(1440, 900)
})
