import { QueryClient, QueryObserver, InfiniteQueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ReportsResponse, ReportsFrame } from '@open-mercato/cezar-api-client/contract/reports'
import { ReportsFence } from './reports-live'
const epoch = 'a38758b1-daa2-48e0-a9ac-021da66a264e'
const snapshot = { epoch, generation: 0, metadataGeneration: 0, type: 'snapshot' as const }
const page = (title = 'Old'): ReportsResponse => ({ total: 1, nextCursor: null, reports: [{ id: 'a38758b1-daa2-48e0-a9ac-021da66a264f', runId: epoch, name: 'report.html', title: 'Report', createdAt: '2026-11-06T00:00:00.000Z', size: 1, taskTitle: title, taskStatus: 'running' }] })
const metadata = (generation = 1, title = 'New'): ReportsFrame => ({ ...snapshot, type: 'metadata', metadataGeneration: generation, runs: [{ runId: epoch, taskTitle: title, taskStatus: 'done' }] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

describe('report shelf fence', () => {
  it('patches unfiltered cached pages and marks search shelves stale without touching another project', () => {
    const client = new QueryClient()
    const fence = new ReportsFence(client, 'P'); fence.receive(snapshot)
    for (const project of ['P', 'Q']) for (const q of ['', 'Old']) client.setQueryData([project, 'reports', q], { pages: [page()], pageParams: [undefined] })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fence.receive(metadata())
    expect(client.getQueryData<any>(['P', 'reports', '']).pages[0].reports[0].taskTitle).toBe('New')
    expect(client.getQueryState(['P', 'reports', ''])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['P', 'reports', 'Old'])?.isInvalidated).toBe(true)
    expect(client.getQueryData<any>(['Q', 'reports', '']).pages[0].reports[0].taskTitle).toBe('Old')
    expect(client.getQueryState(['Q', 'reports', 'Old'])?.isInvalidated).toBe(false)
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ refetchType: 'active' }), { cancelRefetch: false })
    client.clear()
  })
  it.each(['', 'Old'])('repeats an in-flight content read for q=%s', async q => {
    const client = new QueryClient(), fence = new ReportsFence(client, 'P')
    fence.receive(snapshot)
    const first = deferred<ReportsResponse>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(page('Published'))
    const reading = fence.read(q, fetch)
    fence.receive({ ...snapshot, type: 'content', generation: 1 })
    first.resolve(page())
    expect((await reading).reports[0]?.taskTitle).toBe('Published')
    expect(fetch).toHaveBeenCalledTimes(2)
    client.clear()
  })
  it('repeats the first search fetch when metadata changes before any cache exists', async () => {
    const client = new QueryClient(), fence = new ReportsFence(client, 'P')
    fence.receive(snapshot)
    const first = deferred<ReportsResponse>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(page('New'))
    const reading = fence.read('New', fetch)
    fence.receive(metadata()); first.resolve({ reports: [], total: 0, nextCursor: null })
    expect((await reading).total).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    client.clear()
  })
  it('replays metadata over an older unfiltered response without a list read, then accepts later authoritative fields', async () => {
    const client = new QueryClient(), fence = new ReportsFence(client, 'P')
    fence.receive(snapshot)
    const first = deferred<ReportsResponse>(), fetch = vi.fn(() => first.promise)
    const reading = fence.read('', fetch)
    fence.receive(metadata()); first.resolve(page())
    expect((await reading).reports[0]).toMatchObject({ taskTitle: 'New', taskStatus: 'done' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await fence.read('', async () => page('Later'))).reports[0]?.taskTitle).toBe('Later')
    client.clear()
  })
  it.each([{ ...snapshot, epoch: 'b38758b1-daa2-48e0-a9ac-021da66a264e' }, { ...snapshot, generation: 1 }, { ...snapshot, metadataGeneration: 1 }])('reconciles changed state counters on snapshots', async next => {
    const client = new QueryClient(), fence = new ReportsFence(client, 'P')
    fence.receive(snapshot)
    const started = deferred<void>()
    const fetch = vi.fn(async () => { started.resolve(); return page() })
    client.setQueryData(['P', 'reports', ''], page())
    const observer = new QueryObserver(client, { queryKey: ['P', 'reports', ''], queryFn: fetch, staleTime: Infinity })
    const off = observer.subscribe(() => {})
    fence.receive(next)
    await started.promise
    expect(fetch).toHaveBeenCalledTimes(1)
    off(); client.clear()
  })
})
it('does not replay an old patch over a newer authoritative row when another run changes', () => {
  const client = new QueryClient(), fence = new ReportsFence(client, 'P')
  fence.receive(snapshot); fence.receive(metadata())
  client.setQueryData(['P', 'reports', ''], { pages: [page('Later')], pageParams: [undefined] })
  fence.receive({ ...snapshot, type: 'metadata', metadataGeneration: 2, runs: [{ runId: 'b38758b1-daa2-48e0-a9ac-021da66a264e', taskTitle: 'Other task', taskStatus: 'done' }] })
  expect(client.getQueryData<any>(['P', 'reports', '']).pages[0].reports[0].taskTitle).toBe('Later')
  client.clear()
})

it('reconciles every page when content changes after an earlier page of a shelf fetch completed', async () => {
  const client = new QueryClient(), fence = new ReportsFence(client, 'P')
  fence.receive(snapshot)
  const secondStarted = deferred<void>(), second = deferred<ReportsResponse>(), complete = deferred<void>()
  let changed = false, blocked = false
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ['P', 'reports', ''], staleTime: Infinity,
    initialPageParam: undefined as string | undefined,
    initialData: { pages: [page(), page()], pageParams: [undefined, 'second'] },
    getNextPageParam: (_last, pages) => pages.length === 1 ? 'second' : undefined,
    queryFn: ({ pageParam }) => fence.read('', async () => {
      if (pageParam === 'second' && !blocked) {
        blocked = true; secondStarted.resolve(); return second.promise
      }
      return page(changed ? 'New' : 'Old')
    }),
  })
  const off = observer.subscribe(result => {
    if (result.data?.pages.every(p => p.reports[0]?.taskTitle === 'New')) complete.resolve()
  })
  const reading = observer.refetch()
  await secondStarted.promise
  changed = true; fence.receive({ ...snapshot, type: 'content', generation: 1 })
  second.resolve(page())
  await reading; await complete.promise
  expect(observer.getCurrentResult().data?.pages.map(p => p.reports[0]?.taskTitle)).toEqual(['New', 'New'])
  off(); client.clear()
})
it('checks settled external edits on topic reconnect even with equal counters, without turning unchanged twin polls into list reads', () => {
  const client = new QueryClient(), fence = new ReportsFence(client, 'P')
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  fence.receive(snapshot)
  fence.receive(snapshot)
  expect(invalidate).not.toHaveBeenCalled()
  fence.receive(snapshot, true)
  expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['P', 'reports'], refetchType: 'active' }), { cancelRefetch: false })
  client.clear()
})

it('reconciles a first snapshot that arrives after the initial list response already landed', () => {
  const client = new QueryClient(), fence = new ReportsFence(client, 'P')
  client.setQueryData(['P', 'reports', ''], { pages: [page()], pageParams: [undefined] })
  fence.receive({ ...snapshot, metadataGeneration: 1 })
  expect(client.getQueryState(['P', 'reports', ''])?.isInvalidated).toBe(true)
  client.clear()
})
