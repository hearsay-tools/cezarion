import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { makeRunRecord } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { summaryOf } from '@/test/run-summary-fixture'
import { projectAddress, runAddress } from './run-address'
import { createRunCacheWriter } from './run-cache'
import { configureLiveSession, resetLiveSession } from './live-coordinator'

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

  it('invalidates the run project and the late current scope for continue and send', async () => {
    setApiScope('before')
    const address = runAddress('r', { projectId: 'other' })
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    setApiScope('after')
    await createRunCacheWriter(client).invalidateAfter('continue', address)
    await createRunCacheWriter(client).invalidateAfter('send', address)
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['other', 'runs'] }],
      [{ queryKey: ['after', 'runs'] }],
      [{ queryKey: ['other', 'runs'] }],
      [{ queryKey: ['after', 'runs'] }],
    ])
  })

  it('invalidates the boot slug, its default alias and the late current scope for a boot-project send', async () => {
    configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })
    setApiScope(null)
    const address = runAddress('r', { projectId: 'boot' })
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    setApiScope('next')
    await createRunCacheWriter(client).invalidateAfter('send', address)
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['boot', 'runs'] }],
      [{ queryKey: ['default', 'runs'] }],
      [{ queryKey: ['next', 'runs'] }],
    ])
    resetLiveSession()
  })

  it('invalidates one scope for continue and send inside the run project', async () => {
    setApiScope('same')
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await createRunCacheWriter(client).invalidateAfter('send', runAddress('r'))
    expect(invalidate.mock.calls).toEqual([[{ queryKey: ['same', 'runs'] }]])
  })
})

it('unseen follows late scope reads and restores the full snapshot', async () => {
  setApiScope('before')
  const client = new QueryClient()
  const writer = createRunCacheWriter(client)
  const original = makeRunRecord({ id: 'r', seenAt: 'old', title: 'before' })
  const key = ['before', 'runs', 'detail', 'r']
  client.setQueryData(key, original)
  const patch = await writer.patchRead(() => runAddress('r'), false)
  expect(client.getQueryData(key)).toEqual(expect.not.objectContaining({ seenAt: expect.anything() }))
  setApiScope('after')
  const lateKey = ['after', 'runs', 'detail', 'r']
  client.setQueryData(lateKey, { ...original, title: 'stream' })
  patch.rollback()
  expect(client.getQueryData(lateKey)).toEqual(original)
  patch.settle({ ...original, title: 'old response' })
  expect(client.getQueryData(lateKey)).toEqual({ ...original, seenAt: undefined })
  expect(Object.hasOwn(client.getQueryData(lateKey) as object, 'seenAt')).toBe(false)
  client.clear()
})

it('index writes match both project and run and settle the original three keys', async () => {
  setApiScope('before')
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const entry = { ...summaryOf(makeRunRecord({ id: 'r' })), projectId: 'owner' }
  const previous = { runs: [entry, { ...entry, projectId: 'other' }], referenceStatuses: {}, perProjectLimit: 10, truncated: [] }
  const key = ['workspace', 'runs-index']
  client.setQueryData(key, previous)
  const patch = await createRunCacheWriter(client).patchIndex(runAddress('r', { projectId: 'owner' }), () => run => ({ ...run, archived: true }))
  expect(client.getQueryData(key)).toEqual({ ...previous, runs: [{ ...entry, archived: true }, previous.runs[1]] })
  patch.rollback()
  expect(client.getQueryData(key)).toEqual(previous)
  setApiScope('after')
  patch.settle()
  expect(invalidate.mock.calls).toEqual([
    [{ queryKey: ['workspace', 'runs-index'] }],
    [{ queryKey: ['after', 'runs'] }],
    [{ queryKey: ['owner', 'runs', 'list'] }],
  ])
  client.clear()
})
