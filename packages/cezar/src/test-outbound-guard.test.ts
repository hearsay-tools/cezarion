import { createServer, type Server } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { refusesConnection, takeOutboundRefusals, throwOutboundRefusals } from './test-outbound-guard.testkit.ts'

// The setup file installs the guard (hearsay-tools/cezarion#2367). These tests drive it through
// real sockets, so a setup that stops installing it fails here.

const REFUSED = 'ERR_TEST_OUTBOUND_REFUSED'

async function listenOn(server: Server, port: number): Promise<boolean> {
  return new Promise(resolve => {
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => resolve(true))
  })
}

/** A server on a port from the refused range, so only the served-port record lets a request through. */
async function serveInRefusedRange(): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000)
    const server = createServer((_req, res) => res.end('ok'))
    if (await listenOn(server, port)) return { server, port }
  }
  throw new Error('no free port between 20000 and 30000')
}

const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))

async function failure(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message: string } }).cause
    return cause ?? (error as { code?: string; message: string })
  }
  throw new Error('the request was not refused')
}

afterEach(() => {
  takeOutboundRefusals()
})

describe('outbound guard installed by the test setup', () => {
  it('refuses a loopback port that no server in this process listens on, before transport', async () => {
    const { server, port } = await serveInRefusedRange()
    await close(server)
    const error = await failure(fetch(`http://127.0.0.1:${port}/api/v1/health`))
    expect(error.code).toBe(REFUSED)
    expect(takeOutboundRefusals().map(refusal => refusal.destination)).toEqual([`127.0.0.1:${port}`])
  })

  it('refuses a non-loopback host before DNS', async () => {
    const error = await failure(fetch('https://chromium.example.invalid/download'))
    expect(error.code).toBe(REFUSED)
    expect(takeOutboundRefusals()).toHaveLength(1)
  })

  it('refuses a raw TCP connection too', async () => {
    const { server, port } = await serveInRefusedRange()
    await close(server)
    const error = await new Promise<NodeJS.ErrnoException>(resolve => connect(port, 'localhost').on('error', resolve))
    expect(error.code).toBe(REFUSED)
    expect(takeOutboundRefusals().map(refusal => refusal.destination)).toEqual([`localhost:${port}`])
  })

  it('lets a request reach a server this process listens on', async () => {
    const { server, port } = await serveInRefusedRange()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(await response.text()).toBe('ok')
      expect(takeOutboundRefusals()).toEqual([])
    } finally {
      await close(server)
    }
  })

  it('lets a connection reach a unix socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-guard-'))
    const path = join(dir, 'guard.sock')
    const server = createNetServer(socket => socket.end())
    await new Promise<void>(resolve => server.listen(path, resolve))
    try {
      await new Promise<void>((resolve, reject) => connect(path).on('connect', resolve).on('error', reject))
      expect(takeOutboundRefusals()).toEqual([])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails the test with the destination and the issue, even when the caller swallowed the error', async () => {
    const { server, port } = await serveInRefusedRange()
    await close(server)
    await fetch(`http://127.0.0.1:${port}/api/v1/p/cezar/runs`, { method: 'POST' }).catch(() => undefined)
    expect(() => throwOutboundRefusals()).toThrow(new RegExp(`127\\.0\\.0\\.1:${port}[\\s\\S]*hearsay-tools/cezarion#2367`))
    expect(takeOutboundRefusals()).toEqual([])
  })
})

describe('refusesConnection', () => {
  const served = new Set([4321])

  it.each([
    ['github.com', 443],
    ['storage.googleapis.com', 443],
    ['10.0.0.5', 4321],
    ['127.0.0.1', 4322],
    ['localhost', 5173],
    ['::1', 4370],
    ['0.0.0.0', 8080],
    ['[::1]', 1024],
    ['::ffff:127.0.0.1', 32767],
  ])('refuses %s:%s', (host, port) => {
    expect(refusesConnection(host, port, served)).toBe(true)
  })

  it.each([
    ['127.0.0.1', 4321], // served in this process
    ['127.0.0.1', 1], // below 1024: nothing unprivileged listens there
    ['localhost', 1023],
    ['127.0.0.1', 32768], // the ephemeral range, where listen(0) and child fixtures land
    ['::1', 59999],
    [undefined, 45000], // net defaults a missing host to localhost
  ])('allows %s:%s', (host, port) => {
    expect(refusesConnection(host, port, served)).toBe(false)
  })
})
