import { LIVE_BYTE_LIMIT } from '@open-mercato/cezar-api-client'

/** Fetch-based SSE, usable in SharedWorker and with POST subscription bodies. */
export interface SseFrame { event: string; data: string; id: string }
export async function readSse(response: Response, frame: (frame: SseFrame) => void, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.body) throw new Error(`live stream HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = '', data: string[] = [], event = '', id = '', size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  const line = (value: string, terminatorBytes: number) => {
    size += encoder.encode(value).length + terminatorBytes
    if (size > LIVE_BYTE_LIMIT) throw new Error('SSE frame exceeds limit')
    if (value === '') {
      if (data.length) frame({ event: event || 'message', data: data.join('\n'), id })
      data = []; event = ''; size = 0
      return
    }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const field = colon < 0 ? value : value.slice(0, colon)
    const body = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data.push(body)
    else if (field === 'event') event = body
    else if (field === 'id' && !body.includes('\0')) id = body
  }
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      // CRLF may straddle chunks. Hold a final CR until the next chunk.
      let start = 0
      for (let i = 0; i < pending.length; i++) {
        const char = pending[i]
        if (char !== '\n' && char !== '\r') continue
        if (char === '\r' && i === pending.length - 1) break
        const crlf = char === '\r' && pending[i + 1] === '\n'
        line(pending.slice(start, i), crlf ? 2 : 1)
        if (crlf) i++
        start = i + 1
      }
      pending = pending.slice(start)
      if (encoder.encode(pending).length + size > LIVE_BYTE_LIMIT) throw new Error('SSE frame exceeds limit')
    }
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
