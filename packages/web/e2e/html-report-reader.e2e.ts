import { Home } from '../../cezar/src/home/home.ts';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { seedRuns } from './seed-runs'
import { AgentBrowser, bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
import { pollFor } from './poll'
// fixture-server starts: 1

// hearsay-tools/cezarion#2400, hearsay-tools/cezarion#2716: a published HTML report opens in the
// sandboxed reader and its inline scripts run. A probe server in its own process records every
// request, so the spec can prove that none leaves the frame, layer by layer: the whole pipeline,
// the sandbox alone, the CSP alone and the wrapper frame alone.
const runId = randomUUID()
const evidenceDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_issue-2400')
let root: string
let baseUrl: string
let server: ChildProcess
let probe: ChildProcess
let probeOrigin: string
let hitsFile: string
let udpFile: string
let stunPort: string
let browser: AgentBrowser
let publication: { id: string; link: string; markdown: string }
let interactive: { id: string; link: string; markdown: string }
let libraries: { id: string; link: string; markdown: string }
let escape: { id: string; link: string; markdown: string }
let webrtc: { id: string; link: string; markdown: string }

const FRAME = '[data-slot="html-report-frame"]'
const LINK = '[data-slot="user-bubble"] a[data-streamdown="link"]'

/** The probe report. With `navigate`, its script also tries to move its own frame away on load. */
function reportHtml(origin: string, navigate = false): string {
  return `<!doctype html><html><head><title>Probe report</title>
<meta http-equiv="refresh" content="0;url=${origin}/refresh">
<link rel="stylesheet" href="${origin}/css">
<style>@import url("${origin}/import"); body{margin:0;font:16px sans-serif}
#toc,#ext{position:absolute;left:0;display:block;width:240px;height:48px} #toc{top:0} #ext{top:64px} .tall{height:4000px;padding-top:140px}</style>
<script src="${origin}/remote.js"></script>
<script>
const tried = {}
const attempt = (name, run) => { try { run(); tried[name] = 'ran' } catch (error) { tried[name] = error.name } }
attempt('parent', () => { parent.document.title = 'owned' })
attempt('top', () => { top.document.title = 'owned' })
attempt('storage', () => localStorage.setItem('cez-report-probe', '1'))
attempt('cookie', () => document.cookie)
attempt('fetch', () => { fetch('${origin}/fetch').catch(() => {}); fetch('/api/v1/health').catch(() => {}) })
attempt('beacon', () => { new Image().src = '${origin}/script-img' })
attempt('socket', () => { new WebSocket('${origin.replace('http:', 'ws:')}/socket') })
attempt('topNav', () => { top.location = '${origin}/top' })
attempt('parentNav', () => { parent.location = '${origin}/parent' })
document.documentElement.dataset.probe = JSON.stringify(tried)
${navigate ? `addEventListener('load', () => {
  const refresh = document.createElement('meta'); refresh.httpEquiv = 'refresh'; refresh.content = '0;url=${origin}/script-refresh'; document.head.append(refresh)
  queueMicrotask(() => { location.href = '${origin}/self' })
})` : ''}
</script>
</head><body>
<a id="toc" href="#s2">Section two</a><a id="ext" href="${origin}/ext">External</a>
<img src="${origin}/img" alt=""><img src="/api/v1/health?probe=relative" alt="">
<form action="${origin}/form" method="post"><input name="q"></form>
<div class="tall">Quarterly results</div><h2 id="s2">Section two body</h2></body></html>`
}

/** A report built the way agents write them: tabs, a checkbox that updates text, a copy button. */
const INTERACTIVE_HTML = `<!doctype html><html><head><title>Interactive</title><style>
body{margin:0;font:16px sans-serif} #tab-b,#check,#copy,#answer,.panel{position:absolute;left:0;width:240px;height:40px;margin:0}
#tab-b{top:0} #check{top:60px} #copy{top:120px} #answer{top:180px} .panel{top:240px}</style></head><body>
<button id="tab-b" onclick="document.getElementById('panel-a').hidden = true; document.getElementById('panel-b').hidden = false">Tab B</button>
<label id="check"><input type="checkbox" id="pick"> Pick option 2</label>
<button id="copy">Copy answer</button><p id="answer">2: none</p>
<div class="panel" id="panel-a">Panel A</div><div class="panel" id="panel-b" hidden>Panel B</div>
<script>
const answer = document.getElementById('answer'), copy = document.getElementById('copy')
document.getElementById('pick').addEventListener('change', event => { answer.textContent = event.target.checked ? '2: picked' : '2: none' })
copy.addEventListener('click', () => navigator.clipboard.writeText(answer.textContent).then(() => { copy.textContent = 'Copied' }, error => { copy.textContent = 'Failed: ' + error.name }))
</script></body></html>`

/** A report whose script starts WebRTC ICE gathering against a STUN server: the probe's UDP port. */
function webrtcHtml(port: string): string {
  return `<!doctype html><html><head><title>WebRTC</title></head><body><p id="rtc">RTC</p><script>
const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] })
connection.createDataChannel('probe')
connection.createOffer().then(offer => connection.setLocalDescription(offer)).then(() => { document.documentElement.dataset.rtc = 'gathering' })
</script></body></html>`
}

/** A report that loads Tailwind (the v3 Play CDN) and Mermaid 11 from CDNs, as agents write them. */
const LIBRARY_HTML = `<!doctype html><html><head><title>Libraries</title><script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { theme: { extend: { colors: { brand: '#123456' } } } }</script></head><body>
<h1 id="styled" class="text-3xl font-bold text-red-600 border p-4">Styled</h1><p id="brand" class="bg-brand">Brand</p>
<pre class="mermaid" id="diagram">graph TD; A-->B</pre>
<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
mermaid.initialize({ startOnLoad: false }); await mermaid.run(); document.documentElement.dataset.mermaid = 'done'</script>
</body></html>`

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

type CdpRequest = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] }

