import { QueryObserver } from '@tanstack/react-query'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { afterEach, describe, expect, it } from 'vitest'

import { createQueryClient } from './query-client'
import { queryKeys } from './queries'
import { createRunDetailFetcher } from './run-detail-refresh'

const key = queryKeys.runs.detail('r1')
const run = (finishBlocked: string | null): ApiRun => ({
  id: 'r1', title: 'r1', workflow: 'quick-task', task: 't', status: RUN_STATUS.waiting,
  createdAt: '2026-11-06T10:00:00.000Z', tokensUsed: 0, archived: false, steps: [], finishBlocked,
})

function deferred() {
  let resolve!: (value: ApiRun) => void
  const promise = new Promise<ApiRun>((done) => { resolve = done })
  return { promise, resolve }
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A cached detail with a fetch in flight that started before the event, and a disabled reader. */
function setup() {
  const client = createQueryClient()
  const responses = [deferred(), deferred()]
  let reads = 0
  const queryFn = () => responses[reads++]!.promise
  client.setQueryData(key, run(null))
  const observer = new QueryObserver<ApiRun>(client, { queryKey: key, queryFn, enabled: false })
  cleanups.push(observer.subscribe(() => undefined))
  void client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
  const fetcher = createRunDetailFetcher(client)
  cleanups.push(() => fetcher.cancel())
  fetcher.onEvent('r1')
  const enable = () => observer.setOptions({ queryKey: key, queryFn, enabled: true })
  return { client, responses, reads: () => reads, enable }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a pre-event fetch of a detail without an enabled reader (hearsay-tools/cezarion#2730)', () => {
  it('stays stale after the old response, so a reader enabled later fetches once', async () => {
    const { client, responses, reads, enable } = setup()
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    responses[0]!.resolve(run(null))
    await settle()
    // The old response lands without its verdict, and the detail is still stale.
    expect(client.getQueryData<ApiRun>(key)?.finishBlocked).toBeUndefined()
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(reads()).toBe(1)
    enable()
    expect(reads()).toBe(2)
    responses[1]!.resolve(run('Wait for the worker.'))
    await settle()
    expect(client.getQueryData<ApiRun>(key)?.finishBlocked).toBe('Wait for the worker.')
  })

  it('fetches once more when its reader is enabled before the old response settles', async () => {
    const { client, responses, reads, enable } = setup()
    enable()
    // The old fetch is still in flight: the enabled reader shares it rather than starting another.
    expect(reads()).toBe(1)
    responses[0]!.resolve(run(null))
    await settle()
    expect(reads()).toBe(2)
    expect(client.getQueryData<ApiRun>(key)?.finishBlocked).toBeUndefined()
    responses[1]!.resolve(run(null))
    await settle()
    expect(client.getQueryData<ApiRun>(key)?.finishBlocked).toBeNull()
    expect(reads()).toBe(2)
  })
})
