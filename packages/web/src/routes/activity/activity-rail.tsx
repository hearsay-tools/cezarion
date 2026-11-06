import { ArrowRightIcon } from 'lucide-react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { StatusDot } from '@/components/status-dot'
import { cn } from '@/lib/utils'

import { clockOf, counter, since } from './activity-format'
import { feedAge, type FeedEntry, type FeedTone } from './activity-feed'
import { directionOf, recipientName, replyDueText, senderName, type RunEntry } from './activity-model'
import { windowUsed } from './activity-lines'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { TONE_FILL } from './activity-tone'
import { Heartbeat } from './now-box-view'

/**
 * The right rail (spec 2026-11-05-live-activity-view, "Right rail"): the open requests, the Just
 * now feed and the legend. A request entry slides in when the request opens and folds when it
 * closes; the feed lists the last changes the view saw.
 */

const PANEL = 'rounded-xl border border-border bg-card px-3.5 py-3'
const PANEL_TITLE = 'mb-2 flex gap-2 text-[11.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase'

function RequestEntry({ request, index, now, motion }: { request: ActivityRequest; index: ReadonlyMap<string, RunEntry>; now: number; motion?: 'enter' | 'fold' | undefined }) {
  const { kind, relation } = directionOf(request, index)
  const used = windowUsed(request, now)
  const tone = request.relationship === 'peer' ? 'text-message-peer-accent' : 'text-message-inbound-accent'
  return (
    <li
      data-slot={motion === 'fold' ? 'activity-request-closing' : 'activity-request'}
      data-request={request.requestId}
      aria-hidden={motion === 'fold' ? true : undefined}
      className={cn('border-t border-border py-2.5 first:border-t-0 first:pt-0', motion === 'enter' && 'activity-row-enter', motion === 'fold' && 'activity-row-fold')}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium">
        <span className="min-w-0 truncate">{senderName(index, request)}</span>
        <ArrowRightIcon aria-label="to" className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{recipientName(index, request)}</span>
        <span className={cn('ml-auto shrink-0 text-[10px] font-semibold tracking-[0.05em] uppercase', tone)}>{kind}</span>
      </div>
      <p className="my-1 line-clamp-3 text-[12px] text-muted-foreground">“{request.text}”</p>
      <div className="flex gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        <span>{relation} · open {counter(since(request.createdAt, now))}</span>
        {request.deadline ? <span className="ml-auto">{replyDueText(request.deadline, now)}</span> : null}
      </div>
      {used === undefined ? null : (
        <div aria-hidden="true" className="mt-1.5 h-[3px] overflow-hidden rounded-sm bg-border">
          <span className={cn('block h-full bg-current', tone)} style={{ width: `${Math.round(used * 100)}%` }} />
        </div>
      )}
    </li>
  )
}

function LegendLine({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 34 10" className="h-2.5 w-[34px] shrink-0">
      <path d="M2 5h30" strokeWidth={2} strokeDasharray="6 5" className={className} />
    </svg>
  )
}

function Legend() {
  const row = 'flex items-center gap-2'
  return (
    <div data-slot="activity-legend" className={cn(PANEL, 'grid gap-1.5 text-[11.5px] text-muted-foreground')}>
      <h2 className="sr-only">Legend</h2>
      <div className={row}><StatusDot tone="running" aria-hidden="true" />Filled: working now</div>
      <div className={row}><StatusDot tone="info" shape="ring" aria-hidden="true" />Ring: waiting for something outside</div>
      <div className={row}><StatusDot tone="running" shape="workers" aria-hidden="true" />Robot: waiting for its own workers</div>
      <div className={row}><Heartbeat rate={[0, 2, 5, 1, 3, 0, 4, 2]} className="w-[34px]" />Heartbeat: tool calls, last 30 s</div>
      <div className={row}><LegendLine className="stroke-message-peer-accent" />Open request, task to task</div>
      <div className={row}><LegendLine className="stroke-message-inbound-accent" />Open question, worker to parent</div>
      <div className={row}><svg aria-hidden="true" viewBox="0 0 34 10" className="h-2.5 w-[34px] shrink-0"><circle cx="17" cy="5" r="4" className="fill-foreground" /></svg>Comet: a message is travelling</div>
    </div>
  )
}

const FEED_DOT: Record<FeedTone, string> = { ...TONE_FILL, peer: 'bg-message-peer-accent', family: 'bg-message-inbound-accent' }

/** The last changes the view saw, newest first, each with its age. The newest slides in. */
function JustNow({ feed, now, watchingSince }: { feed: readonly FeedEntry[]; now: number; watchingSince: string }) {
  return (
    <section data-slot="activity-just-now" className={PANEL}>
      <h2 className={PANEL_TITLE}>Just now</h2>
      {feed.length > 0 ? (
        <ul data-slot="activity-feed">
          {feed.map((entry, i) => (
            <li key={entry.id} data-slot="activity-feed-entry" className={cn('grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-2 py-1 text-[12px] text-muted-foreground', i === 0 && 'activity-feed-enter')}>
              <span aria-hidden="true" className={cn('size-[7px] -translate-y-px rounded-full', FEED_DOT[entry.tone])} />
              <span className="min-w-0">{entry.text}</span>
              <span data-slot="activity-feed-age" className="text-[11px] tabular-nums">{feedAge(now - entry.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="py-1.5 text-[12px] text-muted-foreground">Watching since {clockOf(watchingSince)}</p>
    </section>
  )
}

interface RailProps {
  requests: readonly ActivityRequest[]
  /** Closed requests whose entries fold out. */
  closing?: readonly ActivityRequest[]
  index: ReadonlyMap<string, RunEntry>
  now: number
  watchingSince: string
  feed?: readonly FeedEntry[] | undefined
  motion?: MotionState
}

export function ActivityRail({ requests, closing = [], index, now, watchingSince, feed = [], motion = EMPTY_MOTION }: RailProps) {
  return (
    <aside data-slot="activity-rail" aria-label="Activity details" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
      <section data-slot="activity-open-requests" className={PANEL}>
        <h2 className={PANEL_TITLE}>Open requests <b className="text-foreground">{requests.length}</b></h2>
        {requests.length === 0 && closing.length === 0 ? (
          <p className="py-1.5 text-[12px] text-muted-foreground">No task waits for a reply.</p>
        ) : (
          <ul>
            {requests.map((request) => <RequestEntry key={request.requestId} request={request} index={index} now={now} motion={request.requestId in motion.opening ? 'enter' : undefined} />)}
            {closing.map((request) => <RequestEntry key={request.requestId} request={request} index={index} now={now} motion="fold" />)}
          </ul>
        )}
      </section>
      <JustNow feed={feed} now={now} watchingSince={watchingSince} />
      <Legend />
    </aside>
  )
}