/**
 * Finds the report document, the frame whose document holds `#marker`, and an isolated world in
 * it. Chrome can isolate the opaque frames in other processes: the report may sit in the page's
 * own frame tree or in an `about:srcdoc` iframe target. In either case CDP reads its document
 * without granting the report access to the cockpit's origin.
 */
async function findReport(request: CdpRequest, marker: string): Promise<{ pageSession: string; session: string; executionContextId: number }> {
  const url = browser.url()
  const { targetInfos: pages } = await request('Target.getTargets')
  const page = pages.find((target: { type: string; url: string }) => target.type === 'page' && target.url === url)
  const { sessionId: pageSession } = await request('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  const attached = new Map<string, string>([[page.targetId, pageSession]])
  return pollFor(async () => {
    const { targetInfos } = await request('Target.getTargets')
    for (const target of targetInfos.filter((entry: { type: string; url: string }) => entry.type === 'iframe' && entry.url === 'about:srcdoc')) {
      if (!attached.has(target.targetId)) attached.set(target.targetId, (await request('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId)
    }
    for (const session of attached.values()) {
      const { frameTree } = await request('Page.getFrameTree', {}, session)
      const frames: string[] = []
      const walk = (tree: FrameTree) => { frames.push(tree.frame.id); tree.childFrames?.forEach(walk) }
      walk(frameTree)
      for (const frameId of frames) {
        const { executionContextId } = await request('Page.createIsolatedWorld', { frameId, worldName: 'report-probe' }, session)
        const { result } = await request('Runtime.evaluate', { expression: `location.href.startsWith('about:srcdoc') && !!document.getElementById(${JSON.stringify(marker)})`, contextId: executionContextId, returnByValue: true }, session)
        if (result.value) return { pageSession, session, executionContextId }
      }
    }
    return undefined
  }, () => `no report document holds #${marker}`)
}

/** Polls every frame of the page until one has a URL `matches` accepts, and returns that URL. */
async function waitForFrameUrl(matches: (url: string) => boolean): Promise<string> {
  return browser.withCdp(async request => {
    const url = browser.url()
    const seen: string[] = []
    return pollFor(async () => {
      const { targetInfos } = await request('Target.getTargets')
      const frames = targetInfos.filter((target: { type: string; url: string }) => target.type === 'iframe' || (target.type === 'page' && target.url === url))
      seen.length = 0
      for (const target of frames) {
        const { sessionId } = await request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        const { frameTree } = await request('Page.getFrameTree', {}, sessionId)
        const walk = (tree: FrameTree & { frame: { url: string; unreachableUrl?: string } }) => { seen.push(tree.frame.unreachableUrl ? `${tree.frame.url} (${tree.frame.unreachableUrl})` : tree.frame.url); (tree.childFrames as typeof tree[] | undefined)?.forEach(walk) }
        walk(frameTree)
        await request('Target.detachFromTarget', { sessionId })
      }
      return seen.find(matches)
    }, () => `no frame matched; frames: ${JSON.stringify(seen)}`)
  })
}

/** Polls `expression` in the report document until `matches` accepts its value, and returns it. */
async function waitInReport<T>(marker: string, expression: string, matches: (value: T) => boolean): Promise<T> {
  return browser.withCdp(async request => {
    const { session, executionContextId } = await findReport(request, marker)
    let last: T | undefined
    return pollFor(async () => {
      const { result, exceptionDetails } = await request('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true }, session)
      if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails))
      last = result.value as T
      return matches(last) ? last : undefined
    }, () => `report value never matched: ${JSON.stringify(last)}`)
  })
}

/** Taps a point of the report, in report coordinates: the report frame fills the reader frame. */
function tapReport(x: number, y: number): void {
  const box = JSON.parse(browser.evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(FRAME)}).getBoundingClientRect())`) as string) as { left: number; top: number }
  browser.tapAt(box.left + x, box.top + y)
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-html-reader-')))
  hitsFile = join(root, 'hits.ndjson')
  udpFile = join(root, 'udp.log')
  probe = spawn(process.execPath, ['-e', `
    const http = require('node:http'); const fs = require('node:fs'); const dgram = require('node:dgram')
    const udp = dgram.createSocket('udp4'); udp.on('message', message => fs.appendFileSync(process.argv[2], message.length + '\\n'))
    const s = http.createServer((req, res) => { fs.appendFileSync(process.argv[1], JSON.stringify({ path: req.url, referer: req.headers.referer ?? null }) + '\\n'); res.setHeader('content-type', 'text/html'); res.end('<p>probe</p>') })
    udp.bind(0, '127.0.0.1', () => s.listen(0, '127.0.0.1', () => console.log(s.address().port + ' ' + udp.address().port)))`, hitsFile, udpFile], { stdio: ['ignore', 'pipe', 'inherit'] })
  const [port, udpPort] = (await new Promise<string>((done, fail) => {
    probe.stdout!.once('data', chunk => done(String(chunk).trim()))
    probe.once('exit', code => fail(new Error(`probe server exited with ${code}`)))
  })).split(' ')
  probeOrigin = `http://127.0.0.1:${port}`
  stunPort = udpPort!

  const project = join(root, 'project')
  execFileSync('git', ['init', '-q', '-b', 'main', project])
  mkdirSync(join(project, '.ai/cezar/runs'), { recursive: true })
  const env = fixtureServeEnv(project)
  mkdirSync(env.CEZ_HOME!, { recursive: true })
  const home = Home.sandbox(env.CEZ_HOME!)
  Home.seedBytes(home, home.workspaceConfig, Buffer.from(JSON.stringify({ projects: [{ id: 'reader', root: project }] })))
  const publish = (name: string, html: string) => {
    const source = join(root, name)
    writeFileSync(source, html)
    const published = JSON.parse(execFileSync(process.execPath, [squawkCli, 'artifact', 'publish', source], {
      cwd: project, env: { ...env, CEZ_PROJECT_ID: 'reader', CEZ_TASK_ID: runId, CEZ_ARTIFACTS_DIR: join(project, '.ai/cezar/runs', `${runId}-artifacts`) }, encoding: 'utf8',
    }))
    rmSync(source)
    return published
  }
  publication = publish('probe-report.html', reportHtml(probeOrigin))
  interactive = publish('interactive.html', INTERACTIVE_HTML)
  libraries = publish('libraries.html', LIBRARY_HTML)
  escape = publish('escape.html', reportHtml(probeOrigin, true))
  webrtc = publish('webrtc.html', webrtcHtml(stunPort))
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the long task description.`).join('\n\n')
  const run = makeRunRecord({
    id: runId, task: `${filler}\n\nRead ${publication.markdown} now.\n\n${filler}`, title: 'HTML report reader',
    status: RUN_STATUS.done, createdAt: '2026-11-01T08:00:00Z',
  })
  seedRuns(project, [run])
  mkdirSync(evidenceDir, { recursive: true })
  server = spawnFixtureServer([squawkCli, 'serve', '--repo', project, '--port', '0', '--no-open'], { env })
  baseUrl = await waitForFixtureServer(server)
  expect(await bootProjectId(baseUrl)).toBe('reader')
  browser = AgentBrowser.open(`html-reader-${process.pid}`)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await stopFixtureServer(probe)
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
  expect(browser.evaluate(`document.querySelector(${JSON.stringify(FRAME)}).getAttribute('sandbox')`)).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox')
  expect(browser.count('[data-slot="html-report-blocked"]')).toBe(1)
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

it('leaves the reader in one step after anchor clicks, also without the Navigation API', () => {
  browser.goto(baseUrl + threadPath())
  browser.waitForFunction(`document.querySelector(${JSON.stringify(LINK)}) !== null`)
  browser.evaluate(`document.querySelector(${JSON.stringify(LINK)}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  browser.click(LINK)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null && location.pathname === ${JSON.stringify(readerPath())}`)
  expectCockpitUntouched(readerPath())
  // The fallback path for engines without the Navigation API.
  browser.evaluate(`Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }) === window`)
  const frame = JSON.parse(browser.evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(FRAME)}).getBoundingClientRect())`) as string) as { left: number; top: number }
  const length = browser.evaluate('history.length') as number
  browser.tapAt(frame.left + 60, frame.top + 20)
  browser.waitForFunction(`history.length === ${length + 1}`)
  browser.click('[data-slot="report-bar"] button[aria-label="Back"]')
  browser.waitForFunction(`location.pathname === ${JSON.stringify(threadPath())} && document.querySelector(${JSON.stringify(LINK)}) !== null`)
})

