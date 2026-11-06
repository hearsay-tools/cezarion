import * as React from 'react'
import type { ActivityProject } from '@open-mercato/cezar-api-client/contract/activity'
import { Link } from 'react-router'

import { cn } from '@/lib/utils'

import { nameOf, projectNotice, runIndex } from './activity-model'
import { ActivityArcs } from './global-arcs'
import { idleLead, panelArcs, panelCounts } from './global-model'
import { ActivityPill } from './global-pill'
import type { NowContext } from './now-box'

/**
 * The global view's project panels and its idle line (spec 2026-11-05-live-activity-view,
 * "Global view"): a panel of pills for a project with active work, a notice panel for a project
 * that is not loaded or not available, and one line for the loaded projects with no active work.
 */

const projectActivityPath = (projectId: string) => `/p/${encodeURIComponent(projectId)}/activity`
const projectPath = (projectId: string) => `/p/${encodeURIComponent(projectId)}/`

const PANEL = 'rounded-xl border border-border bg-card px-4 pt-3.5 pb-4'
const HEADER_LINK = 'ml-auto inline-flex items-center text-[12px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11'

function PanelHeader({ project, headingId, detail, to, label }: { project: ActivityProject; headingId: string; detail: string; to: string; label: string }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id={headingId} className="min-w-0 truncate text-[14px] font-semibold">{project.name}</h2>
      <span data-slot="activity-panel-detail" className="text-[12px] text-muted-foreground">{detail}</span>
      <Link to={to} className={HEADER_LINK}>{label}</Link>
    </header>
  )
}

/** A project whose lists cannot be trusted: its notice and a link that opens the project. */
function NoticePanel({ project, notice }: { project: ActivityProject; notice: string }) {
  const headingId = React.useId()
  return (
    <section aria-labelledby={headingId} data-slot="activity-panel" data-project={project.projectId} data-notice="true" className={PANEL}>
      <PanelHeader project={project} headingId={headingId} detail={notice} to={projectPath(project.projectId)} label="Open project →" />
    </section>
  )
}

function WorkPanel({ project, now }: { project: ActivityProject; now: number }) {
  const headingId = React.useId()
  const index = React.useMemo(() => runIndex(project), [project])
  const arcs = React.useMemo(() => panelArcs(project), [project])
  const ctx: NowContext = { now, titleOf: (runId) => nameOf(index, runId) }
  const layoutKey = project.tasks.map((task) => task.runId).join(',')
  return (
    <section aria-labelledby={headingId} data-slot="activity-panel" data-project={project.projectId} className={PANEL}>
      <PanelHeader project={project} headingId={headingId} detail={panelCounts(project)} to={projectActivityPath(project.projectId)} label="Open project activity →" />
      {/* The arcs rise above the pills: their strip reserves the room above each row. */}
      <div className={cn('relative mt-3', arcs.length > 0 && 'md:mt-1 md:pt-10')}>
        <ul data-slot="activity-pills" aria-label={`${project.name} tasks`} className={cn('grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] items-start gap-3.5', arcs.length > 0 && 'md:gap-y-11')}>
          {project.tasks.map((task) => <ActivityPill key={task.runId} projectId={project.projectId} task={task} requests={project.requests} index={index} ctx={ctx} />)}
        </ul>
        {arcs.length > 0 ? <ActivityArcs arcs={arcs} layoutKey={layoutKey} now={now} /> : null}
      </div>
    </section>
  )
}

export function ProjectPanel({ project, now }: { project: ActivityProject; now: number }) {
  const notice = projectNotice(project)
  return notice === undefined ? <WorkPanel project={project} now={now} /> : <NoticePanel project={project} notice={notice} />
}

/** The loaded projects with no active work, each a link to its activity. */
export function IdleLine({ projects, belowPanels }: { projects: readonly ActivityProject[]; belowPanels: boolean }) {
  if (projects.length === 0) return null
  return (
    <p data-slot="activity-idle" className="text-[12.5px] text-muted-foreground">
      {idleLead(projects.length, belowPanels)}{' '}
      {projects.map((project, i) => (
        <React.Fragment key={project.projectId}>
          {i > 0 ? ', ' : null}
          <Link to={projectActivityPath(project.projectId)} data-project={project.projectId} className="text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:inline-flex max-md:min-h-11 max-md:items-center">
            {project.name}
          </Link>
        </React.Fragment>
      ))}
    </p>
  )
}
