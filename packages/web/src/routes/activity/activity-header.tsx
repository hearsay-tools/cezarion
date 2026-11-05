import { BotIcon, MessageSquareIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'

import { StatusDot } from '@/components/status-dot'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import type { ActivitySummary } from './activity-model'

/**
 * The activity view's header and summary chips (spec 2026-11-05-live-activity-view, "Header" and
 * "Summary chips"). The chips are a polite live region; the cards are not.
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

export function ActivityHeader({ name, generatedAt, children }: { name: string; generatedAt?: string | undefined; children: ReactNode }) {
  const at = generatedAt === undefined ? Number.NaN : Date.parse(generatedAt)
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="min-w-0 truncate text-[18px] font-semibold">
        Activity <span className="font-normal text-muted-foreground">· {name}</span>
      </h1>
      {Number.isNaN(at) ? null : (
        <span data-slot="activity-clock" className="text-[12px] text-muted-foreground tabular-nums">
          Updated {CLOCK.format(at)} {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </span>
      )}
      {children}
    </header>
  )
}

function Chip({ icon, count, label }: { icon: ReactNode; count: number; label: string }) {
  return (
    <li data-slot="activity-chip" data-chip={label} className="inline-flex items-center gap-[7px] rounded-full border border-border bg-card px-[11px] py-[5px] text-[12px] text-muted-foreground">
      {icon}
      <strong className="font-semibold text-foreground tabular-nums">{count}</strong> {label}
    </li>
  )
}

export function SummaryChips({ summary, tasksTo }: { summary: ActivitySummary; tasksTo: string }) {
  return (
    <ul data-slot="activity-summary" aria-live="polite" aria-label="Summary" className="flex flex-wrap gap-2">
      <Chip icon={<StatusDot tone="pending" aria-hidden="true" />} count={summary.needsYou} label="needs you" />
      <Chip icon={<StatusDot tone="running" aria-hidden="true" />} count={summary.working} label="working" />
      <Chip icon={<StatusDot tone="running" shape="ring" aria-hidden="true" />} count={summary.waiting} label="waiting" />
      <Chip icon={<StatusDot tone="neutral" shape="ring" aria-hidden="true" />} count={summary.queued} label="queued" />
      <Chip icon={<BotIcon aria-hidden="true" className="size-3.5" />} count={summary.activeWorkers} label="active workers" />
      <Chip icon={<MessageSquareIcon aria-hidden="true" className="size-3.5 text-message-peer-accent" />} count={summary.openRequests} label="open requests" />
      <li data-slot="activity-chip" data-chip="in review">
        <Link to={tasksTo} className="inline-flex items-center gap-[7px] rounded-full border border-border bg-card px-[11px] py-[5px] text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11">
          <StatusDot tone="info" aria-hidden="true" />
          <strong className="font-semibold text-foreground tabular-nums">{summary.inReview}</strong> in review
        </Link>
      </li>
    </ul>
  )
}
