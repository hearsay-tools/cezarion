// @vitest-environment node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { expect, it } from 'vitest'
import { captureFixtureServer } from '../../e2e/fixture-server'

it('retains real child lifecycle and bounded stdout/stderr after startup exits', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('booting\\n' + 'x'.repeat(128)); process.stderr.write('EADDRINUSE: 127.0.0.1:35801\\n'); process.exitCode = 7"], { stdio: ['ignore', 'pipe', 'pipe'] })
  const sample = captureFixtureServer(child, 64)
  await once(child, 'close')
  const state = sample()
  expect(state).toMatchObject({ pid: child.pid, exitCode: 7, signalCode: null, stdout: 'x'.repeat(64), stderr: 'EADDRINUSE: 127.0.0.1:35801\n' })
  expect(state.stdoutDropped).toBe(72)
  expect(state.lifecycle.map(event => event.kind)).toEqual(['spawn', 'exit', 'close'])
  expect(state.elapsedMs).toBeGreaterThanOrEqual(0)
})

it('captures an actual spawn error without an unhandled child error', async () => {
  const child = spawn('/cezar-e2e-missing-fixture-executable', [], { stdio: ['ignore', 'pipe', 'pipe'] })
  const sample = captureFixtureServer(child)
  // once(close) would reject on error; the diagnostic observer must retain that error.
  await new Promise<void>(resolve => child.once('close', () => resolve()))
  const state = sample()
  expect(state.lifecycle.map(event => event.kind)).toEqual(['error', 'close'])
  expect(JSON.stringify(state)).toContain('ENOENT')
  expect(state.spawnfile).toBe('/cezar-e2e-missing-fixture-executable')
})


it('retains the actual address and port when a fixture child cannot bind', async () => {
  const holder = createServer()
  holder.listen(0, '127.0.0.1')
  await once(holder, 'listening')
  try {
    const address = holder.address()
    if (!address || typeof address === 'string') throw new Error('holder has no port')
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${address.port}, '127.0.0.1')`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const sample = captureFixtureServer(child)
    await once(child, 'close')
    expect(sample().exitCode).toBe(1)
    expect(sample().stderr).toContain('EADDRINUSE')
    expect(sample().stderr).toContain('127.0.0.1')
    expect(sample().stderr).toContain(String(address.port))
  } finally {
    await new Promise<void>(resolve => holder.close(() => resolve()))
  }
})
