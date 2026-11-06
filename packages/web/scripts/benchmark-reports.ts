import { createHash } from 'node:crypto'
import { loadavg, cpus } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AgentBrowser } from '../e2e/agent-browser'
import { createTabFixture } from '../e2e/tab-fixture'
import { pollFor } from '../e2e/poll'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) // fixed workload sampling window
const quantile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null
const cpuTicks = (pid: number) => { const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' '); return Number(fields[11]) + Number(fields[12]) }
const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }))
function buildFingerprint(root: string, serverPackage: string): string {
  const hash = createHash('sha256')
  for (const directory of [`${serverPackage}/dist`, `${serverPackage}/web/dist`]) {
    const base = join(root, directory)
    for (const path of readdirSync(base, { recursive: true }).map(String).sort()) {
      if (statSync(join(base, path)).isFile()) hash.update(directory + '/' + path).update(readFileSync(join(base, path)))
    }
  }
  return hash.digest('hex')
}
const instrumentation = `
window.__reportBench={commits:[],longTasks:[],events:[]};
window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject(){return 1},onCommitFiberRoot(_id,root){const ms=root.current.actualDuration;if(typeof ms==='number')window.__reportBench.commits.push(ms)},onCommitFiberUnmount(){}};
for(const [type,key] of [['longtask','longTasks'],['event','events']])try{new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__reportBench[key].push({name:entry.name,duration:entry.duration})}).observe({type,buffered:true,durationThreshold:16})}catch{}
`

