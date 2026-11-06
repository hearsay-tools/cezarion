import { BotIcon, MessageSquareIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'

import { StatusDot } from '@/components/status-dot'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { timeZoneName } from './activity-format'
import type { ActivitySummary } from './activity-model'
import type { MotionState } from './activity-motion'

/**
 * The activity view's header and summary chips (spec 2026-11-05-live-activity-view, "Header" and
 * "Summary chips"). The chips are a polite live region; the cards are not. A chip whose count
 * changed bumps.
 */

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

const SEGMENT = 'inline-flex items-center px-3 py-[5px] text-[12px] font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:min-h-11'

/** "This project / All projects". The project link names the project; the global one is outside
 *  every project, so it is a plain router link. */
export function ScopeSwitch({ scope, projectId }: { scope: 'project' | 'all'; projectId: string | null }) {
  const segment = (active: boolean) => cn(SEGMENT, active ? 'bg-card-2 text-foreground' : 'text-muted-foreground hover:text-foreground')
  return (
    <nav aria-label="Activity scope" data-slot="activity-scope" className="ml-auto inline-flex overflow-hidden rounded-lg border border-border">
      {projectId === null ? null : (
        <RouterLink to={`/p/${encodeURIComponent(projectId)}/activity`} aria-current={scope === 'project' ? 'page' : undefined} className={segment(scope === 'project')}>
          This project
        </RouterLink>
      )}
      <RouterLink to="/activity" aria-current={scope === 'all' ? 'page' : undefined} className={segment(scope === 'all')}>
        All projects
      </RouterLink>
    </nav>
  )
}

/** The live indicator: "Live" and the clock, ticking once a second in the user's time zone. When
 *  the last read or frame failed, it says the view is not updating; the last snapshot stays. */
function LiveClock({ now, stale }: { now: number; stale: boolean }) {
  return (
    <span data-slot="activity-clock" data-stale={stale ? 'true' : undefined} className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground tabular-nums">
      <span data-tone="success" className={cn('inline-flex size-[12px] items-center justify-center', !stale && 'activity-pulse')}>
        <StatusDot tone={stale ? 'neutral' : 'success'} aria-hidden="true" />
      </span>
      <b className={cn('font-semibold', stale ? 'text-muted-foreground' : 'text-success')}>{stale ? 'Not updating' : 'Live'}</b>
      {CLOCK.format(now)} {timeZoneName()}
    </span>
  )
}

export function ActivityHeader({ name, now, stale = false, children }: { name: string; now?: number | undefined; stale?: boolean; children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="min-w-0 truncate text-[18px] font-semibold">
        Activity <span className="font-normal text-muted-foreground">· {name}</span>
      </h1>
      {now === undefined ? null : <LiveClock now={now} stale={stale} />}
      {children}
    </header>
  )
}

/** A chip's count. A new `bump` key replays the bump. */
function Count({ value, bump }: { value: number; bump: number | undefined }) {
  return (
    <strong key={bump ?? 'still'} data-bump={bump === undefined ? undefined : 'true'} className={cn('font-semibold text-foreground tabular-nums', bump !== undefined && 'activity-bump')}>
      {value}
    </strong>
  )
}

function Chip({ icon, count, label, bump }: { icon: ReactNode; count: number; label: string; bump: number | undefined }) {
  return (
    <li data-slot="activity-chip" data-chip={label} className="inline-flex items-center gap-[7px] rounded-full border border-border bg-card px-[11px] py-[5px] text-[12px] text-muted-foreground">
      {icon}
      <Count value={count} bump={bump} /> {label}
    </li>
  )
}

export function SummaryChips({ summary, tasksTo, bumps = {} }: { summary: ActivitySummary; tasksTo: string; bumps?: MotionState['bumps'] }) {
  const bump = (chip: keyof ActivitySummary) => bumps[chip]?.key
  return (
    <ul data-slot="activity-summary" aria-live="polite" aria-label="Summary" className="flex flex-wrap gap-2">
      <Chip icon={<StatusDot tone="pending" aria-hidden="true" />} count={summary.needsYou} label="needs you" bump={bump('needsYou')} />
      <Chip icon={<StatusDot tone="running" aria-hidden="true" />} count={summary.working} label="working" bump={bump('working')} />
      <Chip icon={<StatusDot tone="running" shape="ring" aria-hidden="true" />} count={summary.waiting} label="waiting" bump={bump('waiting')} />
      <Chip icon={<StatusDot tone="neutral" shape="ring" aria-hidden="true" />} count={summary.queued} label="queued" bump={bump('queued')} />
      <Chip icon={<BotIcon aria-hidden="true" className="size-3.5" />} count={summary.activeWorkers} label="active workers" bump={bump('activeWorkers')} />
      <Chip icon={<MessageSquareIcon aria-hidden="true" className="size-3.5 text-message-peer-accent" />} count={summary.openRequests} label="open requests" bump={bump('openRequests')} />
      <li data-slot="activity-chip" data-chip="in review">
        <Link to={tasksTo} className="inline-flex items-center gap-[7px] rounded-full border border-border bg-card px-[11px] py-[5px] text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11">
          <StatusDot tone="info" aria-hidden="true" />
          <Count value={summary.inReview} bump={bump('inReview')} /> in review
        </Link>
      </li>
    </ul>
  )
}
