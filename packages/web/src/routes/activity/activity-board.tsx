import * as React from 'react'
import type { ActivityProject, ActivityRequest, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'

import type { FeedEntry } from './activity-feed'
import { ActivityCard } from './activity-card'
import { ActivityLines } from './activity-lines'
import { nameOf, runIndex } from './activity-model'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { ActivityRail } from './activity-rail'
import { COLUMN_GAP, DENSE_AFTER, columnCount, placeCards, samePlacement, type Columns } from './layout'
import type { NowContext } from './now-box'
import { useFlip } from './use-flip'

/**
 * The project graph and its rail (spec 2026-11-05-live-activity-view, "Project view"): task cards
 * in stable columns (D9), the lines between them, and the right rail, with their motion. The
 * column count follows the graph's width; one column is the narrow layout.
 */

/** The graph's width, measured now and again on every resize. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.clientWidth)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** D9: the placement survives snapshot changes; only the ids that came or went move. */
function useStablePlacement(ids: readonly string[], count: number, weight: (id: string) => number): Columns {
  const [placement, setPlacement] = React.useState<Columns | undefined>(undefined)
  const next = placeCards(placement, ids, count, weight)
  // Derived state: React re-renders at once with the stored placement, before painting.
  if (!samePlacement(placement, next)) setPlacement(next)
  return next
}

/** What the motion still draws of a project: cards that left and requests that closed, while
 *  they collapse or fade. Each is left out once the snapshot has it again. */
export function ghostsOf(project: ActivityProject, motion: MotionState): { cards: ActivityRun[]; requests: ActivityRequest[]; folding: ActivityRequest[] } {
  const tasks = new Set(project.tasks.map((task) => task.runId))
  const open = new Set(project.requests.map((request) => request.requestId))
  const closing = Object.values(motion.closing).filter((ghost) => ghost.projectId === project.projectId && !open.has(ghost.request.requestId))
  return {
    cards: Object.values(motion.leaving).filter((ghost) => ghost.projectId === project.projectId && !tasks.has(ghost.task.runId)).map((ghost) => ghost.task),
    requests: closing.map((ghost) => ghost.request),
    // The rail entry folds while the reply comet travels, or while a closure without a reply
    // fades; it leaves no gap while the line still says "Replied".
    folding: closing.filter((ghost) => ghost.phase === 'reply' || !ghost.replied).map((ghost) => ghost.request),
  }
}

export interface BoardProps {
  project: ActivityProject
  now: number
  watchingSince: string
  motion?: MotionState
  feed?: readonly FeedEntry[]
  /** Reduced motion or a hidden tab: cards move at once, without FLIP. */
  still?: boolean
  paused?: boolean
}

export function ActivityBoard({ project, now, watchingSince, motion = EMPTY_MOTION, feed, still = false, paused = false }: BoardProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const count = columnCount(useWidth(hostRef))
  const index = React.useMemo(() => runIndex(project), [project])
  const ghosts = React.useMemo(() => ghostsOf(project, motion), [project, motion])
  const drawnRequests = React.useMemo(() => [...project.requests, ...ghosts.requests], [project.requests, ghosts.requests])
  const tasks = new Map([...ghosts.cards, ...project.tasks].map((task) => [task.runId, task]))
  const ghostIds = new Set(ghosts.cards.map((task) => task.runId))
  // A card with workers is taller; the weight keeps the columns near the same height.
  const weight = (id: string) => 1 + 0.35 * (tasks.get(id)?.workers.length ?? 0)
  const columns = useStablePlacement([...tasks.keys()], count, weight)
  const narrow = count === 1
  const dense = project.tasks.length > DENSE_AFTER
  const ctx: NowContext = { now, titleOf: (runId) => nameOf(index, runId) }
  const placement = columns.map((column) => column.join(',')).join('|')
  const layoutKey = `${project.tasks.length}:${count}:${dense}:${placement}:${drawnRequests.map((request) => request.requestId).join(',')}`
  useFlip(hostRef, 'data-flip', placement, !still && !paused)

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 pl-5">
        {project.tasks.length === 0 ? (
          <p data-slot="activity-empty" className="py-6 text-[13px] text-muted-foreground">No active work in this project.</p>
        ) : null}
        <div
          ref={hostRef}
          data-slot="activity-graph"
          data-columns={count}
          data-dense={dense ? 'true' : undefined}
          className="relative grid items-start"
          style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, columnGap: narrow ? 0 : COLUMN_GAP }}
        >
          {columns.map((column, i) => (
            <div key={i} data-slot="activity-column" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-[30px] max-md:gap-4">
              {column.map((id) => {
                const task = tasks.get(id)
                return task ? <ActivityCard key={id} task={task} requests={project.requests} index={index} ctx={ctx} dense={dense} narrow={narrow} motion={motion} ghost={ghostIds.has(id)} /> : null
              })}
            </div>
          ))}
          <ActivityLines requests={drawnRequests} index={index} peers={!narrow} layoutKey={layoutKey} now={now} motion={motion} paused={paused} />
        </div>
      </div>
      <ActivityRail requests={project.requests} closing={ghosts.folding} index={index} now={now} watchingSince={watchingSince} feed={feed} motion={motion} />
    </div>
  )
}
