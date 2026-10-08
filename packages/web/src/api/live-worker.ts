import { liveRunFrameSchema } from '@open-mercato/cezar-api-client'
import { createLiveOwner, type LivePort } from './live-owner'
import { createTopicSocket } from './topic-socket'
import { readSse } from './sse-reader'

const topicSocket = createTopicSocket()
const owner = createLiveOwner({
  async stream(kind, runs, frame, signal) {
    const response = await fetch(kind === 'workspace' ? '/api/v1/workspace/events' : '/api/v1/workspace/run-events', {
      credentials: 'include', signal,
      ...(kind === 'runs' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs }) } : {}),
    })
    if (response.status === 401 || response.status === 403) throw new Error('authentication required')
    await readSse(response, incoming => {
      if (kind === 'workspace') { frame(incoming); return }
      if (incoming.event !== 'live') return
      try {
        const parsed = liveRunFrameSchema.safeParse(JSON.parse(incoming.data))
        if (parsed.success) frame(parsed.data)
      } catch { /* Ignore malformed frames; silence watchdog remains independent. */ }
    }, signal)
  },
  topic: (topic, listener) => topicSocket.subscribe(topic, listener),
  async read(path, signal) {
    const response = await fetch(path, { credentials: 'include', signal })
    if (response.status === 401 || response.status === 403) throw new Error('authentication required')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { value: await response.json() }
  },
})
// A narrow worker-global surface avoids mixing lib.webworker and lib.dom declarations.
const worker = globalThis as unknown as { onconnect: (event: { ports: LivePort[] }) => void }
worker.onconnect = event => { const port = event.ports[0]; if (port) owner.attach(port) }
