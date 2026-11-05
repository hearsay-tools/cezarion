import { ChevronRightIcon } from 'lucide-react'
import type { ActivityProject } from '@open-mercato/cezar-api-client/contract/activity'
import { Link } from 'react-router'

import { useActivity } from '@/api/activity'
import { useHealth, useProjects } from '@/api/queries'

import { ActivityHeader, ScopeSwitch } from './activity-header'
import { projectNotice } from './activity-model'

/**
 * `/activity`, the global activity view (spec 2026-11-05-live-activity-view, "Global view").
 * Slice S5 routes it so `LegacyPathRedirect` does not send it to the boot project, and lists every
 * project of the global snapshot with a link to its activity. Slice S7 replaces the list with the
 * project panels.
 */

function stateLine(project: ActivityProject): string {
  const notice = projectNotice(project)
  if (notice) return notice
  const count = project.tasks.length
  return count === 0 ? 'No active work' : `${count} active task${count === 1 ? '' : 's'}`
}

function ProjectRow({ project }: { project: ActivityProject }) {
  return (
    <li data-slot="activity-project" data-project={project.projectId} data-loaded={project.loaded ? 'true' : 'false'}>
      <Link
        to={`/p/${encodeURIComponent(project.projectId)}/activity`}
        className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 text-[13px] hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{project.name}</span>
          <span data-slot="activity-project-state" className="block truncate text-[12px] text-muted-foreground">{stateLine(project)}</span>
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">Open project activity</span>
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  )
}

export function GlobalActivityRoute() {
  const activity = useActivity('all')
  const projects = useProjects()
  const health = useHealth()
  const boot = projects.data?.bootProject ?? health.data?.bootProject ?? null
  return (
    <div data-route="activity-global" className="flex min-h-full w-full flex-col gap-4 px-[18px] py-6 md:px-7">
      <ActivityHeader name="All projects" generatedAt={activity.data?.generatedAt}>
        <ScopeSwitch scope="all" projectId={boot} />
      </ActivityHeader>
      {activity.isPending ? <p role="status" className="text-xs text-muted-foreground">Loading activity…</p> : null}
      {activity.isError ? <p role="alert" className="text-[13px] text-muted-foreground">Could not load activity: {activity.error.message}</p> : null}
      <ul data-slot="activity-projects" className="flex max-w-xl flex-col gap-2">
        {activity.data?.projects.map((project) => <ProjectRow key={project.projectId} project={project} />)}
      </ul>
    </div>
  )
}
