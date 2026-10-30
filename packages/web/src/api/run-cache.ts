import type { QueryClient } from '@tanstack/react-query'
import type { RunRecord, RunSummary, RunIndexEntry, RunsIndexResponse } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { ProjectAddress, RunAddress } from './run-address'

const indexKey = ['workspace', 'runs-index'] as const
const listKey = (address: ProjectAddress) => [address.cacheScope, 'runs', 'list'] as const
const detailKey = (address: RunAddress) => [address.cacheScope, 'runs', 'detail', address.runId] as const
export type AddressSource = RunAddress | (() => RunAddress)
const resolve = (source: AddressSource) => typeof source === 'function' ? source() : source

/** A copy with the receipt absent, matching the server and isUnread. */
function withoutReceipt<T extends { seenAt?: string | undefined }>(run: T): T {
  const { seenAt: _dropped, ...rest } = run
  return rest as T
}

function restoreReceipt<T extends { seenAt?: string | undefined }>(current: T, previous: { seenAt?: string | undefined }): T {
  const rest = withoutReceipt(current)
  return previous.seenAt === undefined ? rest : { ...rest, seenAt: previous.seenAt }
}

function patchReceipt<T extends { seenAt?: string | undefined }>(run: T, read: boolean, seenAt?: string): T {
  return read ? { ...run, seenAt } : withoutReceipt(run)
}

/** Own each cache transaction, including its rollback and reconciliation order. */
export function createRunCacheWriter(client: QueryClient) {
  const invalidateIndex = () => { void client.invalidateQueries({ queryKey: indexKey }) }

  /** continue/send deliberately invalidate the CURRENT scope, even for explicit-project requests. */
  function invalidateAfter(action: 'runs' | 'continue' | 'send' | 'index', address: ProjectAddress | (() => ProjectAddress)) {
    if (action === 'index') return invalidateIndex()
    const scope = action === 'continue' || action === 'send'
      ? queryScope()
      : (typeof address === 'function' ? address() : address).cacheScope
    return client.invalidateQueries({ queryKey: [scope, 'runs'] })
  }

  async function patchRead(source: AddressSource, read: boolean) {
    // Seen captures at mutate; unseen intentionally re-reads scope at every old callback boundary.
    await client.cancelQueries({ queryKey: listKey(resolve(source)) })
    await client.cancelQueries({ queryKey: detailKey(resolve(source)) })
    const prevList = client.getQueryData<RunSummary[]>(listKey(resolve(source)))
    const prevDetail = client.getQueryData<RunRecord>(detailKey(resolve(source)))
    const id = resolve(source).runId
    const now = new Date().toISOString()
    client.setQueryData<RunSummary[]>(listKey(resolve(source)), list =>
      list?.map(run => run.id === id ? patchReceipt(run, read, now) : run))
    client.setQueryData<RunRecord>(detailKey(resolve(source)), run => run ? patchReceipt(run, read, now) : run)
    return {
      id, prevList, prevDetail,
      rollback() {
        if (!read) {
          if (prevList) client.setQueryData(listKey(resolve(source)), prevList)
          if (prevDetail) client.setQueryData(detailKey(resolve(source)), prevDetail)
          return
        }
        const previous = prevList?.find(run => run.id === id)
        if (previous) client.setQueryData<RunSummary[]>(listKey(resolve(source)), list =>
          list?.map(run => run.id === id ? restoreReceipt(run, previous) : run))
        if (prevDetail) client.setQueryData<RunRecord>(detailKey(resolve(source)), run => run ? restoreReceipt(run, prevDetail) : run)
      },
      settle(updated: RunRecord) {
        const stamp = <T extends { id: string; seenAt?: string | undefined }>(run: T): T =>
          run.id === (read ? id : updated.id) ? patchReceipt(run, read, updated.seenAt) : run
        client.setQueryData<RunSummary[]>(listKey(resolve(source)), list => list?.map(stamp))
        const target = { ...resolve(source), runId: read ? id : updated.id }
        client.setQueryData<RunRecord>(detailKey(target), current => current ? stamp(current) : updated)
        invalidateIndex()
      },
    }
  }

  async function patchIndex(address: RunAddress, apply: (run: RunIndexEntry) => RunIndexEntry) {
    await client.cancelQueries({ queryKey: indexKey })
    const previous = client.getQueryData<RunsIndexResponse>(indexKey)
    client.setQueryData<RunsIndexResponse>(indexKey, current => current === undefined ? current : {
      ...current,
      runs: current.runs.map(run => run.projectId === address.projectId && run.id === address.runId ? apply(run) : run),
    })
    return {
      previous,
      rollback() { if (previous) client.setQueryData(indexKey, previous) },
      settle() {
        invalidateIndex()
        // Preserve both old spellings, including the late current-scope prefix.
        void client.invalidateQueries({ queryKey: [queryScope(), 'runs'] })
        void client.invalidateQueries({ queryKey: [address.projectId, 'runs', 'list'] })
      },
    }
  }

  return { patchRead, patchIndex, invalidateAfter }
}

export type ReadPatch = Awaited<ReturnType<ReturnType<typeof createRunCacheWriter>['patchRead']>>
