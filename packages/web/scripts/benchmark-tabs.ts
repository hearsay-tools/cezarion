/** Production-build benchmark for hearsay-tools/cezarion#924.
 * node --import tsx packages/web/scripts/benchmark-tabs.ts --build-root DIR --output FILE
 * --quick selects 1/10 distinct-task cases with 1s warmup/3s sampling for harness smoke only.
 * All browser protocol work goes through the repository's agent-browser provider seam.
 */
import { cpus, totalmem, release, platform } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { AgentBrowser } from '../e2e/agent-browser.ts'
import { createTabFixture } from '../e2e/tab-fixture.ts'
import { pollFor } from '../e2e/poll.ts'

const { values } = parseArgs({ options: { 'build-root': { type: 'string' }, output: { type: 'string' }, quick: { type: 'boolean' }, windows: { type: 'boolean' }, workload: { type: 'string' }, counts: { type: 'string' } } })
const buildRoot = resolve(values['build-root'] ?? '.')
const output = resolve(values.output ?? '.ai/qa/924/tabs.json')
const warmupMs = values.quick ? 1_000 : 5_000, sampleMs = values.quick ? 3_000 : 20_000
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) // sampling, never readiness
const rss = (pid: number) => { try { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024 } catch { return 0 } }
const ticks = (pid: number) => { try { const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' '); return Number(fields[11]) + Number(fields[12]) } catch { return 0 } }
const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }))
const buildHash = createHash('sha256')
const fingerprint = (directory: string) => {
  for (const entry of readdirSync(resolve(buildRoot, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) fingerprint(path)
    else if (entry.isFile()) buildHash.update(path).update(readFileSync(resolve(buildRoot, path)))
  }
}
fingerprint('packages/cezar/dist'); fingerprint('packages/cezar/web/dist')
const report: any = { buildRoot, builtContentSha256: buildHash.digest('hex'), sampledAt: new Date().toISOString(), sourceDirty: (() => { try { return !!execFileSync('git', ['status', '--porcelain'], { cwd: buildRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } })(), revision: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: buildRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'archived-c961c04a' } })(), productionBuild: true, quick: !!values.quick, windows: !!values.windows,
  host: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, ramBytes: totalmem() }, warmupMs, sampleMs, streamRatePerRun: 20, cases: [] }
