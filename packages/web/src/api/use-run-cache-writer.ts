import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createRunCacheWriter } from './run-cache'

/** One writer per query client; callbacks share its transaction methods across renders. */
export function useRunCacheWriter() {
  const client = useQueryClient()
  return useMemo(() => createRunCacheWriter(client), [client])
}