/** Same harness and fixtures run against both built revisions. No live cockpit access. */
export async function benchmarkReports(buildRoot: string, output: string, quick: boolean, serverPackage = 'packages/cezar') {
  const report: any = { workload: 'reports', buildRoot, builtContentSha256: buildFingerprint(buildRoot, serverPackage), sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: buildRoot, encoding: 'utf8' }).trim(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: buildRoot, encoding: 'utf8' }).trim(), sampledAt: new Date().toISOString(), cpu: cpus()[0]?.model, affinity: readFileSync('/proc/self/status', 'utf8').match(/Cpus_allowed_list:\s*(.*)/)?.[1], quick, sampleMs: quick ? 5_000 : 20_000, repeats: quick ? 1 : 5, cases: [] }
  mkdirSync(dirname(output), { recursive: true })
  for (let iteration = 0; iteration < report.repeats; iteration++) {
    const beforeLoad = loadavg()
    const fixture = await createTabFixture(buildRoot, { serverPackage })
    const browser = AgentBrowser.open(`reports-${process.pid}-${iteration}`)
    try {
      const seeded = await fixture.control({ reportsSetup: true })
      browser.goto('about:blank')
      await browser.withCdp(async (request, subscribe) => {
        report.browser ??= await request('Browser.getVersion')
        const requests = new Map<string, any>()
        const off = subscribe(event => {
          const key = `${event.sessionId}/${event.params?.requestId}`
          if (event.method === 'Target.attachedToTarget' && event.params.targetInfo.type === 'shared_worker') {
            void request('Network.enable', {}, event.params.sessionId).then(() => request('Runtime.runIfWaitingForDebugger', {}, event.params.sessionId))
          }
          if (event.method === 'Network.requestWillBeSent' && /\/reports(?:\?|$|\/state)/.test(event.params.request.url)) requests.set(key, { url: event.params.request.url, start: performance.now() })
          if (event.method === 'Network.responseReceived') { const row = requests.get(key); if (row) row.status = event.params.response.status }
          if (event.method === 'Network.loadingFinished') { const row = requests.get(key); if (row) Object.assign(row, { end: performance.now(), bytes: event.params.encodedDataLength }) }
        })
        await request('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [{ type: 'shared_worker', exclude: false }, { exclude: true }] })
        const { targetId } = await request('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
        await request('Network.enable', {}, sessionId)
        await request('Page.enable', {}, sessionId)
        await request('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation }, sessionId)
        const evaluate = async (expression: string) => {
          const response = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
          return response.result.value
        }
        await request('Page.navigate', { url: `${fixture.origin}/p/boot/reports` }, sessionId)
        await request('Target.activateTarget', { targetId })
        await pollFor(async () => await evaluate('document.querySelectorAll("[data-slot=report-row]").length') > 0 ? true : undefined, () => 'report shelf did not mount', { timeoutMs: 30_000, intervalMs: 100, tries: 300 })
        await pause(2_000)
        await fixture.control({ resetIo: true, reportsStart: true })
        const start = performance.now(), ticks = cpuTicks(fixture.server.pid!)
        await evaluate('window.__reportBench.commits=[];window.__reportBench.longTasks=[];window.__reportBench.events=[]')
        await pause(quick ? 1_000 : 5_000)
        const publication = (await fixture.control({ reportsPublish: true })).reportsFixture!.publication!
        const detected = await pollFor(async () => await evaluate('document.querySelector("[data-slot=reports-list]")?.textContent.includes("New publication")') ? Date.now() : undefined, () => 'publication missed 15s detection bound', { timeoutMs: 15_000, intervalMs: 50, tries: 300 })
        await pause(Math.max(0, report.sampleMs - (performance.now() - start)))
        const end = performance.now(), endTicks = cpuTicks(fixture.server.pid!)
        const control = await fixture.control({ reportsStop: true })
        let browserMetrics = await evaluate('window.__reportBench')
        const steady = [...requests.values()].filter(row => row.start >= start && row.start < end)
        const lists = steady.filter(row => !row.url.includes('/reports/state'))
        // Correctness reads are outside the measured window, and inspect all cursor pages.
        const actual = await evaluate(`(async()=>{const pages=[];let before;do{const r=await fetch('/api/v1/p/boot/reports'+(before?'?before='+encodeURIComponent(before):''));const page=await r.json();pages.push(page);before=page.nextCursor}while(before);return {total:pages[0].total,rows:pages.flatMap(p=>p.reports)}})()`)
        await evaluate(`document.querySelector('input[aria-label="Search reports"]').focus()`)
        const interactionStart = performance.now()
        await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', text: 'r' }, sessionId)
        await request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' }, sessionId)
        await pollFor(async () => await evaluate('location.search.includes("q=r") && document.querySelectorAll("[data-slot=report-row]").length > 0') ? true : undefined, () => 'search interaction missed bound', { timeoutMs: 5_000, intervalMs: 50, tries: 100 })
        const searchInteractionMs = performance.now() - interactionStart
        await pause(100)
        browserMetrics = { ...browserMetrics, events: (await evaluate('window.__reportBench')).events }
        const expectedIds = [...seeded.reportsFixture!.artifacts.map(row => row.id), publication.id].sort()
        const actualIds = actual.rows.map((row: any) => row.id).sort()
        const expectedTitles = { ...Object.fromEntries(seeded.reportsFixture!.artifacts.map(row => [row.runId, row.taskTitle])), ...control.reportTitles }
        const correct = actual.total === 121 && actual.rows.length === 121 && JSON.stringify(actualIds) === JSON.stringify(expectedIds) && actual.rows.every((row: any) => expectedTitles[row.runId] === row.taskTitle)
        const sample = { iteration, loadBefore: beforeLoad, loadAfter: loadavg(), elapsedMs: end - start, reportRequests: lists.length, reportBytes: lists.reduce((n, row) => n + (row.bytes ?? 0), 0), stateRequests: steady.length - lists.length, requestLatency: { p50: quantile(lists.filter(row => row.end).map(row => row.end - row.start), .5), p95: quantile(lists.filter(row => row.end).map(row => row.end - row.start), .95) }, io: control.reportIo, publicationLatencyMs: detected - publication.at, serverCpuMs: (endTicks - ticks) * 1_000 / hz, reactCommitMs: { count: browserMetrics.commits.length, p50: quantile(browserMetrics.commits, .5), p95: quantile(browserMetrics.commits, .95) }, longTasks: browserMetrics.longTasks, eventTiming: browserMetrics.events, searchInteractionMs, correctness: { correct, total: actual.total, rows: actual.rows, ids: actualIds, expectedIds }, seeded: seeded.reportsFixture }
        report.cases.push(sample)
        writeFileSync(output, JSON.stringify(report, null, 2))
        off(); await request('Target.closeTarget', { targetId })
        console.log(JSON.stringify({ iteration, requests: sample.reportRequests, scans: sample.io.scans, correct }))
        if (!correct) throw new Error('report workload correctness mismatch')
      })
    } finally { browser.close(); await fixture.stop() }
  }
}
