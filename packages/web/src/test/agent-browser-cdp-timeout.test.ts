// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { AgentBrowser } from '../../e2e/agent-browser'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([
  { options: undefined, timeout: 10_000 },
  { options: { requestTimeoutMs: 60_000 }, timeout: 60_000 },
])('bounds an unanswered CDP request at $timeout ms', async ({ options, timeout }) => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', class extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send() {}
    close() {}
  })
  const browser = Object.create(AgentBrowser.prototype) as AgentBrowser
  Object.defineProperty(browser, 'run', { value: () => ({ cdpUrl: 'ws://fixture' }) })
  const pending = browser.withCdp(request => request('Runtime.evaluate'), options)
  let settled = false
  void pending.catch(() => { settled = true })
  await vi.advanceTimersByTimeAsync(timeout - 1)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await expect(pending).rejects.toThrow('CDP Runtime.evaluate timed out')
})
