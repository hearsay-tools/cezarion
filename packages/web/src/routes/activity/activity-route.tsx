import * as React from 'react'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { useActivityLive } from '@/api/activity-live'
import { Button } from '@/components/ui/button'
import { useActiveProjectId } from '@/lib/project-router'
import { useNow } from '@/lib/use-now'

import { ActivityBoard } from './activity-board'
import { ActivityHeader, ScopeSwitch, SummaryChips } from './activity-header'
import { ActivityLoading } from './activity-loading'
import { projectNotice, summarize } from './activity-model'
import { useActivityMotion } from './use-activity-motion'
import './activity-motion.css'

/**
 * `/p/:projectId/activity` (spec 2026-11-05-live-activity-view, "Project view"): the live
 * snapshot (`useActivityLive`: the topic, or the 5 s re-read without topics) and its motion.
 */

/** The server's clock, ticked once a second on the client. The offset is the server's
 *  `generatedAt` minus the time the client received it. */
export function useServerNow(generatedAt: string | undefined, receivedAt: number): number {
  const now = useNow(1000)
  const at = generatedAt === undefined ? Number.NaN : Date.parse(generatedAt)
  return Number.isNaN(at) || receivedAt === 0 ? now : now + (at - receivedAt)
}

export function ProjectActivityRoute() {
  const scopeId = queryScope()
  const activity = useActivityLive({ kind: 'project', projectId: scopeId })
  const projectId = useActiveProjectId()
  const [watchingSince] = React.useState(() => new Date().toISOString())
  const now = useServerNow(activity.data?.generatedAt, activity.dataUpdatedAt)
  const { motion, feed, reduced, paused } = useActivityMotion(activity.data, scopeId)
  const project = activity.data?.projects[0]

  if (activity.isPending) return <ActivityLoading />
  const notice = project ? projectNotice(project) : undefined
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
    <div data-route="activity" data-activity-paused={paused ? 'true' : undefined} className="flex min-h-full w-full flex-col gap-4 px-[18px] py-6 md:px-7">
      <ActivityHeader name={project.name} now={now} stale={activity.isError}>
        <ScopeSwitch scope="project" projectId={projectId ?? project.projectId} />
      </ActivityHeader>
      <SummaryChips summary={summarize([project])} tasksTo="/" bumps={motion.bumps} />
      {notice ? (
        <p data-slot="activity-project-notice" role="status" className="py-6 text-[13px] text-muted-foreground">{notice}</p>
      ) : (
        <ActivityBoard project={project} now={now} watchingSince={watchingSince} motion={motion} feed={feed} still={reduced} paused={paused} />
      )}
    </div>
  )
}
