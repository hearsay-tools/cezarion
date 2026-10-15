import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveHandlers } from './live-coordinator'

let handlers: LiveHandlers | undefined
vi.mock('./live-coordinator', () => ({
  subscribeLive: (_demand: unknown, next: LiveHandlers) => { handlers = next; return () => { handlers = undefined } },
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
})
