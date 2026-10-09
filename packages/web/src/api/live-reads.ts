import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeLive } from './live-coordinator'
import { allowedLiveRead } from './live-protocol'

export function subscribeLiveRead(input: { path: string; intervalMs: number }, onResult: (value: unknown, error?: string) => void): () => void {
  if (!allowedLiveRead(input.path)) throw new Error('unsupported shared read')
  const url = new URL(input.path, 'http://cezar.invalid')
  url.searchParams.sort()
  return subscribeLive({ kind: 'read', path: `${url.pathname}${url.search}`, intervalMs: input.intervalMs }, { value: onResult })
}

/** Initial reads/mutations stay in QueryClient; only explicitly recurring demand is shared. */
export function useLiveRead(path: string | undefined, key: readonly unknown[], intervalMs: number | false): void {
  const client = useQueryClient()
  const signature = JSON.stringify(key)
  const stableKey = useMemo(() => JSON.parse(signature) as unknown[], [signature])
  useEffect(() => {
    if (!path || intervalMs === false) return
    let active = true
    const release = subscribeLiveRead({ path, intervalMs }, (value, error) => {
      if (error) return
      // A stale document-local request must not overwrite the owner's newer snapshot.
      void client.cancelQueries({ queryKey: stableKey, exact: true }).then(() => {
        if (active) client.setQueryData(stableKey, value)
      })
    })
    return () => { active = false; release() }
  }, [client, path, stableKey, intervalMs])
}
