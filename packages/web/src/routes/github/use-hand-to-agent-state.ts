import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { useProjectScope } from '@/api/project-scope-context'
import { useSkills, useUiState, useWorkflows } from '@/api/queries'
import type { EnginePick } from '@/components/engine-pills'
import { orderSkillsByUsage } from '@/lib/skills'

import { readFollowupSelection, writeFollowupSelection } from './hand-to-agent-draft'

interface HandToAgentState {
  workflow: string | null
  selectedSkills: readonly string[]
  engine: EnginePick
  queued: ReadonlyMap<string, string>
}

// QueryClient owns the cockpit lifetime, but this is UI state: subscribers must update
// synchronously so two rapid picker actions cannot read a stale selection.
const sessions = new WeakMap<QueryClient, Map<string | null, ReturnType<typeof createSession>>>()

function createSession() {
  const selection = readFollowupSelection()
  let state: HandToAgentState = {
    workflow: selection.workflow,
    selectedSkills: selection.skills,
    engine: { runner: null, model: null, effort: null, account: null },
    queued: new Map(),
  }
  const listeners = new Set<() => void>()
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (patch: Partial<HandToAgentState>) => {
      state = { ...state, ...patch }
      if (patch.workflow !== undefined || patch.selectedSkills !== undefined) {
        writeFollowupSelection({ workflow: state.workflow, skills: [...state.selectedSkills] })
      }
      listeners.forEach((listener) => listener())
    },
  }
}

/** Project-scoped session shared across route unmounts. Only workflow/skills survive reloads. */
export function useHandToAgentState() {
  const client = useQueryClient()
  const { projectId } = useProjectScope()
  let projects = sessions.get(client)
  if (!projects) sessions.set(client, projects = new Map())
  let session = projects.get(projectId)
  if (!session) projects.set(projectId, session = createSession())
  const { snapshot, subscribe, update } = session
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const workflows = useWorkflows()
  const skills = useSkills()
  const uiState = useUiState()
  const workflowDefs = workflows.data?.workflows
  useEffect(() => {
    // An unresolved catalog is not evidence that a remembered workflow disappeared.
    if (workflowDefs && state.workflow !== null && !workflowDefs.some((def) => def.name === state.workflow)) {
      update({ workflow: null })
    }
  }, [update, workflowDefs, state.workflow])
  const skillList = useMemo(
    () => orderSkillsByUsage(skills.data ?? [], uiState.data?.skillUsage),
    [skills.data, uiState.data?.skillUsage],
  )
  return {
    ...state,
    workflows,
    skillList,
    setWorkflow: (workflow: string | null) => update({ workflow }),
    setSelectedSkills: (selectedSkills: readonly string[]) => update({ selectedSkills }),
    setEngine: (engine: EnginePick) => update({ engine }),
    onQueued: (url: string, runId: string) => update({ queued: new Map(snapshot().queued).set(url, runId) }),
  }
}
