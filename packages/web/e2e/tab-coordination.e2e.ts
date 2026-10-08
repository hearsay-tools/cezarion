import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { AgentBrowser } from './agent-browser'
import { createTabFixture } from './tab-fixture'
import { pollFor } from './poll'

let fixture: Awaited<ReturnType<typeof createTabFixture>>
let browser: AgentBrowser
let baseline: Awaited<ReturnType<typeof fixture.control>>
beforeAll(async () => {
  fixture = await createTabFixture()
  baseline = await fixture.control()
  browser = AgentBrowser.open(`e2e-tabs-${process.pid}`)
  browser.goto('about:blank')
})
beforeEach(async () => {
  // A closed page can still have a finite batch finishing server-side. Never
  // promote those temporary listeners into the next test's expected baseline.
  await pollFor(async () => JSON.stringify((await fixture.control()).listeners) === JSON.stringify(baseline.listeners) ? true : undefined,
    async () => `previous document demand did not drain: ${JSON.stringify((await fixture.control()).listeners)}`, { timeoutMs: 20_000, tries: 100 })
})
afterAll(async () => { browser?.close(); await fixture?.stop() })

type Request = Parameters<Parameters<AgentBrowser['withCdp']>[0]>[0]
const read = async (request: Request, session: string, expression: string) =>
  (await request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)).result.value
const waitText = (request: Request, session: string, text: string) => pollFor(async () =>
  await read(request, session, `document.body.innerText.includes(${JSON.stringify(text)})`) ? true : undefined,
  async () => `transcript never contained ${text}: ${await read(request, session, 'document.body.innerText')}`, { timeoutMs: 22_000, tries: 100 })

