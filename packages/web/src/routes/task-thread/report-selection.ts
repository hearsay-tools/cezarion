import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useSearchParamsWriter } from '@/lib/use-search-params-writer'

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** URL selection is shared by history restore and card actions. */
export function parseReportSelection(params: URLSearchParams): { artifactId: string; card: string | null } | null {
  const artifactId = params.get('report')
  if (!artifactId || !ARTIFACT_ID.test(artifactId) || params.getAll('report').length !== 1 || params.getAll('card').length > 1) return null
  return { artifactId, card: params.get('card') || null }
}

/** A publication keeps its source run, including an owned worker in the same project. */
export const ReportCardSourcesContext = createContext<{ register: (artifactId: string, runId: string) => () => void; registerOpener: (messageKey: string, restore: (artifactId: string, scrollTop?: number) => void) => () => void } | null>(null)

export function useConversationReport(runId: string | undefined) {
  const location = useLocation()
  const navigate = useNavigate()
  const [params, write] = useSearchParamsWriter()
  const selection = parseReportSelection(params)
  const [sources, setSources] = useState<{ runId: string | undefined; entries: Map<string, string> }>(() => ({ runId, entries: new Map() }))
  if (sources.runId !== runId) setSources({ runId, entries: new Map() })
  const register = useCallback((artifactId: string, sourceRun: string) => {
    setSources(current => {
      if (current.runId === runId && current.entries.get(artifactId) === sourceRun) return current
      const entries = new Map(current.runId === runId ? current.entries : [])
      entries.set(artifactId, sourceRun)
      return { runId, entries }
    })
    // Keep the mapping while the task is mounted: a streaming row can leave the viewport.
    return () => undefined
  }, [runId])
  const openers = useRef({ runId, callbacks: new Map<string, (artifactId: string, scrollTop?: number) => void>() })
  if (openers.current.runId !== runId) openers.current = { runId, callbacks: new Map() }
  const registerOpener = useCallback((messageKey: string, restore: (artifactId: string, scrollTop?: number) => void) => {
    openers.current.callbacks.set(messageKey, restore)
    return () => { if (openers.current.callbacks.get(messageKey) === restore) openers.current.callbacks.delete(messageKey) }
  }, [])
  const registry = useMemo(() => ({ register, registerOpener }), [register, registerOpener])
  const previous = useRef<{ runId: string | undefined; card: string | null; artifactId: string; scrollTop?: number | undefined } | null>(null)
  useEffect(() => {
    if (params.has('report') && !selection) write(next => { next.delete('report'); next.delete('card'); return next })
  }, [params, selection, write])
  useEffect(() => {
    const before = previous.current
    if (!selection && before && before.runId === runId && before.card) {
      openers.current.callbacks.get(before.card)?.(before.artifactId, before.scrollTop)
    }
    previous.current = selection ? { ...selection, runId, scrollTop: (location.state as { reportScrollTop?: number } | null)?.reportScrollTop } : null
  }, [runId, selection, location.state])
  const close = () => {
    const state = location.state as { reportReturnTo?: string; reportReturnKey?: string } | null
    const navigation = (window as { navigation?: { traverseTo: (key: string) => unknown } }).navigation
    if (state?.reportReturnKey && navigation) { void navigation.traverseTo(state.reportReturnKey); return }
    // An engine without top-level Navigation API cannot safely count iframe history entries.
    if (state?.reportReturnTo) { void navigate(state.reportReturnTo, { replace: true }); return }
    write(next => { next.delete('report'); next.delete('card'); return next })
  }
  return { selection, sourceRunId: sources.runId === runId && selection ? (sources.entries.get(selection.artifactId) ?? (selection.card ? undefined : runId)) : undefined, registry, close }
}
