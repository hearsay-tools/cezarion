import * as React from 'react'

import { useActivity } from '@/api/activity'
import { Button } from '@/components/ui/button'
import { useActiveProjectId } from '@/lib/project-router'
import { useNow } from '@/lib/use-now'

import { ActivityBoard } from './activity-board'
import { ActivityHeader, ScopeSwitch, SummaryChips } from './activity-header'
import { ActivityLoading } from './activity-loading'
import { summarize } from './activity-model'

/**
 * `/p/:projectId/activity` (spec 2026-11-05-live-activity-view, "Project view"), static: slice S5
 * reads the snapshot once; slice S4 makes it live and slice S6 adds the motion.
 */

/** The server's clock, ticked once a second on the client. The offset is the server's
 *  `generatedAt` minus the time the client received it. */
export function useServerNow(generatedAt: string | undefined, receivedAt: number): number {
  const now = useNow(1000)
  const at = generatedAt === undefined ? Number.NaN : Date.parse(generatedAt)
  return Number.isNaN(at) || receivedAt === 0 ? now : now + (at - receivedAt)
}

export function ProjectActivityRoute() {
  const activity = useActivity('project')
  const projectId = useActiveProjectId()
  const [watchingSince] = React.useState(() => new Date().toISOString())
  const now = useServerNow(activity.data?.generatedAt, activity.dataUpdatedAt)
  const project = activity.data?.projects[0]

  if (activity.isPending) return <ActivityLoading />
  if (!project) {
    return (
      <div data-route="activity" className="min-h-full w-full px-[18px] py-6 md:px-7">
        <ActivityHeader name={projectId ?? 'project'}><ScopeSwitch scope="project" projectId={projectId} /></ActivityHeader>
        <div role="alert" className="mt-6 flex items-center gap-3 text-[13px] text-muted-foreground">
          {activity.error ? `Could not load activity: ${activity.error.message}` : 'This project has no activity snapshot.'}
          <Button size="sm" variant="outline" onClick={() => void activity.refetch()} className="max-md:min-h-11">Retry</Button>
        </div>
      </div>
    )
  }
  return (
    <div data-route="activity" className="flex min-h-full w-full flex-col gap-4 px-[18px] py-6 md:px-7">
      <ActivityHeader name={project.name} generatedAt={activity.data?.generatedAt}>
        <ScopeSwitch scope="project" projectId={projectId ?? project.projectId} />
      </ActivityHeader>
      <SummaryChips summary={summarize([project])} tasksTo="/" />
      <ActivityBoard project={project} now={now} watchingSince={watchingSince} />
    </div>
  )
}
