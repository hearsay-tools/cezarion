import { createReportFixture } from './reports-fixture.mjs'
import { reportIo } from './report-fixture-preload.mjs'
/** Test-only process. Serves the production app; a separate loopback control listener drives
 * deterministic RunStore input and observes publisher demand without adding product routes. */
import { createServer, request } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

// serverPackage: a cezar package directory holding dist/ and web/dist/ (the e2e mirror for the
// specs, packages/cezar for the production-build benchmark).
// `--index` seeds the runs-index workload (hearsay-tools/cezarion#2729) instead of the task-list runs.
const args = process.argv.slice(2)
const indexSeed = args.includes('--index')
const [root, serverPackage = resolve('.ai/qa/build/cezar'), authMode, taskList, sizesJson] = args.filter(arg => !arg.startsWith('--'))
const sizes = sizesJson ? JSON.parse(sizesJson) : undefined
const load = file => import(pathToFileURL(resolve(serverPackage, 'dist', file)).href)
const { publishArtifact, artifactDirectory } = await load('artifacts/store.js')
const { RunStore } = await load('runs/store.js')
const { projectPaths } = await load('project-paths.js')
const { UiEventSink } = await load('runs/ui-event-sink.js')
const { RunManager } = await load('workflows/run.js')
const { acquireCiResources } = await load('ci-wait/resources.js')
const { startServer } = await load('server/server.js')
const { ProjectContexts } = await load('server/project-context.js')
const { resolveHome } = await load('home/resolve.js')
const home = resolveHome({ purpose: 'cli' })
const other = join(root, 'other')
mkdirSync(other, { recursive: true })
const projectDefinitions = taskList === 'project' ? [{ id: 'boot', root, name: 'Boot' }] : taskList === 'global'
  ? Array.from({ length: sizes?.projects ?? 10 }, (_, i) => ({ id: i === 0 ? 'boot' : `project-${i}`, root: i === 0 ? root : join(root, `project-${i}`), name: `Project ${i}` }))
  : [{ id: 'boot', root, name: 'Boot' }, { id: 'other', root: other, name: 'Other' }]
for (const project of projectDefinitions) mkdirSync(project.root, { recursive: true })
const projects = projectDefinitions.map(p => ({ ...p, addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), source: 'local', status: 'not-git' }))
mkdirSync(process.env.CEZ_HOME, { recursive: true })
writeFileSync(join(process.env.CEZ_HOME, 'config.json'), JSON.stringify({ projects }))
/** The index workload: 808 index roots in two truncated projects (each window holds 200 archived
 *  roots of 210), plus one running delegation parent in `boot` with four running workers. */