mkdirSync(dirname(output), { recursive: true })
const save = () => writeFileSync(output, JSON.stringify(report, null, 2))
const workloads = values.workload ? [values.workload] : values.quick ? ['distinct'] : ['overview', 'repeated', 'distinct']
const counts = values.counts ? values.counts.split(',').map(Number) : values.quick ? [1, 10] : [1, 3, 6, 10]
if (workloads.some(value => !['overview', 'repeated', 'distinct'].includes(value)) || counts.some(value => ![1, 3, 6, 10].includes(value))) throw new Error('Use overview/repeated/distinct and counts from 1,3,6,10')
for (const workload of workloads) {
  for (const count of counts) for (const streaming of [false, true]) {
    const fixture = await createTabFixture(buildRoot)
    const browser = AgentBrowser.open(`tabs-${process.pid}-${workload}-${count}-${Number(streaming)}`)
    try {
      browser.goto('about:blank')
      await browser.withCdp(async (request, subscribe) => {
        report.browser ??= await request('Browser.getVersion')
        const pages: Array<{ targetId: string; sessionId: string }> = []
        const requests = new Map<string, any>(), sockets = new Map<string, string>(), workerSessions = new Set<string>()
        const off = subscribe(event => {
          if (event.method === 'Target.attachedToTarget' && event.params.targetInfo.type === 'shared_worker') {
            const sessionId = event.params.sessionId as string
            workerSessions.add(sessionId)
            void request('Network.enable', {}, sessionId).then(() => request('Runtime.runIfWaitingForDebugger', {}, sessionId)).catch(() => {})
          }
          const key = `${event.sessionId}/${event.params?.requestId}`
          if (event.method === 'Network.requestWillBeSent') requests.set(key, { url: event.params.request.url, method: event.params.request.method, at: performance.now() })
          if (event.method === 'Network.responseReceived') {
            const row = requests.get(key)
            if (row) Object.assign(row, { status: event.params.response.status, protocol: event.params.response.protocol, mime: event.params.response.mimeType })
          }
          if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
            const row = requests.get(key); if (row) Object.assign(row, { ended: true, failure: event.params.errorText })
          }
          if (event.method === 'Network.webSocketCreated') sockets.set(key, event.params.url)
          if (event.method === 'Network.webSocketClosed') sockets.delete(key)
        })
        await request('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [{ type: 'shared_worker', exclude: false }, { exclude: true }] })
        const selected = Array.from({ length: count }, (_, index) => workload === 'repeated' ? fixture.runs[0]! : fixture.runs[(index % 2) * 10 + Math.floor(index / 2)]!)
        await fixture.control({ streaming, runs: [...new Map(selected.map(run => [`${run.projectId}/${run.runId}`, run])).values()] })
        for (let index = 0; index < count; index++) {
          const { targetId } = await request('Target.createTarget', { url: 'about:blank', newWindow: !!values.windows })
          const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
          await request('Network.enable', {}, sessionId); await request('Performance.enable', {}, sessionId)
          pages.push({ targetId, sessionId })
        }
        const initialPublishers = await fixture.control()
        const coldStart = performance.now()
        await Promise.all(pages.map((page, index) => request('Page.navigate', { url: `${fixture.origin}${workload === 'overview' ? '/tasks' : `/p/${selected[index]!.projectId}/tasks/${selected[index]!.runId}`}` }, page.sessionId)))
        await request('Target.activateTarget', { targetId: pages[0]!.targetId })
        await pause(warmupMs)
        const pageState = async () => Promise.all(pages.map(async page => {
          const { result } = await request('Runtime.evaluate', { expression: '({visibility:document.visibilityState, main:!!document.querySelector("[data-slot=main]"), url:location.href})', returnByValue: true }, page.sessionId)
          return result.value
        }))
        const cold = { elapsedMs: performance.now() - coldStart, pages: await pageState(), requests: requests.size }
        const start = performance.now(), startTicks = ticks(fixture.server.pid!), browserStart = await request('SystemInfo.getProcessInfo')
        const getMetrics = async () => Promise.all(pages.map(async p => Object.fromEntries((await request('Performance.getMetrics', {}, p.sessionId)).metrics.map((m: any) => [m.name, m.value]))))
        const metricsStart = await getMetrics()
        const probes: any[] = [], interactions: any[] = []
        while (performance.now() - start < sampleMs) {
          const { result } = await request('Runtime.evaluate', { expression: `(async()=>{const at=performance.now();try{const r=await fetch('/api/v1/projects',{signal:AbortSignal.timeout(2000)});await r.text();return {ok:r.ok,ms:performance.now()-at}}catch(e){return {ok:false,ms:performance.now()-at,error:e.name}}})()`, awaitPromise: true, returnByValue: true }, pages[0]!.sessionId)
          probes.push(result.value)
          const at = performance.now()
          try {
            const box = await request('Runtime.evaluate', { expression: `(()=>{const b=document.querySelector('[data-slot=command-palette-hint]');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, returnByValue: true }, pages[0]!.sessionId)
            if (!box.result.value) throw new Error('Search button unavailable')
            await request('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box.result.value }, pages[0]!.sessionId)
            await request('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box.result.value }, pages[0]!.sessionId)
            await pollFor(async () => (await request('Runtime.evaluate', { expression: '!!document.querySelector("[role=dialog] [role=combobox]")', returnByValue: true }, pages[0]!.sessionId)).result.value ? true : undefined, () => 'search dialog missed deadline', { timeoutMs: 2_000, intervalMs: 20, tries: 100 })
            interactions.push({ ok: true, ms: performance.now() - at })
            await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, pages[0]!.sessionId)
            await request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, pages[0]!.sessionId)
          } catch (error) { interactions.push({ ok: false, ms: performance.now() - at, error: String(error) }) }
          await pause(Math.min(3_000, Math.max(0, sampleMs - (performance.now() - start))))
        }
        const browserEnd = await request('SystemInfo.getProcessInfo'), metricsEnd = await getMetrics(), all = [...requests.values()]
        const sample = { workload, tabs: count, streaming, cold, elapsedMs: performance.now() - start,
          requests: all.length, steadyRequests: all.filter(r => r.at >= start).length, failedRequests: all.filter(r => r.failure).length,
          pendingRequests: all.filter(r => !r.status && !r.ended).length,
          workspaceSse: all.filter(r => r.mime === 'text/event-stream' && r.url.includes('/workspace/events') && !r.ended).length,
          taskSse: all.filter(r => r.mime === 'text/event-stream' && !r.url.includes('/workspace/events') && !r.ended).length,
          topicSockets: [...sockets.values()].filter(url => url.endsWith('/api/v1/ws')).length, previewSockets: [...sockets.values()].filter(url => url.includes('/preview/ws')).length,
          workerSessions: workerSessions.size, protocols: [...new Set(all.map(r => r.protocol).filter(Boolean))],
          serverCpuMs: 1000 * (ticks(fixture.server.pid!) - startTicks) / hz, serverRssBytes: rss(fixture.server.pid!),
          browserCpuMs: 1000 * (browserEnd.processInfo.reduce((sum: number, p: any) => sum + Math.max(0, p.cpuTime - (browserStart.processInfo.find((before: any) => before.id === p.id)?.cpuTime ?? 0)), 0)),
          browserAggregateRssBytes: browserEnd.processInfo.reduce((sum: number, p: any) => sum + rss(p.id), 0),
          rendererTaskMs: metricsEnd.reduce((sum, m, index) => sum + 1000 * (m.TaskDuration - metricsStart[index]!.TaskDuration), 0),
          jsHeapBytes: metricsEnd.reduce((sum, m) => sum + m.JSHeapUsedSize, 0), probes, interactions, pages: await pageState(), initialPublishers, publishers: await fixture.control(),
        }
        report.cases.push(sample); save(); console.log(JSON.stringify({ workload, tabs: count, streaming, streams: sample.workspaceSse + sample.taskSse, failures: probes.filter(p => !p.ok).length }))
        off()
        await Promise.all(pages.map(page => request('Target.closeTarget', { targetId: page.targetId })))
      })
    } finally { browser.close(); await fixture.stop() }
  }
}
save()
