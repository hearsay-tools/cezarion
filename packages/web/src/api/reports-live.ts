import { useEffect } from 'react'
import { useQueryClient, type InfiniteData, type QueryClient, type Query } from '@tanstack/react-query'
import { reportsFrameSchema, reportsStateSchema, type ReportsFrame, type ReportsMetadata, type ReportsResponse, type ReportsState } from '@open-mercato/cezar-api-client/contract/reports'
import { liveTransport, onLiveTransport } from './live-coordinator'
import { subscribeLiveRead } from './live-reads'
import { subscribeTopic } from './ws'

type Shelf = InfiniteData<ReportsResponse, string | undefined>
const clients = new WeakMap<QueryClient, Map<string, ReportsFence>>()

function compareState(old: ReportsState | undefined, frame: ReportsFrame) {
  if (!old) return { content: frame.type === 'content', metadata: frame.type === 'metadata', reset: false }
  if (old.epoch !== frame.epoch) return { content: true, metadata: true, reset: true }
  if (frame.generation < old.generation || frame.metadataGeneration < old.metadataGeneration) return undefined
  if (old.generation === frame.generation && old.metadataGeneration === frame.metadataGeneration) return undefined
  return { content: frame.generation !== old.generation, metadata: frame.metadataGeneration !== old.metadataGeneration, reset: false }
}

/** One fence per project cache, including queries whose first response has not arrived. */
export class ReportsFence {
  private state?: ReportsState
  private content = 0
  private metadata = 0
  private patches = new Map<string, { value: ReportsMetadata; version: number }>()
  private trailing = new Set<Query>()
  constructor(private client: QueryClient, private project: string) {
    client.getQueryCache().subscribe(event => {
      if (event.type === 'removed') { this.trailing.delete(event.query); return }
      if (!this.trailing.has(event.query) || event.query.state.fetchStatus !== 'idle') return
      this.trailing.delete(event.query)
      // Infinite queries may already have read earlier pages when this event arrived. Reconcile
      // the whole shelf after settlement, not just the page whose query function was still pending.
      queueMicrotask(() => { void client.invalidateQueries({ queryKey: event.query.queryKey, exact: true, refetchType: 'active' }, { cancelRefetch: false }) })
    })
  }
  private patch(page: ReportsResponse, since = -1): ReportsResponse {
    return { ...page, reports: page.reports.map(row => {
      const patch = this.patches.get(row.runId)
      return patch && patch.version > since ? { ...row, taskTitle: patch.value.taskTitle, taskStatus: patch.value.taskStatus } : row
    }) }
  }
  async read(q: string, fetch: () => Promise<ReportsResponse>): Promise<ReportsResponse> {
    for (;;) {
      const content = this.content, metadata = this.metadata
      const page = await fetch()
      // An invalidation cannot be lost when TanStack settles an existing flight, even its first.
      if (content !== this.content || (q.trim() !== '' && metadata !== this.metadata)) continue
      return q.trim() === '' ? this.patch(page, metadata) : page
    }
  }
  receive(frame: ReportsFrame, reconnect = false): void {
    const old = this.state
    if (!old && frame.type === 'snapshot') {
      this.state = frame
      this.content++ // Fence a mount read started before the first subscription snapshot.
      return
    }
    const change = compareState(old, frame)
    if (!change) {
      if (reconnect && frame.type === 'snapshot') { this.content++; this.invalidate(true) }
      return
    }
    const { metadata, reset } = change
    const content = change.content || (reconnect && frame.type === 'snapshot')
    this.state = frame
    if (reset) this.patches.clear()
    if (metadata) this.metadata++
    if (content) this.content++
    if (frame.type === 'metadata' && !reset) this.patchCaches(frame)
    const all = content || (metadata && frame.type !== 'metadata')
    if (all || metadata) this.invalidate(all)
  }
  private patchCaches(frame: Extract<ReportsFrame, { type: 'metadata' }>): void {
    for (const run of frame.runs) this.patches.set(run.runId, { value: run, version: this.metadata })
    this.client.setQueriesData<Shelf>({ queryKey: [this.project, 'reports'], predicate: query => String(query.queryKey[2] ?? '').trim() === '' }, cached => cached && ({ ...cached, pages: cached.pages.map(page => this.patch(page, this.metadata - 1)) }))
  }
  private invalidate(all: boolean): void {
    const filters = { queryKey: [this.project, 'reports'], refetchType: 'active' as const,
      ...(all ? {} : { predicate: (query: Query) => String(query.queryKey[2] ?? '').trim() !== '' }),
    }
    for (const query of this.client.getQueryCache().findAll(filters)) {
      if (query.state.fetchStatus === 'fetching') this.trailing.add(query)
    }
    void this.client.invalidateQueries(filters, { cancelRefetch: false })
  }
}

export function reportsFence(client: QueryClient, project: string): ReportsFence {
  let projects = clients.get(client)
  if (!projects) { projects = new Map(); clients.set(client, projects) }
  let fence = projects.get(project)
  if (!fence) { fence = new ReportsFence(client, project); projects.set(project, fence) }
  return fence
}

export function useReportsLive(project: string): ReportsFence {
  const client = useQueryClient()
  const fence = reportsFence(client, project)
  useEffect(() => {
    const offTopic = subscribeTopic(`reports:project:${project}`, value => {
      const parsed = reportsFrameSchema.safeParse(value)
      if (parsed.success) fence.receive(parsed.data, parsed.data.type === 'snapshot')
    })
    let offRead: (() => void) | undefined
    const follow = () => {
      if (liveTransport() === 'finite' && !offRead) offRead = subscribeLiveRead({ path: `/api/v1/p/${encodeURIComponent(project)}/reports/state`, intervalMs: 5_000 }, (value, error) => {
        const parsed = reportsStateSchema.safeParse(value)
        if (!error && parsed.success) fence.receive({ type: 'snapshot', ...parsed.data })
      })
      else if (liveTransport() !== 'finite') { offRead?.(); offRead = undefined }
    }
    follow()
    const offTransport = onLiveTransport(follow)
    return () => { offTransport(); offRead?.(); offTopic() }
  }, [fence, project])
  return fence
}
