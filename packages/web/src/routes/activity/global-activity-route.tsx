import * as React from 'react'

import { useActivity } from '@/api/activity'
import { useHealth, useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { orderProjects } from '@/lib/project-order'
import { useProjectOrder } from '@/lib/use-project-order'

import { ActivityHeader, ScopeSwitch, SummaryChips } from './activity-header'
import { summarize } from './activity-model'
import { useServerNow } from './activity-route'
import { groupProjects, inRailOrder } from './global-model'
import { IdleLine, ProjectPanel } from './global-panel'

/**
 * `/activity`, the global activity view (spec 2026-11-05-live-activity-view, "Global view"),
 * static: one panel for each project with active work or with a notice, in project-rail order,
 * and the loaded idle projects in one line at the bottom. Slice S6 adds motion and the live read.
 */

/** The project ids in the order the rail shows them, once the registry has answered. */
function useRailIds(): string[] | undefined {
  const registry = useProjects().data?.projects
  const { order } = useProjectOrder()
  return React.useMemo(() => (registry ? orderProjects(registry, order).map((project) => project.id) : undefined), [registry, order])
}

export function GlobalActivityRoute() {
  const activity = useActivity('all')
  const projects = useProjects()
  const health = useHealth()
  const railIds = useRailIds()
  const now = useServerNow(activity.data?.generatedAt, activity.dataUpdatedAt)
  const boot = projects.data?.bootProject ?? health.data?.bootProject ?? null
  const snapshot = activity.data?.projects
  const groups = React.useMemo(() => groupProjects(inRailOrder(snapshot ?? [], railIds)), [snapshot, railIds])

  return (
    <div data-route="activity-global" className="flex min-h-full w-full flex-col gap-4 px-[18px] py-6 md:px-7">
      <ActivityHeader name="All projects" generatedAt={activity.data?.generatedAt}>
        <ScopeSwitch scope="all" projectId={boot} />
      </ActivityHeader>
      {snapshot ? <SummaryChips summary={summarize(snapshot)} tasksTo="/tasks" /> : null}
      {/* The header and the scope switch stay while the snapshot loads: the user can switch away. */}
      {activity.isPending ? <p data-slot="activity-loading" role="status" className="text-xs text-muted-foreground">Loading activity…</p> : null}
      {activity.isError ? (
        <div role="alert" className="flex items-center gap-3 text-[13px] text-muted-foreground">
          Could not load activity: {activity.error.message}
          <Button size="sm" variant="outline" onClick={() => void activity.refetch()} className="max-md:min-h-11">Retry</Button>
        </div>
      ) : null}
      {snapshot && groups.panels.length === 0 && groups.idle.length === 0 ? (
        <p data-slot="activity-empty" className="py-6 text-[13px] text-muted-foreground">No projects to show.</p>
      ) : null}
      <div data-slot="activity-panels" className="flex flex-col gap-3.5">
        {groups.panels.map((project) => <ProjectPanel key={project.projectId} project={project} now={now} />)}
      </div>
      <IdleLine projects={groups.idle} belowPanels={groups.panels.length > 0} />
    </div>
  )
}
