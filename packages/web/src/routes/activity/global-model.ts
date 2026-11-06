import type { ActivityProject, ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { projectNotice, type PeerWait } from './activity-model'
import { isLiveStatus } from './now-box'

/**
 * What the global view (`/activity`, spec 2026-11-05-live-activity-view, "Global view") derives
 * from the snapshot: the project order, which projects get a panel, which collapse into the idle
 * line, and which open requests are a panel's arcs. Pure.
 */

/**
 * The snapshot's projects in project-rail order. `railIds` is the registry after the hand-picked
 * order (`orderProjects`), the order the rail shows. A project the rail does not list yet (the
 * registry has not answered, or the project left it) keeps its snapshot order, after the others.
 */
export function inRailOrder(projects: readonly ActivityProject[], railIds: readonly string[] | undefined): ActivityProject[] {
  if (!railIds || railIds.length === 0) return [...projects]
  const rank = new Map(railIds.map((id, i) => [id, i]))
  const listed = projects.filter((project) => rank.has(project.projectId))
  const rest = projects.filter((project) => !rank.has(project.projectId))
  listed.sort((a, b) => (rank.get(a.projectId) ?? 0) - (rank.get(b.projectId) ?? 0))
  return [...listed, ...rest]
}

export interface GlobalGroups {
  /** One panel each, in the given order: projects with active work, and projects whose lists
   *  cannot be trusted (`loaded: false` or `unavailable`) with their notice. */
  panels: ActivityProject[]
  /** Loaded, readable projects with no active work: one line at the bottom. */
  idle: ActivityProject[]
}

/**
 * Split the projects into panels and the idle line. A project that is not loaded or not
 * available never joins the idle line: the view does not know whether it is idle.
 */
export function groupProjects(projects: readonly ActivityProject[]): GlobalGroups {
  const panels: ActivityProject[] = []
  const idle: ActivityProject[] = []
  for (const project of projects) {
    if (projectNotice(project) === undefined && project.tasks.length === 0) idle.push(project)
    else panels.push(project)
  }
  return { panels, idle }
}

/**
 * The open requests a panel draws as arcs: peer requests between two of its own pills. Peer
 * messages never cross projects, and a request whose other end has no pill has nothing to arc to,
 * so an arc never leaves its panel. The pills still carry the text form of every request.
 */
export function panelArcs(project: Pick<ActivityProject, 'tasks' | 'requests'>): ActivityRequest[] {
  const pills = new Set(project.tasks.map((task) => task.runId))
  return project.requests.filter((request) => request.relationship === 'peer' && pills.has(request.senderRunId) && pills.has(request.recipientRunId))
}

/** The peer waits a panel draws as arcs: those between two of its own pills. */
export function panelWaitArcs(tasks: readonly { runId: string }[], waits: readonly PeerWait[]): PeerWait[] {
  const pills = new Set(tasks.map((task) => task.runId))
  return waits.filter((wait) => pills.has(wait.waiterRunId) && pills.has(wait.peerRunId))
}

/** "3 active tasks · 2 workers": the panel header's count of pills and live workers. */
export function panelCounts(project: Pick<ActivityProject, 'tasks'>): string {
  const tasks = project.tasks.length
  const workers = project.tasks.reduce((sum, task) => sum + task.workers.filter((worker) => isLiveStatus(worker.status)).length, 0)
  const parts = [`${tasks} active task${tasks === 1 ? '' : 's'}`]
  if (workers > 0) parts.push(`${workers} worker${workers === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** The idle line's lead: "2 more projects have no active work:" below panels, "1 project has no
 *  active work:" when it is the only line. */
export function idleLead(count: number, belowPanels: boolean): string {
  const more = belowPanels ? 'more ' : ''
  return count === 1 ? `1 ${more}project has no active work:` : `${count} ${more}projects have no active work:`
}