const seedIndex = (store, projectId) => {
  for (let i = 0; i < 210; i++) store.setArchived(store.createRun({ title: `Archived ${projectId} ${i}`, task: 'archived', workflow: 'quick-task', steps: [] }).id, true)
  indexRoots[projectId] = []
  for (let i = 0; i < (projectId === 'boot' ? 203 : 204); i++) {
    const run = store.createRun({ title: `Index ${projectId} ${i}`, task: 'index', workflow: 'quick-task', steps: [] })
    store.updateRun(run.id, { status: 'done' })
    indexRoots[projectId].push(run.id)
  }
  if (projectId !== 'boot') return
  const parent = store.createRun({ title: 'Delegation parent', task: 'parent', workflow: 'quick-task', steps: [] })
  const workers = Array.from({ length: 4 }, (_, i) => {
    const worker = store.createRun({ title: `Worker ${i}`, task: 'worker', workflow: 'quick-task', steps: [] })
    store.updateRun(worker.id, { status: 'running', delegation: { role: 'worker', parentRunId: parent.id, permissions: [],
      workspace: { ownerRunId: worker.id, resourceId: `resource-${i}`, kind: 'owned-isolated', path: `/tmp/worker-${i}`, branch: `cez/worker-${i}`, baselineSha: 'a'.repeat(40) } } })
    return worker
  })
  store.updateRun(parent.id, { status: 'running', delegation: { role: 'root', permissions: [],
    receipts: workers.map((worker, i) => ({ requestId: `request-${i}`, workerId: worker.id, requestHash: 'b'.repeat(64) })) } })
  family = { parent: parent.id, workers: workers.map(worker => worker.id) }
}
let family
/** Each project's unarchived index roots, oldest first: fixed targets for updates and ticks. */
const indexRoots = {}
const seed = (dir, projectId) => {
  // The project's write root: .ai/squawk/ for a fresh project with the release switch on.
  const store = RunStore.open(projectPaths(dir).write)
  if (indexSeed) { seedIndex(store, projectId); store.flush(); return store }
  const active = sizes?.active ?? (taskList === 'project' ? 300 : taskList === 'global' ? 30 : 10)
  const archived = sizes?.archived ?? (taskList === 'project' ? 1000 : taskList === 'global' ? 200 : 0)
  for (let i = 0; i < active + archived; i++) {
    const run = store.createRun({ title: `Tab task ${i}`, task: `Tab task ${i}`, workflow: 'quick-task', steps: [] })
    store.updateRun(run.id, taskList ? { createdAt: new Date(Date.now() - (active + archived - i) * 1000).toISOString(), status: i < active ? 'running' : 'done', archived: i >= active, inputTokens: 12345, outputTokens: 678, costUsd: 0.12, ...(i >= active ? { finishedAt: new Date().toISOString() } : {}) } : { status: 'done' })
    store.appendEvent(run.id, { type: 'item.completed', item: { kind: 'message', id: 'initial', role: 'assistant', text: `Tab fixture transcript ${run.id}` } })
  }
  return store
}
const store = seed(root, 'boot')
for (const project of projects.slice(1)) { const extra = seed(project.root, project.id); extra.close() }
const manager = new RunManager(store, root, { home, acquireCiResources })
const contexts = new ProjectContexts({ home, createManager: (store, root, options) => new RunManager(store, root, { ...options, acquireCiResources }), listProjects: async () => projects })
const stores = new Map([['boot', store]])
for (const project of projects.slice(1)) stores.set(project.id, (await contexts.context(project.id)).store)
const runs = [...stores].flatMap(([projectId, value]) => value.listRunIds().map(runId => ({ projectId, runId })))
let timer, published = 0, proxy, ticker, ticks = 0
const reports = createReportFixture({ stores, projects, root, publishArtifact, artifactDirectory, dataDir: dir => projectPaths(dir).write })
/** Index workload: one-off row updates, and token ticks at `rate` per second round-robin. */
const indexCommand = command => {
  for (const update of command.update ?? []) stores.get(update.projectId)?.updateRun(update.runId, update.patch)
  if (command.tick === undefined) return
  clearInterval(ticker)
  const targets = command.tick.runs ?? []
  if (command.tick.rate > 0 && targets.length) ticker = setInterval(() => {
    const run = targets[ticks % targets.length]
    ticks += 1
    stores.get(run.projectId)?.updateRun(run.runId, { tokensUsed: ticks, currentStepId: `tick-${ticks % 3}` })
  }, 1000 / command.tick.rate)
}
// Fixture-only insertion seam: deterministic seed times permit a middle insert as well as a prepend.
function insertTask(command) {
  if (!command) return
  const { projectId = 'boot', title, beforeTitle } = command
  const target = stores.get(projectId)
  const before = beforeTitle && target.listRunIds().map(id => target.getRun(id)).find(run => run.title === beforeTitle)
  const run = target.createRun({ title, task: title, workflow: 'quick-task', steps: [] })
  target.updateRun(run.id, { status: 'running', ...(before ? { createdAt: new Date(Date.parse(before.createdAt) + 500).toISOString() } : {}) })
}
function startStreams(command) {
  if (command.streaming) {
    const selected = command.runs ?? runs
    for (const run of selected) stores.get(run.projectId)?.updateRun(run.runId, { status: 'running' })
    timer = setInterval(() => {
      for (const run of selected) stores.get(run.projectId)?.appendEvent(run.runId, { type: 'item.completed', item: { kind: 'message', id: `stream-${++published}`, role: 'assistant', text: `stream-${published}` } })
    }, 50)
  }
  if (command.summaryStreaming) {
    const selected = [...stores].flatMap(([projectId, target]) => target.listRunIds().slice(0, 30).map(runId => ({ projectId, runId })))
    if (selected.length) timer = setInterval(() => {
      const run = selected[published++ % selected.length]
      stores.get(run.projectId).updateRun(run.runId, { costUsd: published / 1000 })
    }, 50)
  }
}
const control = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) { body += part; if (body.length > 16_384) { res.writeHead(413).end(); return } }
  if (req.method === 'POST') {
    const command = JSON.parse(body || '{}')
    clearInterval(timer)
    await reports.handle(command)
    insertTask(command.insertTask)
    startStreams(command)
    if (command.ephemeral) for (const run of command.runs ?? runs) {
      const target = stores.get(run.projectId)
      target.updateRun(run.runId, { status: 'running' })
      const sink = new UiEventSink({ persist: event => target.appendEvent(run.runId, event), emitLive: event => target.emitEphemeral(run.runId, event) })
      const item = { kind: 'message', id: `ephemeral-${++published}`, role: 'assistant', text: '' }
      sink.handle({ type: 'item.started', item })
      if (command.snapshot) sink.handle({ type: 'item.updated', item: { ...item, text: command.ephemeral } })
      else sink.handle({ type: 'item.delta', itemId: item.id, field: 'text', delta: command.ephemeral })
      sink.flushAll() // Keep the item unfinished: disk replay has no generated text.
    }
    if (command.disconnect) server.closeAllConnections()
    indexCommand(command)
    if (command.publish) for (const run of command.runs ?? runs) stores.get(run.projectId)?.appendEvent(run.runId, { type: 'item.completed', item: { kind: 'message', id: `publish-${++published}`, role: 'assistant', text: command.publish } })
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ runs, published, ticks, family, indexRoots, ...reports.state(), reportIo, listeners: [...stores].map(([projectId, value]) => ({ projectId, event: value.listenerCount('event'), run: value.listenerCount('run'), deleted: value.listenerCount('deleted') })) }))
})
control.listen(0, '127.0.0.1', () => console.log(`control → http://127.0.0.1:${control.address().port}`))
const server = startServer({ home, repoRoot: root, store, manager, contexts, version: 'tab-fixture', bootProjectId: 'boot' }, 0)
server.once('listening', () => {
  if (authMode !== 'basic-auth') { console.log(`cockpit → http://127.0.0.1:${server.address().port}`); return }
  // Synthetic fixture credentials only; exercise authenticated finite reads through a proxy.
  proxy = createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('fixture:fixture').toString('base64')}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="tab fixture"' }).end(); return
    }
    const upstream = request({ hostname: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  proxy.listen(0, '127.0.0.1', () => console.log(`cockpit → http://127.0.0.1:${proxy.address().port}`))
})
process.once('SIGTERM', async () => {
  clearInterval(timer); clearInterval(ticker)
  reports.stop()
  proxy?.closeAllConnections(); proxy?.close()
  server.closeAllConnections(); server.close(); control.closeAllConnections(); control.close()
  manager.dispose(); contexts.disposeAll(); store.close()
  process.exit(0)
})