it('scrolls an anchor inside the report without requesting the cockpit or an auth page', async () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  await browser.withCdp(async (request, subscribe) => {
    const { pageSession, session, executionContextId } = await findReport(request, 's2')
    const read = async () => {
      const { result, exceptionDetails } = await request('Runtime.evaluate', {
        expression: `({ url: location.href, scrollY, targetTop: document.getElementById('s2')?.getBoundingClientRect().top, height: innerHeight })`,
        contextId: executionContextId, returnByValue: true,
      }, session)
      if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails))
      return result.value as { url: string; scrollY: number; targetTop?: number; height: number }
    }
    const before = await read()
    expect(before.url).toBe('about:srcdoc')
    expect(before.scrollY).toBe(0)
    const documents: string[] = []
    const off = subscribe(event => {
      if ((event.sessionId === pageSession || event.sessionId === session) && event.method === 'Network.requestWillBeSent' && event.params.type === 'Document') documents.push(event.params.request.url)
    })
    await request('Network.enable', {}, pageSession)
    if (session !== pageSession) await request('Network.enable', {}, session)
    try {
      const box = JSON.parse(browser.evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(FRAME)}).getBoundingClientRect())`) as string) as { left: number; top: number }
      browser.tapAt(box.left + 60, box.top + 20)
      const after = await pollFor(async () => {
        const sample = await read()
        return sample.url === 'about:srcdoc#s2' && sample.scrollY > 0 ? sample : undefined
      }, () => `anchor left the report or did not scroll; document requests: ${JSON.stringify(documents)}`)
      expect(after.targetTop).toBeGreaterThanOrEqual(0)
      expect(after.targetTop).toBeLessThan(after.height)
      expect(documents).toEqual([])
      expect(hits()).toEqual([])
    } finally { off() }
  })
})

it.each([['with', false], ['without', true]])('goes to the conversation on Back after a cold flat link, %s the Navigation API', async (_label, removeNavigation) => {
  const originalUrl = browser.url()
  await browser.withCdp(async request => {
    const { targetInfos } = await request('Target.getTargets')
    const original = targetInfos.find((target: { type: string; url: string }) => target.type === 'page' && target.url === originalUrl)
    // A fresh tab: the flat link is its first entry, and the legacy redirect replaces it.
    const fresh = browser.newTab()
    try {
      browser.switchTab(fresh)
      browser.goto(`${baseUrl}/tasks/${runId}/report?artifact=${publication.id}`)
      browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null && location.pathname === ${JSON.stringify(readerPath())}`)
      if (removeNavigation) browser.evaluate(`Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }) === window`)
      browser.click('[data-slot="report-bar"] button[aria-label="Back"]')
      browser.waitForFunction(`location.pathname === ${JSON.stringify(threadPath())} && document.querySelector(${JSON.stringify(LINK)}) !== null`)
    } finally {
      browser.switchTab(original.targetId)
      await request('Target.closeTarget', { targetId: fresh })
    }
  })
})

