import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { makeRunRecord } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { summaryOf } from '@/test/run-summary-fixture'
import { projectAddress, runAddress } from './run-address'
import { createRunCacheWriter } from './run-cache'

afterEach(() => setApiScope(null))

describe('run cache ownership', () => {
  it.each([
    { name: 'scoped', options: {}, projectId: 'active', scope: 'active' },
    { name: 'explicit', options: { projectId: 'other' }, projectId: 'other', scope: 'other' },
    { name: 'boot', options: { projectId: 'boot', boot: true }, projectId: 'boot', scope: 'default' },
    { name: 'project switch mid-flight', options: {}, projectId: 'active', scope: 'active' },
  ])('$name keeps receipt writes and rollback in the captured cache', async ({ name, options, projectId, scope }) => {
    setApiScope('active')
    const address = runAddress('r', options)
    expect(address).toEqual({ projectId, cacheScope: scope, runId: 'r' })
    expect(projectAddress(options)).toEqual({ projectId, cacheScope: scope })
    const client = new QueryClient()
    const writer = createRunCacheWriter(client)
    const original = makeRunRecord({ id: 'r', title: 'before' })
    const list = [scope, 'runs', 'list']
    const detail = [scope, 'runs', 'detail', 'r']
    client.setQueryData(list, [summaryOf(original)])
    client.setQueryData(detail, original)
    const pending = writer.patchRead(address, true)
    if (name === 'project switch mid-flight') setApiScope('next')
    const patch = await pending
    expect(client.getQueryData<ReturnType<typeof makeRunRecord>>(detail)?.seenAt).toEqual(expect.any(String))
    client.setQueryData(detail, { ...client.getQueryData(detail), title: 'stream' })
    patch.rollback()
    expect(client.getQueryData(detail)).toEqual({ ...original, title: 'stream' })
    patch.settle({ ...original, seenAt: 'server' })
    expect(client.getQueryData(detail)).toEqual({ ...original, title: 'stream', seenAt: 'server' })
    expect(client.getQueryData(['next', 'runs', 'detail', 'r'])).toBeUndefined()
    client.clear()
  })

  it('retains late current-scope invalidation for continue and send', async () => {
    setApiScope('before')
    const address = runAddress('r', { projectId: 'other' })
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    setApiScope('after')
    await createRunCacheWriter(client).invalidateAfter('continue', address)
    await createRunCacheWriter(client).invalidateAfter('send', address)
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['after', 'runs'] }],
      [{ queryKey: ['after', 'runs'] }],
    ])
  })
})
