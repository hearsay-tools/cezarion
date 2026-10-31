import type { QueryClient } from '@tanstack/react-query'
import type { RunRecord, RunSummary, RunIndexEntry, RunsIndexResponse } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { ProjectAddress, RunAddress } from './run-address'
import { liveBootProject } from './live-coordinator'

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
  /**
   * Mark the WORKSPACE run index stale after a change to one run's read state.
   *
   * The index (`GET /workspace/runs-index`) is a third cache, independent of the project-scoped
   * run list and detail these mutations patch, and it has a 30s staleTime. Without this, opening an
   * unread task from the global Tasks page and coming straight back showed it STILL unread until
   * the next poll or a refresh — which reads as "the click did not work".
   *
   * Invalidate rather than patch, deliberately. Patching would need the run's project id (the index
   * keys on `projectId + id`, because a run id is only unique inside one project), and this
   * mutation knows a run only by id — deriving the project from the router would couple a data hook
   * to a `<Router>` that its own unit tests, and any non-routed caller, do not provide. Nothing is
   * observing the index while you are in a thread, so this costs no request: it simply means the
   * global page's next mount reads the truth instead of a stale snapshot.
   */
  const invalidateIndex = () => { void client.invalidateQueries({ queryKey: indexKey }) }

  /**
   * continue/send refresh the run's OWN project and the CURRENT scope (hearsay-tools/cezarion#2327).
   * An explicit-project request comes from All tasks, whose Resolve conflicts button reads the
   * run under its own project: refreshing only the current scope left that record claiming a
   * session the server had closed. The current scope stays, read at callback time, as before.
   * A boot-project target also names its `'default'` alias, which its own mounted thread reads.
   */
  function invalidateAfter(action: 'runs' | 'continue' | 'send' | 'index' | 'indexed', address: ProjectAddress | (() => ProjectAddress)) {
    if (action === 'index') return invalidateIndex()
    const target = typeof address === 'function' ? address() : address
    if (action === 'indexed') {
      invalidateIndex()
      void client.invalidateQueries({ queryKey: [queryScope(), 'runs'] })
      void client.invalidateQueries({ queryKey: [target.projectId, 'runs', 'list'] })
      return
    }
    if (action === 'runs') return client.invalidateQueries({ queryKey: [target.cacheScope, 'runs'] })
    const alias = target.projectId === liveBootProject() ? ['default'] : []
    const scopes = new Set([target.projectId, target.cacheScope, ...alias, queryScope()])
    return Promise.all([...scopes].map(scope => client.invalidateQueries({ queryKey: [scope, 'runs'] })))
      .then(() => undefined)
  }

  async function patchRead(source: AddressSource, read: boolean) {
    // These keys were captured synchronously by mutate/mutateAsync, before React Query
    // awaits its own callbacks or cancellation. Navigation cannot retarget any phase.
    // Unseen instead intentionally re-reads scope at every old callback boundary.
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
        // Roll back only the receipt. The stream may have advanced unrelated fields or
        // inserted another run while the request was in flight; those changes belong to it.
        const previous = prevList?.find(run => run.id === id)
        if (previous) client.setQueryData<RunSummary[]>(listKey(resolve(source)), list =>
          list?.map(run => run.id === id ? restoreReceipt(run, previous) : run))
        if (prevDetail) client.setQueryData<RunRecord>(detailKey(resolve(source)), run => run ? restoreReceipt(run, prevDetail) : run)
      },
      settle(updated: RunRecord) {
        // A receipt response is an older snapshot: accept its receipt only, preserving
        // newer stream fields such as autoResumeAt and token totals (#auto-resume).
        const stamp = <T extends { id: string; seenAt?: string | undefined }>(run: T): T =>
          run.id === (read ? id : updated.id) ? patchReceipt(run, read, updated.seenAt) : run
        client.setQueryData<RunSummary[]>(listKey(resolve(source)), list => list?.map(stamp))
        const target = { ...resolve(source), runId: read ? id : updated.id }
        client.setQueryData<RunRecord>(detailKey(target), current => current ? stamp(current) : updated)
        invalidateIndex()
      },
    }
  }

  async function patchIndex(address: RunAddress, patch: () => (run: RunIndexEntry) => RunIndexEntry) {
    await client.cancelQueries({ queryKey: indexKey })
    const previous = client.getQueryData<RunsIndexResponse>(indexKey)
    const apply = patch()
    client.setQueryData<RunsIndexResponse>(indexKey, current => current === undefined ? current : {
      ...current,
      runs: current.runs.map(run => run.projectId === address.projectId && run.id === address.runId ? apply(run) : run),
    })
    return {
      previous,
      rollback() { if (previous) client.setQueryData(indexKey, previous) },
      settle() {
        // Preserve both old spellings, including the late current-scope prefix.
        invalidateAfter('indexed', address)
      },
    }
  }

  return { patchRead, patchIndex, invalidateAfter }
}

export type ReadPatch = Awaited<ReturnType<ReturnType<typeof createRunCacheWriter>['patchRead']>>
