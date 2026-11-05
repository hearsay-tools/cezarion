import { ChevronRightIcon } from 'lucide-react'
import { Link } from 'react-router'

import { useHealth, useProjects } from '@/api/queries'

import { ActivityHeader, ScopeSwitch } from './activity-header'

/**
 * `/activity`, the global activity view (spec 2026-11-05-live-activity-view, "Global view").
 * Slice S5 routes it so `LegacyPathRedirect` does not send it to the boot project, and lists the
 * projects with a link to each one's activity. Slice S7 replaces this list with the project panels.
 */
export function GlobalActivityRoute() {
  const projects = useProjects()
  const health = useHealth()
  const boot = projects.data?.bootProject ?? health.data?.bootProject ?? null
  const list = projects.data?.projects ?? []
  return (
    <div data-route="activity-global" className="flex min-h-full w-full flex-col gap-4 px-[18px] py-6 md:px-7">
      <ActivityHeader name="All projects">
        <ScopeSwitch scope="all" projectId={boot} />
      </ActivityHeader>
      {projects.isPending ? <p role="status" className="text-xs text-muted-foreground">Loading projects…</p> : null}
      {projects.isError ? <p role="alert" className="text-[13px] text-muted-foreground">Could not load the project list.</p> : null}
      <ul data-slot="activity-projects" className="flex max-w-xl flex-col gap-2">
        {list.map((project) => (
          <li key={project.id}>
            <Link
              to={`/p/${encodeURIComponent(project.id)}/activity`}
              className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 text-[13px] hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
              <span className="text-[12px] text-muted-foreground">Open project activity</span>
              <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
