/**
 * The runs-index workload of benchmark-tabs.ts (hearsay-tools/cezarion#2729, plan § S5):
 * `--workload index`. One tab per case on a production (profiling) build over the index fixture
 * (`tab-fixture-server.mjs --index`): 808 index roots in two truncated projects, one running
 * delegation parent with four running workers.
 *
 * Views: `closed` (the boot project's task list), `all-tasks` (the global Tasks page) and
 * `detail` (the delegation parent's task detail). Phases, in order, each its own window:
 * - `cold`: navigation and 8 s of bootstrap, then until the cockpit settles (`settled`);
 * - `update`: one row's title changes once; 3 s, with the time until the title shows on the page;
 * - `sustained`: 5 token ticks per second for 60 s, round-robin over the parent, its workers and
 *   three `other` roots; an ordinary GET probe every second;
 * - `reconnect`: the server drops every connection; 8 s, then until the fenced read has landed.
 *
 * Per window: `runs-index` and `/runs/:id` requests and body bytes, workspace SSE body bytes, all
 * bytes, `runs-index` request durations, probe p50/p95, server CPU, renderer task time and React
 * commits (count and `actualDuration` of each committed root, from a DevTools-hook shim; it reads
 * durations only from a `react-dom/profiling` build, `vite.profiling.config.ts`).
 *
 * `--profile-out PREFIX` writes a renderer CPU profile of the sustained phase. It adds overhead, so
 * the report's runs leave it off.
 */
import { execFileSync } from 'node:child_process'
import { loadavg } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { AgentBrowser } from '../e2e/agent-browser.ts'
import { createTabFixture } from '../e2e/tab-fixture.ts'
import { pollFor } from '../e2e/poll.ts'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) // sampling, never readiness
const ticks = (pid: number) => { try { const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' '); return Number(fields[11]) + Number(fields[12]) } catch { return 0 } }
const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }))
const quantile = (values: number[], q: number): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const round = (value: number | null) => value === null ? null : Math.round(value * 100) / 100

/** Records every committed root's render time. Installed before the app's first script. React
 *  19.2's profiling build also writes a Performance-panel track through `console.timeStamp` for
 *  every component of every commit; that is profiler cost, not app cost, so the shim removes it. */
const HOOK_SHIM = `(() => {
  try { Object.defineProperty(console, 'timeStamp', { value: undefined, configurable: true }) } catch {}
  const commits = []
  Object.defineProperty(window, '__cezCommits', { value: commits })
  const hook = { supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
    onCommitFiberRoot(_id, root) { commits.push(typeof root.current.actualDuration === 'number' ? root.current.actualDuration : -1) } }
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true })
})()`

const VIEWS = ['closed', 'all-tasks', 'detail'] as const
type View = (typeof VIEWS)[number]

interface RequestRow { sessionId: string | undefined; requestId: string; completedAt?: number; url: string; at: number; startTs?: number; durationMs?: number; ended?: boolean; chunks: Array<[number, number]> }

