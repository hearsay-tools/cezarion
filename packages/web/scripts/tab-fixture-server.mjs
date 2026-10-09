/** Test-only process. Serves the production app; a separate loopback control listener drives
 * deterministic RunStore input and observes publisher demand without adding product routes. */
import { createServer, request } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

const [root, buildRoot = process.cwd(), authMode] = process.argv.slice(2)
const load = file => import(pathToFileURL(resolve(buildRoot, 'packages/cezar/dist', file)).href)
const { RunStore } = await load('runs/store.js')
const { UiEventSink } = await load('runs/ui-event-sink.js')
const { RunManager } = await load('workflows/run.js')
const { startServer } = await load('server/server.js')
const { ProjectContexts } = await load('server/project-context.js')
const other = join(root, 'other')
mkdirSync(other, { recursive: true })
const projects = [{ id: 'boot', root, name: 'Boot' }, { id: 'other', root: other, name: 'Other' }].map(p => ({ ...p, addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), source: 'local', status: 'not-git' }))
mkdirSync(process.env.CEZ_HOME, { recursive: true })
writeFileSync(join(process.env.CEZ_HOME, 'config.json'), JSON.stringify({ projects }))
const seed = dir => {
  const store = RunStore.open(join(dir, '.ai/cezar'))
  for (let i = 0; i < 10; i++) {
    const run = store.createRun({ title: `Tab task ${i}`, task: `Tab task ${i}`, workflow: 'quick-task', steps: [] })
    store.updateRun(run.id, { status: 'done' })
    store.appendEvent(run.id, { type: 'item.completed', item: { kind: 'message', id: 'initial', role: 'assistant', text: `Tab fixture transcript ${run.id}` } })
  }
  return store
}
const store = seed(root)
const otherSeed = seed(other); otherSeed.close()
const manager = new RunManager(store, root)
const contexts = new ProjectContexts({ listProjects: async () => projects })
const otherContext = await contexts.context('other')
const stores = new Map([['boot', store], ['other', otherContext.store]])
const runs = [...stores].flatMap(([projectId, value]) => value.listRunIds().map(runId => ({ projectId, runId })))
let timer, published = 0, proxy
const control = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) { body += part; if (body.length > 16_384) { res.writeHead(413).end(); return } }
  if (req.method === 'POST') {
    const command = JSON.parse(body || '{}')
    clearInterval(timer)
    if (command.streaming) {
      const selected = command.runs ?? runs
      for (const run of selected) stores.get(run.projectId)?.updateRun(run.runId, { status: 'running' })
      timer = setInterval(() => {
        for (const run of selected) stores.get(run.projectId)?.appendEvent(run.runId, { type: 'item.completed', item: { kind: 'message', id: `stream-${++published}`, role: 'assistant', text: `stream-${published}` } })
      }, 50)
    }
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
    if (command.publish) for (const run of command.runs ?? runs) stores.get(run.projectId)?.appendEvent(run.runId, { type: 'item.completed', item: { kind: 'message', id: `publish-${++published}`, role: 'assistant', text: command.publish } })
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ runs, published, listeners: [...stores].map(([projectId, value]) => ({ projectId, event: value.listenerCount('event'), run: value.listenerCount('run'), deleted: value.listenerCount('deleted') })) }))
})
control.listen(0, '127.0.0.1', () => console.log(`control → http://127.0.0.1:${control.address().port}`))
const server = startServer({ repoRoot: root, store, manager, contexts, version: 'tab-fixture', bootProjectId: 'boot' }, 0)
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
  clearInterval(timer)
  proxy?.closeAllConnections(); proxy?.close()
  server.closeAllConnections(); server.close(); control.closeAllConnections(); control.close()
  manager.dispose(); contexts.disposeAll(); store.close()
  process.exit(0)
})
