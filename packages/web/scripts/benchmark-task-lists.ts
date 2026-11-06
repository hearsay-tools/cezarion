/** Production task-list workload for hearsay-tools/cezarion#2732.
 * node --import tsx packages/web/scripts/benchmark-task-lists.ts --build-root DIR --build --output FILE
 * --quick runs one repetition and one viewport for harness diagnostics only.
 * The profiling alias and DevTools hook exist only in this harness.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { loadavg, cpus } from 'node:os'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { build, loadConfigFromFile, mergeConfig } from 'vite'
import { AgentBrowser } from '../e2e/agent-browser.ts'
import { createTabFixture } from '../e2e/tab-fixture.ts'
import { pollFor } from '../e2e/poll.ts'
import { captureFixtureServer } from '../e2e/fixture-server.ts'

export type TaskListBenchmarkOptions = {
  buildRoot?: string | undefined
  build?: boolean
  output?: string
  quick?: boolean
  prepareOnly?: boolean | undefined
  /** Tiny correctness workload for CI, not performance evidence. */
  smoke?: boolean
}

export async function runTaskListsBenchmark(values: TaskListBenchmarkOptions = {}) {
  const root = resolve(values.buildRoot ?? '.')
  const output = resolve(values.output ?? '.ai/qa/task-lists.json')
  if (values.build) {
    const config = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve(root, 'packages/web/vite.config.ts'))
    if (!config) throw new Error('Missing Vite config')
    const require = createRequire(resolve(root, 'packages/web/package.json'))
    await build(mergeConfig(config.config, { configFile: false, resolve: { alias: [{ find: /^react-dom\/client$/, replacement: require.resolve('react-dom/profiling') }] } }))
  }
  if (values.prepareOnly) return
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) // fixed measurement window
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null
  function hostMemory() {
    return Object.fromEntries([...readFileSync('/proc/meminfo', 'utf8').matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB/gm)].map(([, key, value]) => [key, Number(value) * 1024]))
  }
  function startMemoryProbe(serverPid: number, browserPids: Set<number>) {
    const before = hostMemory()
    let fixturePeakRssBytes = 0, chromePeakRssBytes = 0
    const rss = (pid: number) => { try { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024 } catch { return 0 } }
    const sample = () => {
      fixturePeakRssBytes = Math.max(fixturePeakRssBytes, rss(serverPid))
      chromePeakRssBytes = Math.max(chromePeakRssBytes, [...browserPids].reduce((sum, pid) => sum + rss(pid), 0))
    }
    sample()
    const timer = setInterval(sample, 250)
    return () => { clearInterval(timer); sample(); return { hostBefore: before, hostAfter: hostMemory(), fixturePeakRssBytes, chromePeakRssBytes } }
  }
  const builtContent = createHash('sha256')
  function fingerprint(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = resolve(path, entry.name)
      if (entry.isDirectory()) fingerprint(child)
      else if (entry.isFile()) builtContent.update(entry.name).update(readFileSync(child))
    }
  }
  const serverPackage = values.smoke ? '.ai/qa/build/cezar' : 'packages/cezar'
  fingerprint(resolve(root, serverPackage, 'dist'))
  fingerprint(resolve(root, serverPackage, 'web/dist'))
  const report: any = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), productionProfilingBuild: !values.smoke, workloadSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), builtContentSha256: builtContent.digest('hex'), sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), quick: !!values.quick, host: { cpu: cpus()[0]?.model, affinity: readFileSync('/proc/self/status', 'utf8').match(/Cpus_allowed_list:\s*(.*)/)?.[1] }, cases: [] }
  mkdirSync(dirname(output), { recursive: true })
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2))
  // React's profiling build records actualDuration when a DevTools consumer is installed before boot.
  const probe = `(() => {
    const state = window.__taskListProbe = {commits:[], longTasks:[], events:[], frames:[], root:null};
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {supportsFiber:true, inject:()=>1, onCommitFiberUnmount(){}, onPostCommitFiberRoot(){}, onCommitFiberRoot(id,root){state.root=root;state.commits.push(root.current.actualDuration)}};
    for (const [type,key] of [['longtask','longTasks'],['event','events']]) {
      try { new PerformanceObserver(list=>state[key].push(...list.getEntries().map(e=>({name:e.name,ms:e.duration})))).observe({type,buffered:true,durationThreshold:16}) } catch {}
    }
  })();`
  function casesFor(scope: 'project' | 'global') {
    const repetitions = Array.from({ length: values.quick || values.smoke ? 1 : 5 }, (_, i) => i)
    const viewports = values.quick ? [[1440, 900]] : [[1440, 900], [360, 640]]
    const settings = scope === 'project' ? ['summary', 'detailed'] : ['summary', 'grouped']
    return repetitions.flatMap(repetition => viewports.flatMap(([width, height]) => settings.flatMap(setting =>
      ['active', 'archived'].map(view => ({ repetition, width: width!, height: height!, setting, view })),
    )))
  }
  for (const scope of ['project', 'global'] as const) {
    const fixture = await createTabFixture(root, { serverPackage, taskList: scope, ...(values.smoke ? { taskListSizes: { active: 3, archived: 5, projects: 2 } } : {}) })
    const serverState = captureFixtureServer(fixture.server)
    fixture.server.once('exit', () => {
      report.fixtureExits ??= []
      report.fixtureExits.push({ scope, ...serverState() })
      save()
    })
    let stopMemory: ReturnType<typeof startMemoryProbe> | undefined
    let browser: AgentBrowser | undefined
    try {
      browser = AgentBrowser.open(`task-lists-${process.pid}-${scope}`)
      browser.goto('about:blank')
      await browser.withCdp(async request => {
        const { targetId } = await request('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
        const page = (method: string, params = {}) => request(method, params, sessionId)
        const evaluate = async (expression: string) => {
          const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
          return result.result.value
        }
        const until = async (expression: string) => pollFor(async () => await evaluate(`Boolean(${expression})`) || undefined, () => `Not ready: ${expression}`, { timeoutMs: 60_000, intervalMs: 100, tries: 600 })
        const click = async (expression: string) => {
          const point = await evaluate(`(()=>{const e=${expression};if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
          if (!point) throw new Error(`Missing control: ${expression}`)
          report.lastClick = { expected: expression, point }
          await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
          await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
        }
        const button = (text: string) => text === 'Archived'
          ? `document.querySelector('[data-route] button[data-view=archived]')`
          : `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`
        await page('Page.enable')
        await page('Page.addScriptToEvaluateOnNewDocument', { source: probe })
        await request('Target.activateTarget', { targetId })
        const loadAllArchived = async () => {
          await click(button('Archived'))
          await until(`(${button('Archived')})?.getAttribute('aria-pressed')==='true'`)
          if (scope !== 'project') return
          await until(`!!(${button('Show older archived')}) || document.querySelector('[data-slot="tasks-result-count"]')?.textContent.includes('${values.smoke ? 5 : 1000}')`)
          while (await evaluate(`!!(${button('Show older archived')})`)) {
            const prior = await evaluate(`document.querySelector('[data-slot="tasks-result-count"]').textContent`)
            await click(button('Show older archived'))
            await until(`document.querySelector('[data-slot="tasks-result-count"]').textContent!==${JSON.stringify(prior)} && ![...document.querySelectorAll('button')].some(e=>e.textContent.includes('Loading older archived'))`)
          }
          await until(`document.querySelector('[data-slot="tasks-result-count"]')?.textContent.includes('${values.smoke ? 5 : 1000}')`)
        }
        const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const interact = async (name: string, selector: string) => {
          const at = performance.now(); await click(selector); await frame()
          return { name, elapsedMs: performance.now() - at }
        }
        for (const testCase of casesFor(scope)) {
          const { repetition, width, height, setting, view } = testCase
          report.pendingCase = { scope, ...testCase }; save()
          console.log(`start ${scope} ${setting} ${view} ${repetition} ${width}x${height}`)
          const before = loadavg()
          const browserPids = new Set<number>((await request('SystemInfo.getProcessInfo')).processInfo.map((process: { id: number }) => process.id))
          stopMemory = startMemoryProbe(fixture.server.pid!, browserPids)
          await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
          await page('Page.navigate', { url: `${fixture.origin}${scope === 'project' ? '/p/boot/' : '/tasks'}${setting === 'grouped' ? '?group=project' : ''}` })
          await until(`document.querySelector('[data-slot="${scope === 'project' ? 'task-summary-row' : 'global-task-row'}"]')`)
          await until(`window.__cezIdle === true && document.fonts.status === 'loaded'`)
          await evaluate('window.__taskListProbe.commits=[];window.__taskListProbe.longTasks=[];window.__taskListProbe.events=[]')
          const settingAt = performance.now()
          if (setting === 'detailed') {
            await click(button('Columns')); await click(button('Resource columns'))
            await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 })
            await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 })
            await until(`!document.querySelector('[data-slot="popover-content"]') && document.activeElement?.matches('[data-slot="task-columns-trigger"]')`)
          }
          await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          await frame()
          await until('window.__taskListProbe.root')
          for (const process of (await request('SystemInfo.getProcessInfo')).processInfo) browserPids.add(process.id)
          await evaluate('window.__taskListProbe.commits=[]')
          const interactions: any[] = setting === 'detailed' ? [{ name: 'Resource columns setting', elapsedMs: performance.now() - settingAt }] : []
          if (view === 'archived') { const at = performance.now(); await loadAllArchived(); interactions.push({ name: 'Archived tab and paging', elapsedMs: performance.now() - at }) }
          const streamAt = performance.now()
          const startPublished = (await fixture.control({ summaryStreaming: true })).published
          await pause(values.smoke ? 20 : values.quick ? 500 : 3_000)
          const updatesPublished = (await fixture.control({ summaryStreaming: false })).published - startPublished
          const streamMs = performance.now() - streamAt
          const sample = await evaluate(`(()=>{
            const s=window.__taskListProbe;let fibers=0;const visit=n=>{if(!n)return;fibers++;visit(n.child);visit(n.sibling)};visit(s.root.current);
            const route=document.querySelector('[data-route="${scope === 'project' ? 'tasks' : 'global-tasks'}"]');
            return {mountedRows:route.querySelectorAll('[data-slot=task-summary-row],[data-slot=task-table-row],[data-slot=task-card],[data-slot=global-task-row]').length,rowsWithRunId:route.querySelectorAll('[data-run-id]').length,allMountedRows:document.querySelectorAll('[data-run-id]').length,domNodes:document.querySelectorAll('*').length,fibers,commits:s.commits,longTasks:s.longTasks,eventTiming:s.events,representation:route.querySelector('[data-slot="task-cards"]')?.getClientRects().length?'cards':route.dataset.presentation};
          })()`)
          const api: number[] = []
          for (let i = 0; i < 10; i++) { const at = performance.now(); const response = await fetch(`${fixture.origin}/api/v1/projects`); await response.arrayBuffer(); if (!response.ok) throw new Error(`API ${response.status}`); api.push(performance.now() - at) }
          const frames = await evaluate(`new Promise(resolve=>{const owner=document.querySelector('[data-slot="main"]');if(!owner){resolve([]);return}const times=[];let previous=performance.now(),n=0;function frame(now){times.push(now-previous);previous=now;owner.scrollTop+=64;if(++n<${values.smoke ? 2 : 60})requestAnimationFrame(frame);else resolve(times)}requestAnimationFrame(frame)})`)
          const expand = `document.querySelector('[data-route="${scope === 'project' ? 'tasks' : 'global-tasks'}"] button[aria-label^="Show resources"]')`
          if (await evaluate(`!!(${expand})`)) interactions.push(await interact('Expand', expand))
          const search = `document.querySelector('input[aria-label="Search tasks"],input[placeholder*="Search"]')`
          if (await evaluate(`!!(${search})`)) {
            const at = performance.now(); await click(search); await page('Input.insertText', { text: 'Tab task' }); await frame()
            interactions.push({ name: 'Search typing', elapsedMs: performance.now() - at })
          }
          Object.assign(sample, await evaluate('({longTasks:window.__taskListProbe.longTasks,eventTiming:window.__taskListProbe.events})'))
          const memory = stopMemory(); stopMemory = undefined
          report.cases.push({ memory, scope, ...testCase, loadBefore: before, loadAfter: loadavg(), updatesPublished, streamMs, ...sample, interactions, commitP50: percentile(sample.commits, .5), commitP95: percentile(sample.commits, .95), apiP50: percentile(api, .5), apiP95: percentile(api, .95), scrollFrameP50: percentile(frames.slice(1), .5), scrollFrameP95: percentile(frames.slice(1), .95), frames })
          save()
          console.log(`${scope} ${setting} ${view} ${repetition}: ${sample.mountedRows} rows, ${sample.fibers} fibers`)
        }
        await request('Target.closeTarget', { targetId })
      }, { requestTimeoutMs: 60_000 })
    } catch (error) {
      report.failure = { error: String(error), memory: stopMemory?.(), server: serverState() }; stopMemory = undefined; save()
      throw error
    } finally { stopMemory?.(); browser?.close(); await fixture.stop() }
  }
  report.pendingCase = null
  save()

  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
const { values } = parseArgs({ options: { 'build-root': { type: 'string' }, build: { type: 'boolean' }, output: { type: 'string' }, quick: { type: 'boolean' }, 'prepare-only': { type: 'boolean' } } })
  await runTaskListsBenchmark({ ...values, buildRoot: values['build-root'], prepareOnly: values['prepare-only'] })
}
