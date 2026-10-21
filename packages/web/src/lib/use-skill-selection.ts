import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putUiState } from '@/api/client'
import { useProjectUiState } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { UiState } from '@open-mercato/cezar-api-client'

/** The project's EXPLICIT selection, or `undefined` when it has none (not curated). Mirrors the
 *  server's tri-state `readImportedSkills`: a non-array degrades to `undefined`, and junk entries
 *  inside an array are dropped. */
export function curatedSkillNames(uiState: UiState | undefined): string[] | undefined {
  const value = uiState?.importedSkills
  if (!Array.isArray(value)) return undefined
  return value.filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/** One write chain and one newest-write counter per project, for the whole page lifetime. A
 *  module-level map, so a remount on the same project still queues behind a save in flight. */
const writers = new Map<string, { chain: Promise<void>; latest: number }>()

function writerFor(projectId: string) {
  let writer = writers.get(projectId)
  if (!writer) {
    writer = { chain: Promise.resolve(), latest: 0 }
    writers.set(projectId, writer)
  }
  return writer
}

/**
 * The default-skill selection of ONE project (hearsay-tools/cezarion#1408, port of upstream
 * open-mercato/cezar#1082). It lives in that project's `ui-state.json` (`importedSkills`); the
 * server's `discoverSkills` applies it, so this hook only reads and writes the list.
 *
 * Absent means "not curated": every offered skill is enabled, and the first toggle expands that
 * into an explicit list. Every write captures its project id and cache keys when the toggle
 * happens, so a save still queued when the user switches project lands in the project it was
 * made in. Writes run in order per project, and only the newest one reconciles the cache, so a
 * slow older answer never brings back a selection the user has moved past.
 */
export function useSkillSelection(
  projectId: string,
  importableNames: readonly string[],
): {
  enabled: ReadonlySet<string>
  toggle: (name: string) => void
  pending: boolean
  /** The project's stored selection has loaded. Before it has, a toggle would build on a guess,
   *  so the switches stay disabled. */
  ready: boolean
} {
  const queryClient = useQueryClient()
  const uiState = useProjectUiState(projectId)
  const [inFlight, setInFlight] = React.useState(0)
  // toggle() is a stable callback, but the first curation must expand from the offered names.
  const namesRef = React.useRef(importableNames)
  namesRef.current = importableNames

  const enabled = React.useMemo(
    () => new Set(curatedSkillNames(uiState.data) ?? importableNames),
    [uiState.data, importableNames],
  )

  const toggle = React.useCallback(
    (name: string) => {
      const uiStateKey = [projectId, 'ui-state'] as const
      const skillsKey = [projectId, 'skills'] as const
      // The LATEST cache, not the render's snapshot: a second toggle before the rerender must
      // build on the first.
      const current = queryClient.getQueryData<UiState>(uiStateKey)
      const base = curatedSkillNames(current) ?? [...namesRef.current]
      const next = base.includes(name) ? base.filter((entry) => entry !== name) : [...base, name]
      queryClient.setQueryData<UiState>(uiStateKey, { ...current, importedSkills: next })
      const writer = writerFor(projectId)
      const seq = ++writer.latest
      setInFlight((count) => count + 1)
      writer.chain = writer.chain.then(async () => {
        try {
          const merged = await putUiState({ importedSkills: next }, projectId)
          if (seq === writer.latest) {
            queryClient.setQueryData(uiStateKey, merged)
            // The catalog, the importable list and the composer picker share this prefix.
            void queryClient.invalidateQueries({ queryKey: skillsKey })
          }
        } catch (error: unknown) {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          // The save did not persist: read the stored value back, so the switch reverts.
          if (seq === writer.latest) void queryClient.invalidateQueries({ queryKey: uiStateKey })
        } finally {
          setInFlight((count) => count - 1)
        }
      })
    },
    [projectId, queryClient],
  )

  return { enabled, toggle, pending: inFlight > 0, ready: uiState.isSuccess }
}
