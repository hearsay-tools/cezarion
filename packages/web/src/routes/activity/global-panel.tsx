import * as React from 'react'
import type { ActivityProject } from '@open-mercato/cezar-api-client/contract/activity'
import { Link } from 'react-router'

import { cn } from '@/lib/utils'

import { nameOf, peerWaits, projectNotice, runIndex } from './activity-model'
import { EMPTY_MOTION, waitGhosts, type MotionState } from './activity-motion'
import { ActivityArcs } from './global-arcs'
import { idleLead, panelArcs, panelCounts, panelWaitArcs } from './global-model'
import { ActivityPill } from './global-pill'
import type { NowContext } from './now-box'
import { useWaitHighlight } from './use-wait-highlight'

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

interface PanelProps {
  project: ActivityProject
  now: number
  motion?: MotionState
  paused?: boolean
}

/** The panel's arcs: its open peer requests between two pills, then the closed ones still playing
 *  their reply or fade. */
function useArcs(project: ActivityProject, motion: MotionState) {
  return React.useMemo(() => {
    const open = new Set(project.requests.map((request) => request.requestId))
    const closing = Object.values(motion.closing).filter((ghost) => ghost.projectId === project.projectId && !open.has(ghost.request.requestId)).map((ghost) => ghost.request)
    return panelArcs({ tasks: project.tasks, requests: [...project.requests, ...closing] })
  }, [project, motion.closing])
}

function WorkPanel({ project, now, motion = EMPTY_MOTION, paused = false }: PanelProps) {
  const headingId = React.useId()
  const index = React.useMemo(() => runIndex(project), [project])
  const arcs = useArcs(project, motion)
  const waits = React.useMemo(() => peerWaits(project.tasks), [project.tasks])
  // The panel's wait arcs: its open peer waits between two pills, then the ended ones fading out.
  const waitArcs = React.useMemo(
    () => panelWaitArcs(project.tasks, [...waits, ...waitGhosts(project.projectId, waits, motion)]),
    [project.tasks, project.projectId, waits, motion],
  )
  const highlight = useWaitHighlight(waits)
  const ctx: NowContext = { now, titleOf: (runId) => nameOf(index, runId) }
  const layoutKey = `${project.tasks.map((task) => task.runId).join(',')}:${arcs.map((arc) => arc.requestId).join(',')}:${waitArcs.map((wait) => wait.id).join(',')}`
  const room = arcs.length > 0 || waitArcs.length > 0
  return (
    <section aria-labelledby={headingId} data-slot="activity-panel" data-project={project.projectId} className={PANEL}>
      <PanelHeader project={project} headingId={headingId} detail={panelCounts(project)} to={projectActivityPath(project.projectId)} label="Open project activity →" />
      {/* The arcs rise above the pills: their strip reserves the room above each row. */}
      <div className={cn('relative mt-3', room && 'md:mt-1 md:pt-10')}>
        <ul data-slot="activity-pills" aria-label={`${project.name} tasks`} className={cn('grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] items-start gap-3.5', room && 'md:gap-y-11')}>
          {project.tasks.map((task) => (
            <ActivityPill
              key={task.runId}
              projectId={project.projectId}
              task={task}
              requests={project.requests}
              waits={waits}
              index={index}
              ctx={ctx}
              motion={motion}
              linked={highlight.linked.has(task.runId)}
              onHover={highlight.onHover}
            />
          ))}
        </ul>
        {room ? <ActivityArcs arcs={arcs} waits={waitArcs} active={highlight.active} layoutKey={layoutKey} now={now} motion={motion} paused={paused} /> : null}
      </div>
    </section>
  )
}

export function ProjectPanel(props: PanelProps) {
  const notice = projectNotice(props.project)
  return notice === undefined ? <WorkPanel {...props} /> : <NoticePanel project={props.project} notice={notice} />
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