it.each([false, true])('ten mixed tabs (separate visible windows: %s) share worker transport and preserve project transcripts', async windows => {
  await browser.withCdp(async (request, subscribe) => {
    const pages: Array<{ targetId: string; sessionId: string }> = []
    const streams = new Set<string>(), sockets = new Set<string>(), workers = new Set<string>(), protocols = new Set<string>()
    const primary = windows ? 0 : 1
    const off = subscribe(event => {
      if (event.method === 'Target.attachedToTarget' && event.params.targetInfo.type === 'shared_worker') {
        workers.add(event.params.targetInfo.targetId)
        void request('Network.enable', {}, event.params.sessionId).then(() => request('Runtime.runIfWaitingForDebugger', {}, event.params.sessionId))
      }
      const key = `${event.sessionId}:${event.params.requestId}`
      if (event.method === 'Network.responseReceived') {
        protocols.add(event.params.response.protocol)
        if (event.params.response.mimeType === 'text/event-stream') streams.add(key)
      }
      if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') streams.delete(key)
      if (event.method === 'Network.webSocketCreated') sockets.add(key)
      if (event.method === 'Network.webSocketClosed') sockets.delete(key)
    })
    await request('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [{ type: 'shared_worker', exclude: false }, { exclude: true }] })
    try {
      expect(fixture.runs).toHaveLength(20)
      for (let i = 0; i < 10; i++) {
        const { targetId } = await request('Target.createTarget', { url: 'about:blank', newWindow: windows })
        const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
        await request('Network.enable', {}, sessionId)
        pages.push({ targetId, sessionId })
      }
      const selected = pages.map((_, index) => fixture.runs[(index % 2) * 10 + Math.floor(index / 2)]!)
      await Promise.all(pages.map((page, i) => request('Page.navigate', {
        url: `${fixture.origin}${!windows && i % 3 === 0 ? '/tasks' : `/p/${selected[i]!.projectId}/tasks/${selected[i]!.runId}`}`,
      }, page.sessionId)))
      for (const [i, page] of pages.entries()) {
        if (!windows) await request('Target.activateTarget', { targetId: page.targetId })
        if (windows || i % 3 !== 0) await waitText(request, page.sessionId, `Tab fixture transcript ${selected[i]!.runId}`)
      }
      await request('Target.activateTarget', { targetId: pages[primary]!.targetId })
      await pollFor(async () => streams.size === 2 && sockets.size === 1 ? true : undefined,
        () => `live union: ${streams.size} SSE, ${sockets.size} WS, ${workers.size} workers`, { timeoutMs: 20_000 })
      expect(workers.size).toBe(1)
      expect(protocols.has('http/1.1')).toBe(true)
      const visibility = await Promise.all(pages.map(page => read(request, page.sessionId, 'document.visibilityState')))
      expect(visibility.filter(v => v === 'visible')).toHaveLength(windows ? 10 : 1)
      expect(await read(request, pages[primary]!.sessionId, `(async()=>{try{const r=await fetch('/api/v1/projects',{signal:AbortSignal.timeout(2000)});await r.text();return r.ok}catch{return false}})()`)).toBe(true)
      const unique = `isolated-${Date.now()}`
      await fixture.control({ publish: unique, runs: [selected[primary]] })
      await waitText(request, pages[primary]!.sessionId, unique)
      // Late join/navigation hydrates its own cursor; another project never receives the row.
      await request('Page.navigate', { url: `${fixture.origin}/p/${selected[primary]!.projectId}/tasks/${selected[primary]!.runId}` }, pages[2]!.sessionId)
      await request('Target.activateTarget', { targetId: pages[2]!.targetId })
      await waitText(request, pages[2]!.sessionId, unique)
      expect(await read(request, pages[windows ? 1 : 4]!.sessionId, `document.body.innerText.includes(${JSON.stringify(unique)})`)).toBe(false)
      // Explicit port/worker loss recovers from document cursors through finite HTTP.
      for (const targetId of workers) await request('Target.closeTarget', { targetId }).catch(() => {})
      const recovered = `${unique}-recovered`
      await fixture.control({ publish: recovered, runs: [selected[primary]] })
      await waitText(request, pages[2]!.sessionId, recovered)
      // A real navigation and history restoration recover content written while away.
      const history = await request('Page.getNavigationHistory', {}, pages[2]!.sessionId)
      const entryId = history.entries[history.currentIndex].id
      await request('Page.navigate', { url: 'about:blank' }, pages[2]!.sessionId)
      // Page.navigate acknowledges before the new document commits. Back during
      // that handoff can target Chrome's temporarily inactive old page.
      await pollFor(async () => {
        try { return await read(request, pages[2]!.sessionId, 'location.href === "about:blank" && document.readyState === "complete"') ? true : undefined }
        catch { return undefined } // Execution contexts disappear during navigation.
      }, () => 'navigation away did not commit')
      const navigated = `${unique}-navigation`
      await fixture.control({ publish: navigated, runs: [selected[primary]] })
      await request('Page.navigateToHistoryEntry', { entryId }, pages[2]!.sessionId)
      await waitText(request, pages[2]!.sessionId, navigated)
      expect(await read(request, pages[2]!.sessionId, `document.body.innerText.split(${JSON.stringify(navigated)}).length - 1`)).toBe(1)
    } finally {
      await Promise.all(pages.map(page => request('Target.closeTarget', { targetId: page.targetId })))
      await pollFor(async () => {
        const current = await fixture.control()
        return JSON.stringify(current.listeners) === JSON.stringify(baseline.listeners) ? true : undefined
      }, () => 'last tab did not release server listeners', { timeoutMs: 20_000 })
      off()
    }
  })
})

it('blocked SharedWorker uses finite HTTP in ten visible windows and aborts on pagehide', async () => {
  await browser.withCdp(async (request, subscribe) => {
    const pages: Array<{ targetId: string; sessionId: string }> = []
    const persistent: string[] = []
    const off = subscribe(event => {
      if (event.method === 'Network.webSocketCreated' || event.method === 'Network.responseReceived' && event.params.response.mimeType === 'text/event-stream') persistent.push(event.method)
    })
    try {
      for (let i = 0; i < 10; i++) {
        const { targetId } = await request('Target.createTarget', { url: 'about:blank', newWindow: true })
        const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
        await request('Network.enable', {}, sessionId)
        await request('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.SharedWorker=class{constructor(){throw new Error("blocked by browser policy")}}' }, sessionId)
        pages.push({ targetId, sessionId })
      }
      const run = fixture.runs[0]!
      await Promise.all(pages.map(page => request('Page.navigate', { url: `${fixture.origin}/p/${run.projectId}/tasks/${run.runId}` }, page.sessionId)))
      await Promise.all(pages.map(page => waitText(request, page.sessionId, `Tab fixture transcript ${run.runId}`)))
      const text = `finite-${Date.now()}`
      await fixture.control({ publish: text, runs: [run] })
      await Promise.all(pages.map(page => waitText(request, page.sessionId, text)))
      for (const snapshot of [false, true]) {
        const typing = `unfinished-${snapshot}-${Date.now()}`
        await fixture.control({ ephemeral: typing, snapshot, runs: [run] })
        await Promise.all(pages.map(page => waitText(request, page.sessionId, typing)))
      }
      expect(persistent).toEqual([])
      expect(await read(request, pages[0]!.sessionId, `(async()=>{const r=await fetch('/api/v1/projects',{signal:AbortSignal.timeout(2000)});return r.ok})()`)).toBe(true)
      await request('Runtime.evaluate', { expression: 'window.dispatchEvent(new Event("pagehide"))' }, pages[0]!.sessionId)
      await request('Runtime.evaluate', { expression: 'window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))' }, pages[0]!.sessionId)
      const restored = `${text}-restored`
      await fixture.control({ publish: restored, runs: [run] })
      await waitText(request, pages[0]!.sessionId, restored)
    } finally { off(); await Promise.all(pages.map(page => request('Target.closeTarget', { targetId: page.targetId }))) }
  })
})