export async function runIndexWorkload(options: {
  buildRoot: string; report: { cases: unknown[] }; save: () => void; views?: string[] | undefined; cpu?: string | undefined
  sustainedMs?: number | undefined
  /** How long the `update` phase waits for the title on the page, at least 3 s (the default). */
  updateWindowMs?: number | undefined
  /** The Squawk package to serve, relative to `buildRoot`: the production build by default. */
  serverPackage?: string | undefined
  /** Diagnostics: a renderer CPU profile of the sustained phase. */
  profileOut?: string | undefined
}) {
  const views = (options.views?.length ? options.views : VIEWS) as View[]
  if (views.some(view => !VIEWS.includes(view))) throw new Error(`Use views from ${VIEWS.join(',')}`)
  const sustainedMs = options.sustainedMs ?? 60_000
  for (const view of views) {
    const fixture = await createTabFixture(options.buildRoot, { serverPackage: options.serverPackage ?? 'packages/cezar', indexSeed: true })
    const pid = fixture.server.pid!
    // One CPU for the cockpit server, so its CPU time is not spread by the shared host's load.
    if (options.cpu !== undefined) execFileSync('taskset', ['-a', '-cp', options.cpu, String(pid)], { stdio: 'ignore' })
    const browser = AgentBrowser.open(`index-${process.pid}-${view}`)
    const loadBefore = loadavg()
    try {
      browser.goto('about:blank')
      await browser.withCdp(async (request, subscribe) => {
        const requests = new Map<string, RequestRow>()
        const off = subscribe(event => {
          if (event.method === 'Target.attachedToTarget' && ['shared_worker', 'worker'].includes(event.params.targetInfo.type)) {
            const sessionId = event.params.sessionId as string
            void request('Network.enable', {}, sessionId).then(() => request('Runtime.runIfWaitingForDebugger', {}, sessionId)).catch(() => {})
          }
          const key = `${event.sessionId}/${event.params?.requestId}`
          if (event.method === 'Network.requestWillBeSent') requests.set(key, { sessionId: event.sessionId, requestId: event.params.requestId, url: event.params.request.url, at: performance.now(), startTs: event.params.timestamp, chunks: [] })
          if (event.method === 'Network.dataReceived') requests.get(key)?.chunks.push([performance.now(), event.params.dataLength])
          if (event.method === 'Network.loadingFinished') {
            const row = requests.get(key)
            if (row?.startTs !== undefined) row.durationMs = 1000 * (event.params.timestamp - row.startTs)
            if (row) { row.ended = true; row.completedAt = performance.now() }
          }
          if (event.method === 'Network.loadingFailed') { const row = requests.get(key); if (row) row.ended = true }
        })
        await request('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [{ type: 'shared_worker', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }] })
        const { targetId } = await request('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
        // Dedicated workers are descendants of this page; shared workers attach at browser scope.
        await request('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [{ type: 'worker', exclude: false }, { exclude: true }] }, sessionId)
        await request('Network.enable', {}, sessionId); await request('Performance.enable', {}, sessionId); await request('Page.enable', {}, sessionId)
        await request('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SHIM }, sessionId)
        const { profileOut } = options
        const evaluate = async (expression: string) => {
          return (await request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value
        }
        const taskMs = async () => Object.fromEntries((await request('Performance.getMetrics', {}, sessionId)).metrics.map((m: { name: string; value: number }) => [m.name, m.value])).TaskDuration as number
        const takeCommits = async () => {
          return (await evaluate('window.__cezCommits ? window.__cezCommits.splice(0) : []')) as number[]
        }

        const state = await fixture.control()
        const family = state.family!
        // Unarchived roots, so every target is an index row the global Tasks page lists by title.
        const otherRoots = state.indexRoots!.other!.map(runId => ({ projectId: 'other', runId }))
        const path = view === 'all-tasks' ? '/tasks' : view === 'detail' ? `/p/boot/tasks/${family.parent}` : '/p/boot'

        /** The product's own settle signals: the workspace stream passed its attachment barrier
         *  (`__cezLive`), nothing is in flight (`__cezIdle`), and an index read started since `since`
         *  has landed. A slow bootstrap or reconnect then extends its phase instead of leaking its
         *  index read into the next one. A cockpit that settled within the phase adds no time. */
        const settled = async (since: number) => {
          await pollFor(async () => {
            const index = [...requests.values()].filter(row => row.url.includes('/workspace/runs-index') && row.at >= since)
            const landed = index.some(row => row.durationMs !== undefined) && index.every(row => row.ended)
            return landed && await evaluate('window.__cezLive === true && window.__cezIdle === true') ? true : undefined
          }, () => `index workload (${view}): the cockpit did not settle`, { timeoutMs: 30_000, intervalMs: 100, tries: 300 })
        }
        const phases: Record<string, unknown> = {}
        const measure = async (name: string, body: () => Promise<Record<string, unknown> | void>) => {
          const t0 = performance.now(), cpu0 = ticks(pid), task0 = await taskMs().catch(() => 0)
          await takeCommits().catch(() => [])
          const extra = await body() ?? {}
          const t1 = performance.now()
          const minutes = (t1 - t0) / 60_000
          const inWindow = [...requests.values()].filter(row => row.at >= t0 && row.at < t1)
          const bodyBytes = (rows: RequestRow[]) => rows.reduce((sum, row) => sum + row.chunks.reduce((total, [, bytes]) => total + bytes, 0), 0)
          const index = inWindow.filter(row => row.url.includes('/workspace/runs-index'))
          const details = inWindow.filter(row => /\/api\/v1\/(?:p\/[^/]+\/)?runs\/[^/?]+(?:\?.*)?$/.test(row.url))
          const sseBytes = [...requests.values()].filter(row => row.url.includes('/workspace/events'))
            .reduce((sum, row) => sum + row.chunks.filter(([at]) => at >= t0 && at < t1).reduce((total, [, bytes]) => total + bytes, 0), 0)
          const allBytes = [...requests.values()].reduce((sum, row) => sum + row.chunks.filter(([at]) => at >= t0 && at < t1).reduce((total, [, bytes]) => total + bytes, 0), 0)
          const commits = (await takeCommits().catch(() => [])).filter(ms => ms >= 0)
          const durations = index.flatMap(row => row.durationMs === undefined ? [] : [row.durationMs])
          phases[name] = {
            elapsedMs: Math.round(t1 - t0),
            indexRequests: index.length, indexRequestsPerMin: round(index.length / minutes), indexBodyBytes: bodyBytes(index),
            indexDurationP50Ms: round(quantile(durations, 0.5)), indexDurationP95Ms: round(quantile(durations, 0.95)),
            detailRequests: details.length, detailRequestsPerMin: round(details.length / minutes), detailBodyBytes: bodyBytes(details),
            sseBodyBytes: sseBytes, allBodyBytes: allBytes, requests: inWindow.length,
            serverCpuMs: Math.round(1000 * (ticks(pid) - cpu0) / hz),
            rendererTaskMs: Math.round(1000 * ((await taskMs().catch(() => task0)) - task0)),
            reactCommits: commits.length, reactCommitMsTotal: round(commits.reduce((sum, ms) => sum + ms, 0)),
            reactCommitP50Ms: round(quantile(commits, 0.5)), reactCommitP95Ms: round(quantile(commits, 0.95)),
            ...extra,
          }
        }

        await measure('cold', async () => {
          const since = performance.now()
          await request('Page.navigate', { url: `${fixture.origin}${path}` }, sessionId)
          await pause(8_000)
          await settled(since)
          return { main: await evaluate('!!document.querySelector("[data-slot=main]")') }
        })
        await measure('update', async () => {
          let target = otherRoots[0]!
          if (view === 'all-tasks') {
            // Read the cold phase's existing index response, without another request or a scroll.
            const coldIndex = [...requests.values()].filter(row => row.url.includes('/workspace/runs-index') && row.completedAt !== undefined).sort((a, b) => a.completedAt! - b.completedAt!).at(-1)
            if (!coldIndex) throw new Error('Index update workload has no cold index response')
            const response = await request('Network.getResponseBody', { requestId: coldIndex.requestId }, coldIndex.sessionId)
            const index = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body) as { runs: Array<{ id: string; projectId: string }> }
            // Fixture other-project roots share status and pin state, so index order is display order.
            const first = index.runs.find(row => row.projectId === 'other' && otherRoots.some(root => root.runId === row.id))
            if (!first || !await evaluate(`!!document.querySelector('[data-route="global-tasks"] [data-project="other"][data-run-id="${first.id}"]')`)) {
              throw new Error('Index update workload needs the first other-project root in display order to be mounted')
            }
            target = { projectId: first.projectId, runId: first.id }
          }
          const title = `Renamed ${Date.now()}`
          const at = performance.now()
          await fixture.control({ update: [{ projectId: target.projectId, runId: target.runId, patch: { title } }] })
          let shownMs: number | null = null
          const windowMs = Math.max(3_000, options.updateWindowMs ?? 3_000)
          while (performance.now() - at < 3_000 || (shownMs === null && performance.now() - at < windowMs)) {
            if (shownMs === null && await evaluate(`document.body.innerText.includes(${JSON.stringify(title)})`)) shownMs = Math.round(performance.now() - at)
            await pause(50)
          }
          // Only the global Tasks page lists another project's rows by title.
          return { titleShownMs: shownMs }
        })
        await measure('sustained', async () => {
          const tickRuns = [family.parent, ...family.workers].map(runId => ({ projectId: 'boot', runId })).concat(otherRoots.slice(1, 4))
          const ticks0 = (await fixture.control({ tick: { rate: 5, runs: tickRuns } })).ticks
          const probes: number[] = []
          if (profileOut) { await request('Profiler.enable', {}, sessionId); await request('Profiler.start', {}, sessionId) }
          const start = performance.now()
          while (performance.now() - start < sustainedMs) {
            const probe = await evaluate(`(async()=>{const at=performance.now();try{const r=await fetch('/api/v1/projects',{signal:AbortSignal.timeout(2000)});await r.text();return r.ok?performance.now()-at:2000}catch{return 2000}})()`) as number
            probes.push(probe)
            await pause(Math.max(0, 1_000 - probe))
          }
          if (profileOut) writeFileSync(`${profileOut}.${view}.cpuprofile`, JSON.stringify((await request('Profiler.stop', {}, sessionId)).profile))
          const ticked = (await fixture.control({ tick: { rate: 0 } })).ticks - ticks0
          return { ticks: ticked, probeP50Ms: round(quantile(probes, 0.5)), probeP95Ms: round(quantile(probes, 0.95)), probes: probes.length }
        })
        await measure('reconnect', async () => {
          const since = performance.now()
          await fixture.control({ disconnect: true })
          await pause(8_000)
          await settled(since)
          return { main: await evaluate('!!document.querySelector("[data-slot=main]")') }
        })
        const loadAfter = loadavg()
        options.report.cases.push({ workload: 'index', view, cpu: options.cpu ?? null, loadavgBefore: loadBefore, loadavgAfter: loadAfter, phases })
        options.save()
        console.log(JSON.stringify({ workload: 'index', view, sustained: phases.sustained }))
        off()
        await request('Target.closeTarget', { targetId })
      })
    } finally { browser.close(); await fixture.stop() }
  }
}
