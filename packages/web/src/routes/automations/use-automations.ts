import { useCallback, useEffect, useState } from 'react'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import { onWorkspaceEvent } from '@/api/global-events'
import { getAutomations } from '@/api/client'
import { useHealth } from '@/api/queries'
import { useActiveProjectId } from '@/lib/project-router'

/**
 * The automations list for the project on screen: one fetch once health says the capability is
 * on, refreshed by the workspace `automation-change` signal and by `refresh()`.
 *
 * Waits for health rather than firing optimistically: a fetch made before the answer arrives
 * would 409 on a gated server and paint an error over the disabled state. The effect depends on
 * two booleans, not `health.data`, so a health refetch does not re-request the list.
 */
export function useAutomations(): {
  data: AutomationsResponse | undefined
  error: string
  refresh: () => Promise<void>
} {
  const projectId = useActiveProjectId()
  const health = useHealth()
  const healthKnown = health.data !== undefined
  const off = healthKnown && health.data.capabilities?.automations !== true
  const [data, setData] = useState<AutomationsResponse>()
  const [error, setError] = useState('')
  const refresh = useCallback(
    () => getAutomations().then((next) => { setData(next); setError('') }).catch((cause) => setError(String(cause))),
    [],
  )
  useEffect(() => { if (healthKnown && !off) void refresh() }, [healthKnown, off, refresh])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name !== 'automation-change') return
    const changed = payload as { project?: unknown }
    if (typeof changed.project === 'string' && (projectId === null || changed.project === projectId)) void refresh()
  }), [projectId, refresh])
  return { data, error, refresh }
}
