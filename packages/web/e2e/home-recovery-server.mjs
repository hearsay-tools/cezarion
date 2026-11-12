import { once } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Use the normal built service and assets. Only this fixture opts into the dark canary.
const [dist, root, homeRoot] = process.argv.slice(2)
const load = (path) => import(pathToFileURL(join(dist, path)).href)
const { Home } = await load('home/home.js')
const { RunStore } = await load('runs/store.js')
const { RunManager } = await load('workflows/run.js')
const { startServer } = await load('server/server.js')
const home = Home.sandbox(homeRoot, { layout: 'split' })
const store = RunStore.open(join(root, '.ai/cezar'))
const manager = new RunManager(store, root, { home })
const server = startServer({ home, repoRoot: root, store, manager, createManager: (...args) => new RunManager(...args), version: '0.0.0-test', legacyCanary: true }, 0)
if (!server.listening) await once(server, 'listening')
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port')
console.log(`cockpit → http://127.0.0.1:${address.port}`)

process.once('SIGTERM', async () => {
  await server.shutdownForRestart()
  manager.dispose()
  store.close()
  process.exit(0)
})