it('runs report scripts without reaching the cockpit, the network or another window', async () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  const tried = JSON.parse(await waitInReport<string>('s2', 'document.documentElement.dataset.probe ?? ""', value => value !== '')) as Record<string, unknown>
  expect(tried).toMatchObject({ parent: 'SecurityError', top: 'SecurityError', storage: 'SecurityError', cookie: 'SecurityError' })
  expect(tried.topNav).not.toBe('ran')
  expect(tried.parentNav).not.toBe('ran')
  expectCockpitUntouched(readerPath())
  expect(hits()).toEqual([])
  expect(browser.text('[data-slot="html-report-blocked"]')).toContain('1 remote script')
})

it('refuses a report script that moves its own frame away, with no request leaving', async () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${escape.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  // The browser answers a refused frame navigation with its error page in that frame.
  expect(await waitForFrameUrl(url => url.includes(`${probeOrigin}/`))).toMatch(/^chrome-error:/)
  expectCockpitUntouched(readerPath())
  expect(hits()).toEqual([])
})

it('keeps the cockpit and the top window by the sandbox alone, on unprepared HTML', () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  // The spec's own frame, built with the reader's sandbox and the raw report (no cleanup, no CSP, no wrapper).
  browser.evaluate(`(() => { const raw = document.createElement('iframe'); raw.id = 'raw-probe'
    raw.setAttribute('sandbox', document.querySelector(${JSON.stringify(FRAME)}).getAttribute('sandbox'))
    raw.srcdoc = ${JSON.stringify(reportHtml(probeOrigin, true))}; document.body.append(raw) })()`)
  expectCockpitUntouched(readerPath())
  const paths = hits().map(hit => hit.path)
  for (const scripted of ['/top', '/parent']) expect(paths).not.toContain(scripted)
  // Without the CSP the frame may send requests; that is the CSP's job, tested next.
  rmSync(hitsFile, { force: true })
})

