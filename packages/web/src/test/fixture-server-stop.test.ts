// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import { stopFixtureServer } from '../../e2e/fixture-server'

const children: ChildProcess[] = []

async function childWithShutdown(handler: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', ${handler}); setInterval(() => {}, 1_000); console.log('ready')`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  children.push(child)
  await once(child.stdout!, 'data')
  return child
}

afterEach(async () => {
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

    await stopFixtureServer(child, 1_000)

    expect(child.exitCode).toBe(0)
    expect(child.signalCode).toBeNull()
  })

  it('escalates to SIGKILL when graceful shutdown does not exit', async () => {
    const child = await childWithShutdown('() => {}')

    await stopFixtureServer(child, 50)

    expect(child.signalCode).toBe('SIGKILL')
  })

  it('returns immediately for a process that already exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    children.push(child)
    await once(child, 'exit')

    await expect(stopFixtureServer(child, 50)).resolves.toBeUndefined()
  })
})
