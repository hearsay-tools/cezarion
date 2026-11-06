import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveHandlers } from './live-coordinator'

let handlers: LiveHandlers | undefined
const requestWorkspaceReady = vi.fn(() => true)
const workspaceReadyReceived = vi.fn()
vi.mock('./live-coordinator', () => ({
  subscribeLive: (_demand: unknown, next: LiveHandlers) => { handlers = next; return () => { handlers = undefined } },
  requestWorkspaceReady: () => requestWorkspaceReady(),
  workspaceReadyReceived: () => workspaceReadyReceived(),
}))
const { LiveWorkspaceSource } = await import('./live-workspace-source')

afterEach(() => { handlers = undefined })

describe('LiveWorkspaceSource', () => {
  it('reports a shared-feed drop as CONNECTING plus error, then reopens on reconnect (hearsay-tools/cezarion#1069)', async () => {
    const source = new LiveWorkspaceSource()
    const seen: string[] = []
    for (const name of ['open', 'error']) source.addEventListener(name, () => seen.push(`${name}:${source.readyState}`))
    handlers!.ready!()
    await Promise.resolve()
    expect(seen).toEqual(['open:1'])
    handlers!.frame!({ event: 'disconnect', data: '', id: '' })
    expect(seen).toEqual(['open:1', 'error:0'])
    handlers!.frame!({ event: 'disconnect', data: '', id: '' }) // already CONNECTING: no second error
    handlers!.frame!({ event: 'reconnect', data: '', id: '' })
    await Promise.resolve()
    expect(seen).toEqual(['open:1', 'error:0', 'open:1'])
    source.close()
  })

  it('asks the coordinator for the stream ready without reopening, and a ready frame ends the request (hearsay-tools/cezarion#2729)', async () => {
    const source = new LiveWorkspaceSource()
    const seen: string[] = []
    source.addEventListener('open', () => seen.push('open'))
    handlers!.ready!()
    await Promise.resolve()
    expect(source.requestReady()).toBe(true)
    expect(requestWorkspaceReady).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['open'])
    handlers!.frame!({ event: 'ready', data: JSON.stringify({ generation: 'g1', seq: 3 }), id: '' })
    expect(workspaceReadyReceived).toHaveBeenCalledTimes(1)
    source.close()
    expect(source.requestReady()).toBe(false)
  })
})
