// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { spawnFixtureServer, stopFixtureServer } from '../../e2e/fixture-server'

const children: ChildProcess[] = []
const grandchildren: number[] = []

/** True while `pid` runs; a zombie waiting for its reaper has stopped (Linux reads its state). */
function running(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) [ZX]/s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) }
  catch { return process.platform !== 'linux' }
}

/**
 * A fixture server that starts one child of its own, as the cockpit starts git, and prints the
 * child's pid once the child is ready. `grandchild` is the child's script. The server exits on
 * SIGTERM, a handler it installs before it prints, or right after it prints when `exitAfterReady`.
 */
async function serverWithChild(grandchild: string, { exitAfterReady = false } = {}): Promise<{ child: ChildProcess; grandchild: number }> {
  const child = spawnFixtureServer(['-e', `
    const { spawn } = require('node:child_process')
    process.on('SIGTERM', () => process.exit(0))
    const kid = spawn(process.execPath, ['-e', ${JSON.stringify(`${grandchild}; setInterval(() => {}, 1_000); console.log('ready')`)}], { stdio: ['ignore', 'pipe', 'ignore'] })
    kid.stdout.once('data', () => { console.log('grandchild ' + kid.pid); ${exitAfterReady ? 'process.exit(0)' : ''} })
    setInterval(() => {}, 1_000)
  `], {})
  children.push(child)
  let out = ''
  const pid = await new Promise<number>((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      out += String(chunk)
      const match = /grandchild (\d+)/.exec(out)
      if (match) resolve(Number(match[1]))
    })
    child.once('exit', (code, signal) => { if (!/grandchild \d+/.test(out)) reject(new Error(`server exited early: ${code ?? signal}`)) })
  })
  grandchildren.push(pid)
  return { child, grandchild: pid }
}

async function childWithShutdown(handler: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', ${handler}); setInterval(() => {}, 1_000); console.log('ready')`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  children.push(child)
  await once(child.stdout!, 'data')
  return child
}

afterEach(async () => {
  for (const pid of grandchildren.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
})

describe('stopFixtureServer', () => {
  it('waits for a graceful shutdown to finish before resolving', async () => {
    const child = await childWithShutdown("() => setTimeout(() => process.exit(0), 75)")

    // The default grace: at load ~70 a 1 s grace let SIGKILL reach the server before its own exit.
    await stopFixtureServer(child)

    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null })
    expect(child.signalCode).toBeNull()
  })

  it('escalates to SIGKILL when graceful shutdown does not exit', async () => {
    const child = await childWithShutdown('() => {}')

    // bound: the grace is also the wait for `exit` after SIGKILL. 50 ms failed 2 of 27 Squeal runs
    // at load 2.4 per CPU (revisions 7 and 10, hearsay-tools/cezarion#1765); 500 ms keeps it short.
    await stopFixtureServer(child, 500)

    expect(child.signalCode).toBe('SIGKILL')
  })

  it('returns immediately for a process that already exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    children.push(child)
    await once(child, 'exit')

    await expect(stopFixtureServer(child, 50)).resolves.toBeUndefined()
  })

  // hearsay-tools/cezarion#1764: the server's git children outlived its exit, and one wrote
  // into the fixture root while the spec's teardown removed it.
  it("waits for the server's own children, not only the server", async () => {
    const { child, grandchild } = await serverWithChild('')

    // The default grace: at load ~70 a 1 s grace let SIGKILL reach the server before its own exit.
    await stopFixtureServer(child)

    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null })
    expect(running(grandchild)).toBe(false)
  })

  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    const { child, grandchild } = await serverWithChild("process.on('SIGTERM', () => {})")

    await stopFixtureServer(child, 100)

    expect(running(grandchild)).toBe(false)
  })

  it('stops the children of a server that already exited', async () => {
    const { child, grandchild } = await serverWithChild('', { exitAfterReady: true })
    if (child.exitCode === null) await once(child, 'exit')

    await stopFixtureServer(child)

    expect(running(grandchild)).toBe(false)
  })

  it('kills its server groups when the test process ends by a signal', async () => {
    // A detached server no longer receives the terminal's Ctrl-C with the test run.
    const helper = fileURLToPath(new URL('../../e2e/fixture-server.ts', import.meta.url))
    const runner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { spawnFixtureServer } = await import(${JSON.stringify(helper)})
      const server = spawnFixtureServer(['-e', "const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)']); console.log('kid ' + kid.pid); setInterval(() => {}, 1_000)"], {})
      server.stdout.once('data', (line) => console.log('server ' + server.pid + ' ' + line.trim()))
      setInterval(() => {}, 1_000)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(runner)
    let out = ''
    const pids = await new Promise<number[]>((resolve, reject) => {
      runner.stdout!.on('data', (chunk) => {
        out += String(chunk)
        const match = /server (\d+) kid (\d+)/.exec(out)
        if (match) resolve([Number(match[1]), Number(match[2])])
      })
      runner.once('exit', (code, signal) => reject(new Error(`runner exited early: ${code ?? signal} ${out}`)))
    })
    grandchildren.push(...pids)

    runner.kill('SIGTERM')
    await once(runner, 'exit')

    expect(runner.signalCode).toBe('SIGTERM')
    // bound: SIGKILL was sent before the runner exited; the kernel ends the targets right after.
    await expect.poll(() => pids.filter(running), { timeout: 10_000 }).toEqual([])
  })
})
