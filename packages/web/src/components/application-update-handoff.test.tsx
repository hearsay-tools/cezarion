import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { useApplicationUpdate } from './use-application-update'

// This helper reads Node process state. Load it through Node, as the child does,
// so Vite does not transform its builtin imports into synthetic binding adapters.
const { measurementEnabled } = createRequire(import.meta.url)('../../../../.ai/skills/check-code-quality/scripts/source-snapshots.mjs') as typeof import('../../../../.ai/skills/check-code-quality/scripts/source-snapshots.mjs')

async function flushCoverage(child: ChildProcess, events: Array<{ event: string }>, bodyFailed: boolean) {
  if (!measurementEnabled() || !child.connected) return
  try {
    await new Promise<void>((resolve, reject) => child.send('quality:flush', error => error ? reject(error) : resolve()))
    // bound: a coverage flush must acknowledge before cleanup terminates the child.
    await waitFor(() => expect(events.some(e => e.event === 'quality:flushed')).toBe(true), { timeout: 5000 })
  } catch (error) {
    // Preserve the original assertion. A successful body still requires a flush.
    if (!bodyFailed) throw error
  }
}

// A separate Node process keeps the real service/server/WS stack out of jsdom.
// Only npm preparation and helper arming are fixture seams; the hook, HTTP and
// health publication are production code, with arming gated until reconciliation.
for (const scenario of ['connected', 'disconnected', 'failed-arm'] as const) it(`preserves the restart handoff boundary across health reconciliation (${scenario})`, async () => {
  const disconnect = scenario !== 'connected'
  const failedArm = scenario === 'failed-arm'
  const root = await mkdtemp('/tmp/cez-update-handoff-')
  const packageRoot = dirname(createRequire(import.meta.url).resolve('@wjarka/cezarion/package.json'))
  const script = join(packageRoot, 'test/fixtures/application-update-handoff.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', script, root, scenario], {
    cwd: packageRoot, env: { ...process.env, CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1', CEZ_REMOTE: '0' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const events: Array<{ event: string; port?: number | undefined; count?: number | undefined }> = []
  let stderr = ''
  child.stderr?.on('data', data => { stderr += String(data) })
  child.on('message', message => { events.push(message as typeof events[number]) })
  const { WebSocket } = createRequire(join(packageRoot, 'package.json'))('ws') as typeof import('ws')
  let socket: InstanceType<typeof WebSocket> | undefined
  let unmount: (() => void) | undefined
  let bodyFailed = false
  try {
    await waitFor(() => { expect(child.exitCode, stderr).toBeNull(); expect(events.some(e => e.event === 'listening')).toBe(true) }, { timeout: 15_000 })
    const base = `http://127.0.0.1:${events.find(e => e.event === 'listening')!.port}`
    const nativeFetch = globalThis.fetch
    let signal: AbortSignal | undefined
    let responseStatus: number | undefined
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined
      const response = await nativeFetch(new URL(url, base), init)
      responseStatus = response.status
      return response
    })
    const ready = await (await nativeFetch(`${base}/api/v1/health`)).json() as HealthResponse
    const client = createQueryClient()
    client.setQueryData(queryKeys.health, ready)
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const hook = renderHook(({ health }) => useApplicationUpdate(health), { wrapper, initialProps: { health: ready } })
    unmount = hook.unmount
    let received: HealthResponse | undefined
    socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/v1/ws`)
    socket.onopen = () => socket!.send(JSON.stringify({ type: 'subscribe', topic: 'health' }))
    socket.onmessage = event => { const frame = JSON.parse(String(event.data)); if (frame.topic === 'health') received = frame.data }
    await waitFor(() => expect(received?.applicationUpdate?.status).toBe('ready'))
    act(() => { void hook.result.current.restart() })
    await waitFor(() => expect(received?.applicationUpdate?.status).toBe('restarting'), { timeout: 5000 })
    act(() => { client.setQueryData(queryKeys.health, received); hook.rerender({ health: received! }) })
    await waitFor(() => expect(hook.result.current.busy).toBe(false))
    if (disconnect) {
      hook.unmount(); unmount = undefined
      await waitFor(() => expect(events.some(e => e.event === 'close')).toBe(true))
    } else expect(signal?.aborted).toBe(false)
    child.send('arm')
    if (failedArm) {
      await waitFor(() => expect(events.some(e => e.event === 'arm-failed')).toBe(true))
      await waitFor(async () => expect((await (await nativeFetch(`${base}/api/v1/health`)).json() as HealthResponse).applicationUpdate?.status).toBe('ready'), { timeout: 5000 })
      expect(events.filter(e => e.event === 'handoff')).toEqual([])
      return
    }
    await waitFor(() => expect(events.filter(e => e.event === 'handoff')).toEqual([{ event: 'handoff', count: 1 }]), { timeout: 5000 })
    if (!disconnect) {
      await waitFor(() => expect(responseStatus).toBe(200))
      expect(events.findIndex(e => e.event === 'finish')).toBeLessThan(events.findIndex(e => e.event === 'handoff'))
    }
  } catch (error) {
    bodyFailed = true
    throw error
  } finally {
    unmount?.(); socket?.close(); vi.unstubAllGlobals(); sessionStorage.clear()
    try {
      await flushCoverage(child, events, bodyFailed)
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
}, 25_000)
