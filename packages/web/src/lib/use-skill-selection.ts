import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putUiState } from '@/api/client'
import { useProjectUiState } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { Skill, TeamSkillRef, UiState } from '@open-mercato/cezar-api-client'
import { teamSkillRefSchema } from '@open-mercato/cezar-api-client/contract/team-skill-ref'

/** The project's switched-off team skills. Mirrors the server's `readDisabledTeamSkills`: a
 *  non-array reads as `[]`, and entries that are not a `{ repo, name }` ref are dropped. */
export function disabledTeamSkills(uiState: UiState | undefined): TeamSkillRef[] {
  const value: unknown = uiState?.disabledTeamSkills
  if (!Array.isArray(value)) return []
  const refs: TeamSkillRef[] = []
  for (const entry of value) {
    const parsed = teamSkillRefSchema.safeParse(entry)
    if (parsed.success) refs.push(parsed.data)
  }
  return refs
}

const sameRef = (a: TeamSkillRef, b: TeamSkillRef) => a.repo === b.repo && a.name === b.name

/** The switch key of a team skill. Only a skill with `team` has one. */
export function teamSkillRef(skill: Skill): TeamSkillRef | undefined {
  return skill.team ? { repo: skill.team.repo, name: skill.name } : undefined
}

/**
 * One row per `{ repo, name }`, in the order given: the switch key has no `ref`, so one repo
 * configured at two refs offers one row and one switch, and the first entry wins. `hiddenBy` names what the catalog shows for that
 * name instead of an ON copy: the winning team skill's repo, or another skill's source. It is
 * unset for an OFF row and when the catalog has no entry for the name yet.
 */
export function teamSkillRows(
  team: readonly Skill[],
  catalog: readonly Skill[],
  isOn: (ref: TeamSkillRef) => boolean,
): Array<{ skill: Skill; on: boolean; hiddenBy?: string }> {
  const winners = new Map<string, Skill>()
  for (const skill of catalog) if (!winners.has(skill.name)) winners.set(skill.name, skill)
  const rows: Array<{ skill: Skill; on: boolean; hiddenBy?: string }> = []
  const seen = new Set<string>()
  for (const skill of team) {
    const ref = teamSkillRef(skill)
    if (!ref) continue
    const key = JSON.stringify([ref.repo, ref.name])
    if (seen.has(key)) continue
    seen.add(key)
    const on = isOn(ref)
    const winner = winners.get(skill.name)
    const winnerRef = winner ? teamSkillRef(winner) : undefined
    if (on && winner && !(winnerRef && sameRef(winnerRef, ref))) {
      rows.push({ skill, on, hiddenBy: winner.team?.repo ?? winner.source })
    } else {
      rows.push({ skill, on })
    }
  }
  return rows
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
 * The team-skill switches of ONE project (hearsay-tools/cezarion#1494). The off-list lives in
 * that project's `ui-state.json` (`disabledTeamSkills`); the server's `discoverSkills` applies
 * it, so this hook only reads and writes the list. A team skill is on unless its
 * `{ repo, name }` is listed, so an absent list means every team skill is on.
 *
 * Every write captures its project id and cache keys when the toggle happens, so a save still
 * queued when the user switches project lands in the project it was made in. Writes run in
 * order per project, and only the newest one reconciles the cache, so a slow older answer never
 * brings back a switch the user has moved past.
 */
export function useTeamSkillSwitches(projectId: string): {
  disabled: readonly TeamSkillRef[]
  isOn: (ref: TeamSkillRef) => boolean
  toggle: (ref: TeamSkillRef) => void
  pending: boolean
  /** The project's stored off-list has loaded. Before it has, a toggle would build on a guess,
   *  so the switches stay disabled. */
  ready: boolean
} {
  const queryClient = useQueryClient()
  const uiState = useProjectUiState(projectId)
  const [inFlight, setInFlight] = React.useState(0)

  const disabled = React.useMemo(() => disabledTeamSkills(uiState.data), [uiState.data])
  const isOn = React.useCallback(
    (ref: TeamSkillRef) => !disabled.some((entry) => sameRef(entry, ref)),
    [disabled],
  )

  const toggle = React.useCallback(
    (ref: TeamSkillRef) => {
      const uiStateKey = [projectId, 'ui-state'] as const
      const skillsKey = [projectId, 'skills'] as const
      // The LATEST cache, not the render's snapshot: a second toggle before the rerender must
      // build on the first.
      const current = queryClient.getQueryData<UiState>(uiStateKey)
      const base = disabledTeamSkills(current)
      const entry = { repo: ref.repo, name: ref.name }
      const next = base.some((item) => sameRef(item, entry))
        ? base.filter((item) => !sameRef(item, entry))
        : [...base, entry]
      queryClient.setQueryData<UiState>(uiStateKey, { ...current, disabledTeamSkills: next })
      const writer = writerFor(projectId)
      const seq = ++writer.latest
      setInFlight((count) => count + 1)
      writer.chain = writer.chain.then(async () => {
        try {
          const merged = await putUiState({ disabledTeamSkills: next }, projectId)
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

  return { disabled, isOn, toggle, pending: inFlight > 0, ready: uiState.isSuccess }
}
