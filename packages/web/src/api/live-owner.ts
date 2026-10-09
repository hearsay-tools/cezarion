import { LIVE_BYTE_LIMIT, LIVE_RUN_LIMIT, type LiveRunDemand } from '@open-mercato/cezar-api-client'
import { LEASE_MS, LIVE_PROTOCOL, ownerInputSchema, runKey, type LiveDemand, type LiveFrame, type OwnerOutput } from './live-protocol'

export interface LivePort {
  onmessage: ((event: { data: unknown }) => void) | null
  onmessageerror: (() => void) | null
  postMessage(value: unknown): void
  start(): void
  close(): void
}
export interface LiveOwnerDeps {
  stream(kind: 'workspace' | 'runs', runs: LiveRunDemand[], frame: (frame: LiveFrame) => void, signal: AbortSignal): Promise<void>
  topic(topic: string, value: (value: unknown) => void): () => void
  read(path: string, signal: AbortSignal): Promise<{ value: unknown; error?: string }>
}
interface Entry {
  id: string
  demand: LiveDemand
  sent: number
  ack: number
  unacked: Array<{ seq: number; bytes: number }>
  bytes: number
  paused: boolean
}
interface DocumentPort { port: LivePort; id: string; epoch: number; seenAt: number; entries: Map<string, Entry> }
interface Lane { signature: string; controller?: AbortController; retry?: ReturnType<typeof setTimeout>; lastFrame: number }
interface ReadJob { controller: AbortController; deadline?: ReturnType<typeof setTimeout>; nextAt: number; timer?: ReturnType<typeof setTimeout>; revision: number; interval: number }

