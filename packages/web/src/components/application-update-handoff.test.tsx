import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { useApplicationUpdate } from './use-application-update'

// A separate Node process keeps the real service/server/WS stack out of jsdom.
// Only npm preparation and helper arming are fixture seams; the hook, HTTP and
// health publication are production code, with arming gated until reconciliation.
for (const scenario of ['connected', 'disconnected', 'failed-arm'] as const) it(`preserves the restart handoff boundary across health reconciliation (${scenario})`, async () => {
  const disconnect = scenario !== 'connected'
  const failedArm = scenario === 'failed-arm'
  const root = await mkdtemp('/tmp/cez-update-handoff-')
  const packageRoot = dirname(createRequire(import.meta.url).resolve('@wjarka/cezarion/package.json'))
  const source = (path: string) => JSON.stringify(pathToFileURL(join(packageRoot, 'src', path)).href)
  const script = join(root, 'server.mts')
  await writeFile(script, `
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { ApplicationUpdateService } from ${source('application-update/service.ts')};
import { RunStore } from ${source('runs/store.ts')};
import { startServer } from ${source('server/server.ts')};
const root = ${JSON.stringify(root)};
const original = join(root, 'prefix/lib/node_modules/@wjarka/cezarion');
await mkdir(join(original, 'dist'), { recursive: true });
await mkdir(join(original, 'web/dist'), { recursive: true });
await writeFile(join(original, 'package.json'), JSON.stringify({name:'@wjarka/cezarion',version:'1.0.0',bin:{cez:'dist/index.js'},dependencies:{}}));
await writeFile(join(original, 'dist/index.js'), '');
await writeFile(join(original, 'web/dist/index.html'), '');
let arm;
const gate = new Promise(resolve => { arm = resolve });
let handoffs = 0;
const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original,'dist/index.js'),
  npmPrefix: join(root,'prefix'), npmCache: join(root,'cache'), home: join(root,'home'), targetVersion: () => '2.0.0',
  runNpm: async args => {
    const target = join(args[args.indexOf('--prefix') + 1], 'node_modules/@wjarka/cezarion');
    await cp(original, target, {recursive:true});
    const pkg = JSON.parse(await readFile(join(target,'package.json'),'utf8')); pkg.version = '2.0.0';
    await writeFile(join(target,'package.json'),JSON.stringify(pkg));
  },
  armRestart: async () => { await gate; if (${failedArm}) { process.send?.({event:'arm-failed'}); throw new Error('fixture arm failure'); } process.send?.({event:'armed'}); },
  handoff: () => { process.send?.({event:'handoff', count: ++handoffs}); void server.shutdownForRestart(); },
});
await service.apply();
const server = startServer({repoRoot:root, store:RunStore.open(join(root,'.ai/cezar')), manager:{}, version:'1.0.0', applicationUpdate:service},0);
server.prependListener('request', (req,res) => { if (req.url.endsWith('/restart')) {
  res.on('finish', () => process.send?.({event:'finish'}));
  res.on('close', () => process.send?.({event:'close'}));
}});
process.on('message', message => { if(message === 'arm') arm(); });
await once(server,'listening');
process.send?.({event:'listening',port:server.address().port});
`)
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: packageRoot, env: { ...process.env, CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1', CEZ_REMOTE: '0', CEZ_SKILLS_AUTO_UPDATE: '0' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const events: Array<{ event: string; port?: number; count?: number }> = []
  let stderr = ''
  child.stderr?.on('data', data => { stderr += String(data) })
  child.on('message', message => { events.push(message as typeof events[number]) })
  const { WebSocket } = createRequire(join(packageRoot, 'package.json'))('ws') as typeof import('ws')
  let socket: InstanceType<typeof WebSocket> | undefined
  let unmount: (() => void) | undefined
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
  } finally {
    unmount?.(); socket?.close(); vi.unstubAllGlobals(); sessionStorage.clear()
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 25_000)