/** The reader's CSP meta, taken from the report document inside the reader's wrapper. */
const REPORT_CSP_META = `new DOMParser().parseFromString(document.querySelector(${JSON.stringify(FRAME)}).getAttribute('srcdoc'), 'text/html').querySelector('iframe').getAttribute('srcdoc').match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0]`

it('blocks every request but a navigation of the frame by the CSP alone, on unprepared HTML', async () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  browser.evaluate(`(() => { const meta = ${REPORT_CSP_META}
    const raw = document.createElement('iframe'); raw.id = 'csp-probe'
    raw.setAttribute('sandbox', document.querySelector(${JSON.stringify(FRAME)}).getAttribute('sandbox'))
    raw.srcdoc = ${JSON.stringify(reportHtml(probeOrigin, true))}.replace('<head>', '<head>' + meta); document.body.append(raw) })()`)
  expectCockpitUntouched(readerPath())
  // A CSP does not cover navigations: the meta refresh leaves. The wrapper frame closes that gap.
  const paths = await pollFor(() => { const seen = hits().map(hit => hit.path); return seen.length ? seen : undefined }, () => 'the frame did not navigate')
  for (const path of paths) expect(['/refresh', '/script-refresh', '/self']).toContain(path)
  rmSync(hitsFile, { force: true })
})

