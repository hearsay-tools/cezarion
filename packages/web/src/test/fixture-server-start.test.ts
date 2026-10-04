// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureFixtureServer, spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from '../../e2e/fixture-server'

const children: ChildProcess[] = []
const owned = (script: string) => {
  const child = spawnFixtureServer(['-e', script], { env: process.env })
  children.push(child)
  return child
}
const serverScript = ({ announcement = '', status = 200, chunked = false, bodyDelay = 0, headerDelay = 0, stderr = '' } = {}) => `
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(${status}, {'content-type':'application/json'}); res.flushHeaders();
      setTimeout(() => res.end(JSON.stringify({owned:true})), ${bodyDelay});
    }, ${headerDelay});
  });
  server.listen(0, '127.0.0.1', () => {
    const url = ${JSON.stringify(announcement)} || 'http://127.0.0.1:' + server.address().port;
    ${chunked ? "process.stdout.write('  cock'); setTimeout(() => process.stdout.write('pit → ' + url + '\\n'), 5);" : "console.log('  cockpit → ' + url);"}
    ${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
`

afterEach(async () => {
  for (const child of children.splice(0)) await stopFixtureServer(child)
})

describe('owned fixture server readiness (#795)', () => {
  it('routes all spec-owned CLI serve constructions through child-owned readiness', () => {
    const directory = resolve(import.meta.dirname, '../../e2e')
    let constructions = 0
    for (const file of readdirSync(directory).filter(file => file.endsWith('.e2e.ts'))) {
      const source = readFileSync(resolve(directory, file), 'utf8')
      const starts = [...source.matchAll(/\b(spawnFixtureServer|spawn)\(\s*(?:process\.execPath,\s*)?\[([^\]]*'serve'[^\]]*)\]/g)]
      for (const start of starts) {
        constructions++
        expect(start[1], `${file}: CLI serve must own its readiness endpoint`).toBe('spawnFixtureServer')
      }
      if (starts.length) expect(source, `${file}: await owned health before seeding or browser setup`).toContain('await waitForFixtureServer(')
    }
    // The complete construction audit is documented in e2e/fixture-server.md.
    expect(constructions).toBe(48)
  })

  it('uses the actual child listener when the requested endpoint belongs to a 404 server', async () => {
    let foreignProbes = 0
    const foreign = createServer((_request, response) => { foreignProbes++; response.writeHead(404).end() })
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve))
    const address = foreign.address()
    if (!address || typeof address === 'string') throw new Error('foreign listener missing')
    try {
      const child = spawnFixtureServer(['-e', serverScript(), '--', '--port', String(address.port)], { env: process.env })
      children.push(child)
      const actual = await waitForFixtureServer(child, { deadline: Date.now() + 1_500 })
      expect(actual).not.toBe(`http://127.0.0.1:${address.port}`)
      expect((await fetch(`${actual}/api/v1/health`)).status).toBe(200)
      expect(foreignProbes).toBe(0)
    } finally { await new Promise<void>(resolve => foreign.close(() => resolve())) }
  })

  it('never certifies readiness from an unrelated requested endpoint returning 200', async () => {
    let foreignProbes = 0
    const foreign = createServer((_request, response) => { foreignProbes++; response.writeHead(200).end('foreign') })
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve))
    const address = foreign.address()
    if (!address || typeof address === 'string') throw new Error('foreign listener missing')
    try {
      const child = spawnFixtureServer(['-e', serverScript(), '--', '--port', String(address.port)], { env: process.env })
      children.push(child)
      await waitForFixtureServer(child)
      expect(foreignProbes).toBe(0)
    } finally { await new Promise<void>(resolve => foreign.close(() => resolve())) }
  })

  it('handles an announcement split across stdout chunks', async () => {
    const child = owned(serverScript({ chunked: true }))
    expect(await waitForFixtureServer(child)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('decodes an announcement when its UTF8 arrow bytes straddle stdout chunks', async () => {
    const child = owned(`
      let remainder;
      const server = require('node:http').createServer((req, res) => {
        if (req.url === '/release') { process.stdout.write(remainder); res.writeHead(204).end(); }
        else res.end('healthy');
      });
      server.listen(0, '127.0.0.1', () => {
        const line = Buffer.from('  cockpit → http://127.0.0.1:' + server.address().port + '\\n');
        const split = line.indexOf(Buffer.from('→')) + 1;
        remainder = line.subarray(split);
        console.log('fixture-port=' + server.address().port);
        process.stdout.write(line.subarray(0, split));
      });
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `)
    // The child cannot write the remaining arrow bytes until the parent has received
    // the first fragment and acknowledges it through the child's actual HTTP listener.
    const listener = await new Promise<string>((resolve, reject) => {
      let received = ''
      const onData = (chunk: Buffer | string) => {
        received += String(chunk)
        if (!received.includes('cockpit ')) return
        child.stdout!.off('data', onData)
        const port = /fixture-port=(\d+)/.exec(received)?.[1]
        if (!port) reject(new Error('First fragment did not identify its fixture listener'))
        else resolve(`http://127.0.0.1:${port}`)
      }
      child.stdout!.on('data', onData)
    })
    expect((await fetch(`${listener}/release`, { method: 'POST', signal: AbortSignal.timeout(1_000) })).status).toBe(204)
    expect(await waitForFixtureServer(child, { deadline: Date.now() + 1_000 })).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  for (const announcement of ['https://127.0.0.1:4321', 'http://localhost:4321', 'http://127.0.0.1:4321/path', 'http://fixture.invalid:4321', 'http://user:fake@127.0.0.1:4321']) {
    it(`rejects an invalid announced endpoint (${announcement}) and stops its own child`, async () => {
      const child = owned(serverScript({ announcement }))
      await expect(waitForFixtureServer(child)).rejects.toThrow('Invalid fixture listener announcement')
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    })
  }

  it('reports actual spawn failure and cleans up', async () => {
    const child = spawnFixtureServer(['-e', ''], { cwd: '/cezar-e2e-missing-fixture-cwd', env: process.env })
    children.push(child)
    await expect(waitForFixtureServer(child)).rejects.toThrow('ENOENT')
  })

  it('reports a child exit before any announcement instead of polling another server', async () => {
    const child = owned("console.error('fixture startup phase failed'); process.exit(42)")
    await expect(waitForFixtureServer(child)).rejects.toThrow('fixture startup phase failed')
    expect(child.exitCode).toBe(42)
  })

  it('stops a child whose listener announcement never arrives', async () => {
    const child = owned("setInterval(() => {}, 1000)")
    const deadline = Date.now() + 400
    const started = Date.now()
    await expect(waitForFixtureServer(child, { deadline })).rejects.toThrow('awaiting listener announcement')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('charges earlier setup time to the original spawn-to-health deadline', async () => {
    const child = spawnFixtureServer(['-e', "setTimeout(() => console.log('setup checkpoint'), 350); setInterval(() => {}, 1000)"], { env: process.env }, { timeoutMs: 600 })
    children.push(child)
    await once(child.stdout!, 'data')
    const started = Date.now()
    await expect(waitForFixtureServer(child)).rejects.toThrow('awaiting listener announcement')
    expect(Date.now() - started).toBeLessThan(400)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('keeps the health request within the same deadline and aborts late headers', async () => {
    const child = owned(serverScript({ headerDelay: 2_000 }))
    const started = Date.now()
    await expect(waitForFixtureServer(child, { deadline: Date.now() + 900 })).rejects.toThrow('health')
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('preserves the original header-status health gate when the body arrives later', async () => {
    const child = owned(serverScript({ bodyDelay: 300 }))
    expect(await waitForFixtureServer(child)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('does not accept a child that exits while its health headers are being awaited', async () => {
    const child = owned(`
      const server = require('node:http').createServer(() => process.exit(43));
      server.listen(0,'127.0.0.1',() => console.log('  cockpit → http://127.0.0.1:' + server.address().port));
    `)
    await expect(waitForFixtureServer(child)).rejects.toThrow('code=43')
  })

  it('requires a restarted child to keep the original endpoint instead of accepting a new one', async () => {
    const child = owned(serverScript())
    await expect(waitForFixtureServer(child, { expectedOrigin: 'http://127.0.0.1:1' })).rejects.toThrow('Fixture restart listener changed')
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('accepts a same-endpoint continuation and retains bounded startup stderr', async () => {
    const script = serverScript({ stderr: 'diagnostic'.repeat(4_000) })
    const child = owned(script)
    const sample = captureFixtureServer(child)
    const origin = await waitForFixtureServer(child)
    expect(await waitForFixtureServer(child, { expectedOrigin: origin })).toBe(origin)
    expect(sample().stderr.length).toBe(16_384)
    expect(sample().stderrDropped).toBe(40_000 - 16_384)
  })

  it('reports an unhealthy owned listener, retries within its existing budget, and stops only its child', async () => {
    const child = owned(serverScript({ status: 503 }))
    await once(child.stdout!, 'data')
    await expect(waitForFixtureServer(child, { deadline: Date.now() + 900 })).rejects.toThrow('answered 503')
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it.each([500, 503])('retains the received HTTP %s when a later health probe times out', async status => {
    const child = owned(serverScript({ status }))
    // Arrange the owned listener, not an unrelated endpoint or a guessed port.
    await once(child.stdout!, 'data')
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const nativeFetch = globalThis.fetch
    const received: number[] = []
    let probes = 0
    const fetchProbe = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      probes++
      if (probes === 1) {
        const response = await nativeFetch(input, options)
        received.push(response.status)
        now += 500
        return response
      }
      // Deterministically reproduce the final, budget-exhausting transport error.
      now += 900
      throw new Error('late health probe timeout')
    })
    try {
      const failure = await waitForFixtureServer(child, { deadline: Date.now() + 900 }).catch(error => error)
      expect(received).toEqual([status])
      expect(probes).toBe(2)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toContain(`answered ${status}`)
      expect(failure.message).toContain('late health probe timeout')
      expect(failure.cause.cause.message).toBe('late health probe timeout')
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      fetchProbe.mockRestore()
      clock.mockRestore()
    }
  })

  it('refuses an unrelated child that was not constructed by the owned fixture helper', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    children.push(child)
    await expect(waitForFixtureServer(child)).rejects.toThrow('not constructed by spawnFixtureServer')
  })
})