/** Worker-owned demand union. No React, document globals, or authentication-bound remote data. */
export function createLiveOwner(deps: LiveOwnerDeps) {
  const documents = new Set<DocumentPort>()
  const lanes: Record<'workspace' | 'runs', Lane> = {
    workspace: { signature: '', lastFrame: 0 }, runs: { signature: '', lastFrame: 0 },
  }
  const topics = new Map<string, () => void>()
  const topicValues = new Map<string, unknown>()
  const reads = new Map<string, ReadJob>()
  let tick: ReturnType<typeof setInterval> | undefined
  let scheduled = false, disposed = false, workspaceReady = false
  let generation: string | undefined
  const held = (kind?: LiveDemand['kind']) => [...documents].flatMap(doc => [...doc.entries.values()]
    .filter(entry => !entry.paused && (!kind || entry.demand.kind === kind)).map(entry => ({ doc, entry })))
  const send = (doc: DocumentPort, message: OwnerOutput) => {
    try { doc.port.postMessage(message) } catch { release(doc) }
  }
  const failure = (error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'authentication required') return
    for (const doc of [...documents]) {
      send(doc, { type: 'unavailable', version: LIVE_PROTOCOL, epoch: doc.epoch, reason: error.message })
      release(doc)
    }
  }
  const reset = (doc: DocumentPort, entry: Entry, reason: string) => {
    entry.paused = true
    entry.unacked = []; entry.bytes = 0
    send(doc, { type: 'reset', version: LIVE_PROTOCOL, epoch: doc.epoch, id: entry.id, reason })
    schedule()
  }
  const deliver = (doc: DocumentPort, entry: Entry, frame: LiveFrame) => {
    if ('type' in frame && frame.type === 'event') {
      if (frame.event.seq <= entry.sent) return
      const bytes = new TextEncoder().encode(JSON.stringify(frame)).length
      if (entry.bytes + bytes > LIVE_BYTE_LIMIT) { reset(doc, entry, 'subscriber fell behind — reload history'); return }
      entry.sent = frame.event.seq
      entry.bytes += bytes
      entry.unacked.push({ seq: entry.sent, bytes })
    }
    send(doc, { type: 'frame', version: LIVE_PROTOCOL, epoch: doc.epoch, id: entry.id, frame })
  }
  const onGeneration = (next: string) => {
    const changed = generation !== undefined && next !== generation
    generation = next
    if (changed) for (const { doc, entry } of held()) reset(doc, entry, 'server restarted')
  }
  const stopLane = (lane: Lane) => {
    clearTimeout(lane.retry); lane.retry = undefined
    const controller = lane.controller; lane.controller = undefined
    controller?.abort()
  }
  const startLane = (kind: 'workspace' | 'runs') => {
    const lane = lanes[kind]
    if (!lane.signature || disposed) return
    stopLane(lane)
    const controller = new AbortController()
    lane.controller = controller; lane.lastFrame = Date.now()
    if (kind === 'workspace') {
      if (workspaceReady) for (const { doc, entry } of held('workspace')) deliver(doc, entry, { event: 'reconnect', data: '', id: '' })
      workspaceReady = false
    }
    const runs = new Map<string, LiveRunDemand>()
    if (kind === 'runs') for (const { entry } of held('run')) {
      const demand = entry.demand as Extract<LiveDemand, { kind: 'run' }>
      const current = runs.get(runKey(demand))
      if (!current || entry.ack < current.afterSeq) {
        const { kind: _, ...run } = demand
        runs.set(runKey(run), { ...run, afterSeq: entry.ack })
      }
    }
    void deps.stream(kind, [...runs.values()], frame => {
      if (lane.controller !== controller || controller.signal.aborted) return
      lane.lastFrame = Date.now()
      if ('type' in frame && frame.type === 'ready') onGeneration(frame.generation)
      if ('data' in frame && frame.event === 'ready') {
        try { const data = JSON.parse(frame.data) as { generation?: unknown }; if (typeof data.generation === 'string') onGeneration(data.generation) } catch { /* ignore malformed control */ }
      }
      if (kind === 'workspace' && 'event' in frame && frame.event === 'ping') workspaceReady = true
      for (const { doc, entry } of held(kind === 'workspace' ? 'workspace' : 'run')) {
        if (entry.demand.kind === 'run' && 'type' in frame && 'runId' in frame && runKey(frame) !== runKey(entry.demand)) continue
        deliver(doc, entry, frame)
      }
    }, controller.signal).catch(failure).finally(() => {
      if (lane.controller !== controller || controller.signal.aborted || disposed) return
      lane.controller = undefined
      lane.retry = setTimeout(() => { lane.retry = undefined; startLane(kind) }, 1_500)
    })
  }
  const refreshRead = (path: string, job: ReadJob) => {
    clearTimeout(job.timer); job.timer = undefined
    const revision = ++job.revision
    job.controller.abort(); job.controller = new AbortController()
    clearTimeout(job.deadline)
    const controller = job.controller
    const deadline = job.deadline = setTimeout(() => controller.abort(), 10_000)
    void deps.read(path, job.controller.signal).then(value => {
      if (reads.get(path) !== job || revision !== job.revision) return
      for (const { doc, entry } of held('read')) if (entry.demand.kind === 'read' && entry.demand.path === path) {
        send(doc, { type: 'value', version: LIVE_PROTOCOL, epoch: doc.epoch, id: entry.id, ...value })
      }
    }).catch(failure).finally(() => {
      clearTimeout(deadline)
      if (reads.get(path) === job && revision === job.revision) {
        job.deadline = undefined
        job.nextAt = Date.now() + job.interval
        job.timer = setTimeout(() => refreshRead(path, job), job.interval)
      }
    })
  }
  const reconcile = () => {
    scheduled = false
    if (disposed) return
    const workspace = held('workspace')
    const runEntries = held('run')
    const keys = new Set<string>()
    for (const { doc, entry } of runEntries) {
      const key = runKey(entry.demand as Extract<LiveDemand, { kind: 'run' }>)
      if (!keys.has(key) && keys.size >= LIVE_RUN_LIMIT) reset(doc, entry, 'shared task capacity reached')
      else keys.add(key)
    }
    const signatures = {
      workspace: workspace.length ? 'workspace' : '',
      runs: held('run').map(({ doc, entry }) => `${doc.id}:${doc.epoch}:${entry.id}`).sort().join('|'),
    }
    for (const kind of ['workspace', 'runs'] as const) {
      const lane = lanes[kind]
      if (lane.signature === signatures[kind]) continue
      lane.signature = signatures[kind]
      stopLane(lane)
      if (lane.signature) startLane(kind)
      else if (kind === 'workspace') workspaceReady = false
    }
    const wantedTopics = new Set(held('topic').map(({ entry }) => (entry.demand as Extract<LiveDemand, { kind: 'topic' }>).topic))
    for (const [topic, off] of topics) if (!wantedTopics.has(topic)) { off(); topics.delete(topic); topicValues.delete(topic) }
    for (const topic of wantedTopics) if (!topics.has(topic)) topics.set(topic, deps.topic(topic, value => {
      topicValues.set(topic, value)
      for (const { doc, entry } of held('topic')) if (entry.demand.kind === 'topic' && entry.demand.topic === topic) {
        send(doc, { type: 'value', version: LIVE_PROTOCOL, epoch: doc.epoch, id: entry.id, value })
      }
    }))
    const wantedReads = new Map<string, number>()
    for (const { entry } of held('read')) if (entry.demand.kind === 'read') {
      wantedReads.set(entry.demand.path, Math.min(wantedReads.get(entry.demand.path) ?? Infinity, entry.demand.intervalMs))
    }
    for (const [path, job] of reads) if (!wantedReads.has(path)) { reads.delete(path); clearTimeout(job.timer); clearTimeout(job.deadline); job.controller.abort() }
    for (const [path, interval] of wantedReads) {
      const current = reads.get(path)
      if (current) {
        if (interval < current.interval && current.timer) {
          clearTimeout(current.timer)
          current.nextAt = Math.min(current.nextAt, Date.now() + interval)
          current.timer = setTimeout(() => refreshRead(path, current), Math.max(0, current.nextAt - Date.now()))
        }
        current.interval = interval; continue
      }
      const job: ReadJob = { controller: new AbortController(), revision: 0, interval, nextAt: Date.now() + interval }
      reads.set(path, job); job.timer = setTimeout(() => refreshRead(path, job), interval)
    }
    if (!documents.size) { clearInterval(tick); tick = undefined }
  }
  function schedule() {
    if (!scheduled && !disposed) { scheduled = true; queueMicrotask(reconcile) }
  }
  function release(doc: DocumentPort) {
    documents.delete(doc)
    doc.port.onmessage = null; doc.port.onmessageerror = null
    try { doc.port.close() } catch { /* already detached */ }
    schedule()
  }
  const attach = (port: LivePort) => {
    if (disposed || documents.size >= 128) { port.close(); return () => {} }
    const doc: DocumentPort = { port, id: '', epoch: -1, seenAt: Date.now(), entries: new Map() }
    documents.add(doc)
    port.onmessageerror = () => release(doc)
    port.onmessage = ({ data }) => {
      const parsed = ownerInputSchema.safeParse(data)
      if (!parsed.success) { release(doc); return }
      const message = parsed.data
      if (doc.id && message.documentId !== doc.id || message.epoch < doc.epoch) return
      if (message.type === 'sync') {
        doc.id = message.documentId
        const epochChanged = doc.epoch !== message.epoch
        doc.epoch = message.epoch; doc.seenAt = Date.now()
        const next = new Map<string, Entry>()
        for (const item of message.entries) {
          const old = epochChanged ? undefined : doc.entries.get(item.id)
          const entry: Entry = old ?? { ...item, sent: item.demand.kind === 'run' ? item.demand.afterSeq : 0, ack: item.demand.kind === 'run' ? item.demand.afterSeq : 0, unacked: [], bytes: 0, paused: false }
          next.set(item.id, entry)
          if (!old && item.demand.kind === 'topic' && topicValues.has(item.demand.topic)) {
            send(doc, { type: 'value', version: LIVE_PROTOCOL, epoch: doc.epoch, id: entry.id, value: topicValues.get(item.demand.topic) })
          }
          if (!old && item.demand.kind === 'workspace' && workspaceReady) {
            deliver(doc, entry, { event: 'ping', data: '', id: '' })
          }

        }
        doc.entries = next
        if (!next.size) { release(doc); return }
        send(doc, { type: 'alive', version: LIVE_PROTOCOL, epoch: doc.epoch })
        schedule()
      } else if (message.epoch === doc.epoch) {
        const entry = doc.entries.get(message.id)
        if (!entry) return
        if (message.type === 'ack' && message.seq <= entry.sent && message.seq > entry.ack) {
          entry.ack = message.seq
          entry.unacked = entry.unacked.filter(value => { if (value.seq > message.seq) return true; entry.bytes -= value.bytes; return false })
        }
        if (message.type === 'refresh' && entry.demand.kind === 'read') {
          const job = reads.get(entry.demand.path)
          if (job) refreshRead(entry.demand.path, job)
        }
      }
    }
    port.start()
    send(doc, { type: 'hello', version: LIVE_PROTOCOL })
    tick ??= setInterval(() => {
      for (const doc of [...documents]) if (Date.now() - doc.seenAt >= LEASE_MS) release(doc)
      for (const kind of ['workspace', 'runs'] as const) if (lanes[kind].controller && Date.now() - lanes[kind].lastFrame >= 40_000) startLane(kind)
    }, 1_000)
    return () => release(doc)
  }
  return {
    attach,
    dispose() {
      disposed = true
      for (const doc of [...documents]) release(doc)
      for (const lane of Object.values(lanes)) stopLane(lane)
      for (const off of topics.values()) off()
      topics.clear(); topicValues.clear()
      for (const job of reads.values()) { clearTimeout(job.timer); clearTimeout(job.deadline); job.controller.abort() }
      reads.clear(); clearInterval(tick); tick = undefined
    },
  }
}