it('blocks every request, navigations included, by the wrapper frame alone, on unprepared HTML', () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  // The reader's wrapper document around the raw report: no cleanup, no report CSP of its own.
  browser.evaluate(`(() => { const reader = document.querySelector(${JSON.stringify(FRAME)})
    const report = ${JSON.stringify(reportHtml(probeOrigin, true))}.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    const raw = document.createElement('iframe'); raw.id = 'wrapper-probe'
    raw.setAttribute('sandbox', reader.getAttribute('sandbox'))
    raw.srcdoc = reader.getAttribute('srcdoc').replace(/ srcdoc="[^"]*"/, () => ' srcdoc="' + report + '"'); document.body.append(raw) })()`)
  expectCockpitUntouched(readerPath())
  expect(hits()).toEqual([])
})

it('runs tabs, a checkbox and a copy button in an interactive report', async () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${interactive.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  await waitInReport<boolean>('panel-b', "document.readyState === 'complete'", Boolean)
  tapReport(20, 20)
  await waitInReport<boolean>('panel-b', "!document.getElementById('panel-b').hidden && document.getElementById('panel-a').hidden", Boolean)
  tapReport(10, 80)
  await waitInReport<string>('panel-b', "document.getElementById('answer').textContent", value => value === '2: picked')
  tapReport(20, 140)
  expect(await waitInReport<string>('panel-b', "document.getElementById('copy').textContent", value => value !== 'Copy answer')).toBe('Copied')
  expect(hits()).toEqual([])
})

it('renders a report that loads Tailwind and Mermaid from CDNs with the pinned copies', async () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${libraries.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  const styled = await waitInReport<string>('styled', `(() => { const s = getComputedStyle(document.getElementById('styled'))
    return [s.fontSize, s.fontWeight, s.color, s.borderTopColor, s.paddingTop].join(' ') })()`, value => value.startsWith('30px'))
  // The v3 palette and border default: red-600 is #dc2626, the border gray-200 is #e5e7eb.
  expect(styled).toBe('30px 700 rgb(220, 38, 38) rgb(229, 231, 235) 16px')
  // A v3 `tailwind.config` script adds its own theme colors.
  await waitInReport<string>('brand', "getComputedStyle(document.getElementById('brand')).backgroundColor", value => value === 'rgb(18, 52, 86)')
  await waitInReport<string>('diagram', "document.documentElement.dataset.mermaid === 'done' && !!document.querySelector('#diagram svg') ? 'drawn' : ''", value => value === 'drawn')
  expect(browser.count('[data-slot="html-report-blocked"]')).toBe(0)
})

// ADR 0057: browsers let no page policy govern WebRTC ICE traffic, and Chrome does not know the
// CSP `webrtc` directive. This pins the known residual channel. When it fails, Chrome blocks it:
// add `webrtc 'block'` to REPORT_CSP and turn this into a block test.
it('still lets WebRTC ICE traffic leave the report frame, the residual channel ADR 0057 records', async () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${webrtc.id}`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(FRAME)}) !== null`)
  await waitInReport<string>('rtc', 'document.documentElement.dataset.rtc ?? ""', value => value === 'gathering')
  await pollFor(() => (existsSync(udpFile) && readFileSync(udpFile, 'utf8').trim() ? true : undefined), () => 'no STUN packet reached the probe')
  expect(hits()).toEqual([])
})

// The external link's new tab is not driven here: agent-browser attaches to every new tab and
// cannot attach to a noreferrer popup (see artifact-project-links.e2e.ts). html-report.test.ts
// pins the rewrite; the PR records a raw-CDP check of the opened tab.
it('renders external links for a new tab without opener or referrer', () => {
  browser.goto(`${baseUrl}${readerPath()}?artifact=${publication.id}`)
  const srcdoc = browser.waitForValue<string>(`(() => { const wrapper = document.querySelector(${JSON.stringify(FRAME)})?.getAttribute('srcdoc')
    return wrapper && new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe').getAttribute('srcdoc') })()`)
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
    expect(controls.map(([name]) => name).sort()).toEqual(['Back', 'Download', 'Source'])
    for (const [name, width, height] of controls) expect(Math.min(width, height), name).toBeGreaterThanOrEqual(44)
    browser.screenshot(join(evidenceDir, `reader-360-${theme}.png`), { viewport: true })
  }
  browser.setViewport(1440, 900)
})