it('remote Basic Auth keeps finite recovery authenticated without a worker or ordinary socket', async () => {
  const remote = await createTabFixture(process.cwd(), { remote: true, basicAuth: true })
  try {
    await browser.withCdp(async (request, subscribe) => {
      const persistent: string[] = [], failures: number[] = []
      const { targetId } = await request('Target.createTarget', { url: 'about:blank', newWindow: true })
      const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
      const off = subscribe(event => {
        if (event.sessionId !== sessionId) return
        if (event.method === 'Network.webSocketCreated' || event.method === 'Network.responseReceived' && event.params.response.mimeType === 'text/event-stream') persistent.push(event.method)
        if (event.method === 'Network.responseReceived' && event.params.response.status === 401) failures.push(401)
      })
      try {
        await request('Network.enable', {}, sessionId)
        await request('Network.setExtraHTTPHeaders', { headers: { Authorization: `Basic ${Buffer.from('fixture:fixture').toString('base64')}` } }, sessionId)
        const run = remote.runs[0]!
        await request('Page.navigate', { url: `${remote.origin}/p/${run.projectId}/tasks/${run.runId}` }, sessionId)
        await waitText(request, sessionId, `Tab fixture transcript ${run.runId}`)
        const text = `authenticated-${Date.now()}`
        await remote.control({ publish: text, runs: [run] })
        await waitText(request, sessionId, text)
        for (const snapshot of [false, true]) {
          const typing = `authenticated-unfinished-${snapshot}-${Date.now()}`
          await remote.control({ ephemeral: typing, snapshot, runs: [run] })
          await waitText(request, sessionId, typing)
        }
        await request('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId)
        const afterOffline = `${text}-after-offline`
        await remote.control({ publish: afterOffline, runs: [run] })
        await request('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId)
        await waitText(request, sessionId, afterOffline)
        expect(await read(request, sessionId, `document.body.innerText.split(${JSON.stringify(afterOffline)}).length - 1`)).toBe(1)
        expect(persistent).toEqual([])
        expect(failures).toEqual([])
      } finally { off(); await request('Target.closeTarget', { targetId }) }
    })
  } finally { await remote.stop() }
})


it('a frozen document releases its demand and rehydrates after native resume', async () => {
  await browser.withCdp(async request => {
    const { targetId } = await request('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
    const sibling = await request('Target.createTarget', { url: 'about:blank' })
    await request('Target.activateTarget', { targetId })
    try {
      const run = fixture.runs[0]!
      await request('Page.navigate', { url: `${fixture.origin}/p/${run.projectId}/tasks/${run.runId}` }, sessionId)
      await waitText(request, sessionId, `Tab fixture transcript ${run.runId}`)
      await pollFor(async () => (await fixture.control()).listeners.some(current => current.event > baseline.listeners.find(initial => initial.projectId === current.projectId)!.event) ? true : undefined,
        () => 'visible document never established server demand')
      await read(request, sessionId, `window.__tabLifecycle=[];for(const name of ['freeze','resume','visibilitychange'])document.addEventListener(name,()=>window.__tabLifecycle.push([name,document.visibilityState]));true`)
      await request('Page.setWebLifecycleState', { state: 'frozen' }, sessionId)
      await request('Target.activateTarget', { targetId: sibling.targetId })
      await pollFor(async () => JSON.stringify((await fixture.control()).listeners) === JSON.stringify(baseline.listeners) ? true : undefined,
        async () => `frozen document retained server demand: baseline=${JSON.stringify(baseline.listeners)} current=${JSON.stringify((await fixture.control()).listeners)}`, { timeoutMs: 20_000, tries: 100 }).catch(async error => {
          await request('Page.setWebLifecycleState', { state: 'active' }, sessionId)
          throw new Error(`${String(error)} lifecycle=${JSON.stringify(await read(request, sessionId, '({events:window.__tabLifecycle,visibility:document.visibilityState})'))}`)
        })
      const text = `after-sleep-${Date.now()}`
      await fixture.control({ publish: text, runs: [run] })
      await request('Page.setWebLifecycleState', { state: 'active' }, sessionId)
      // CDP active resumes execution but intentionally leaves visibility hidden. Switch a
      // real sibling tab and back, as a user returning to a suspended tab would.
      await request('Target.activateTarget', { targetId })
      try { await waitText(request, sessionId, text) } catch(error) { throw new Error(`${String(error)} lifecycle=${JSON.stringify(await read(request, sessionId, '({events:window.__tabLifecycle,visibility:document.visibilityState})'))} listeners=${JSON.stringify(await fixture.control())}`) }
      await fixture.control({ disconnect: true })
      const reconnected = `${text}-reconnect`
      await fixture.control({ publish: reconnected, runs: [run] })
      await waitText(request, sessionId, reconnected)
    } finally { await request('Target.closeTarget', { targetId }).catch(error => console.log(String(error))); await request('Target.closeTarget', { targetId: sibling.targetId }).catch(() => {}) }
  })
})
