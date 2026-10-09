import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'

/** Production CLI over a private workspace; pages share a browser, never host state. */
export async function createTabFixture(buildRoot = process.cwd(), options: { remote?: boolean; basicAuth?: boolean } = {}) {
  const root = mkdtempSync('/tmp/cez-tabs-')
  const env = fixtureServeEnv(root, { CEZ_REMOTE: options.remote ? '1' : '0' })
  for (const key of ['CEZ_TASK_ID', 'CEZ_HANDOFF_FILE', 'CEZ_ARTIFACTS_DIR']) delete env[key]
  const server = spawnFixtureServer([resolve('packages/web/scripts/tab-fixture-server.mjs'), root, buildRoot, ...(options.basicAuth ? ['basic-auth'] : [])], { env }, { timeoutMs: 60_000 })
  let controlOrigin = ''
  server.stdout?.on('data', chunk => { const match = /control → (http:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk)); if (match) controlOrigin = match[1]! })
  try {
    const origin = await waitForFixtureServer(server, options.basicAuth ? { healthHeaders: { authorization: `Basic ${Buffer.from('fixture:fixture').toString('base64')}` } } : {})
    if (!controlOrigin) throw new Error('fixture control listener missing')
    const control = async (command?: unknown) => {
      const response = await fetch(controlOrigin, command === undefined ? {} : { method: 'POST', body: JSON.stringify(command) })
      return await response.json() as { runs: Array<{ projectId: string; runId: string }>; published: number; listeners: Array<{ projectId: string; event: number; run: number; deleted: number }> }
    }
    const { runs } = await control()
    const runIds = runs.filter(run => run.projectId === 'boot').map(run => run.runId)
    return { origin, runIds, runs, control, server, async stop() { await stopFixtureServer(server); rmSync(root, { recursive: true, force: true }) } }
  } catch (error) {
    await stopFixtureServer(server)
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
