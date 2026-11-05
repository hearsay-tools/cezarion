import type { ActivityCheckBucket } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import { NOW_ICON, TONE_INK } from './activity-tone'
import type { NowBox } from './now-box'

/** A check segment's fill by its GitHub bucket: skipped and cancelled checks are hollow. */
const BUCKET_FILL: Record<ActivityCheckBucket, string> = {
  pass: 'bg-success',
  fail: 'bg-danger',
  pending: 'bg-info',
  skipping: 'border border-soft-foreground',
  cancel: 'border border-soft-foreground',
}

/** One segment for each check; a long list narrows the gaps so every segment still fits. */
function CheckSegments({ checks, overflow }: { checks: NonNullable<NowBox['checks']>; overflow: NowBox['overflow'] }) {
  return (
    <span data-slot="activity-checks" aria-hidden="true" className={cn('col-start-2 mt-[5px] flex items-center', checks.length > 40 ? 'gap-px' : 'gap-[3px]')}>
      {checks.map((check) => (
        <i key={check.name} data-bucket={check.bucket} title={check.name} className={cn('h-[5px] min-w-px flex-1 rounded-[2px]', BUCKET_FILL[check.bucket])} />
      ))}
      {overflow ? (
        <span data-slot="activity-checks-overflow" data-bucket={overflow.bucket} className="ml-1 flex shrink-0 items-center gap-1 text-[10px] leading-none text-muted-foreground tabular-nums">
          <i className={cn('h-[5px] w-2 rounded-[2px]', BUCKET_FILL[overflow.bucket])} />+{overflow.count}
        </span>
      ) : null}
    </span>
  )
}

function Bar({ value, ink }: { value: number; ink: string }) {
  return (
    <span data-slot="activity-bar" aria-hidden="true" className="col-start-2 mt-[5px] block h-1 overflow-hidden rounded-sm bg-border">
      <span className={cn('block h-full bg-current', ink)} style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}

/** The now box: a verb, a main line, a detail line and a live age counter. */
export function NowBoxView({ box, now, dense }: { box: NowBox; now: number; dense: boolean }) {
  const Icon = NOW_ICON[box.icon]
  const ink = TONE_INK[box.tone]
  return (
    <div data-slot="activity-now" data-verb={box.verb} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 gap-y-px rounded-lg bg-card-2 px-2.5 py-2">
      <Icon aria-hidden="true" className={cn('mt-px size-[15px]', ink)} />
      {/* Each tone's ink as a literal branch, so the cez/card-2-contrast lint checks the small verb. */}
      <span className={cn('flex gap-2 text-[11px] font-semibold tracking-[0.04em] uppercase', {
        'text-success': box.tone === 'success',
        'text-signal-word-amber': box.tone === 'pending',
        'text-signal-word-red': box.tone === 'danger',
        'text-accent-text': box.tone === 'accent',
        'text-info': box.tone === 'info',
        'text-status-running': box.tone === 'running',
        'text-muted-foreground': box.tone === 'neutral',
      })}>
        <span data-slot="activity-verb">{box.verb}</span>
        {box.since ? (
          <span data-slot="activity-age" className="ml-auto font-medium tracking-normal text-muted-foreground normal-case tabular-nums">
            {counter(since(box.since, now))}
          </span>
        ) : null}
      </span>
      <span data-slot="activity-main" className={cn('col-start-2 truncate text-[12.5px] text-foreground', box.mono && 'font-mono text-[12px]')}>
        {box.main}
      </span>
      {box.checks ? <CheckSegments checks={box.checks} overflow={box.overflow} /> : null}
      {box.bar !== undefined ? <Bar value={box.bar} ink={ink} /> : null}
      {box.detail && !dense ? (
        <span data-slot="activity-detail" className="col-start-2 text-[11.5px] text-muted-foreground tabular-nums">
          {box.detail}
        </span>
      ) : null}
    </div>
  )
}

/** The heartbeat strip: one bar for each of the last 30 seconds, as high as the tool calls that
 *  started in it. Drawn as sent; the client never ages it. */
export function Heartbeat({ rate, className }: { rate: readonly number[]; className?: string }) {
  const calls = rate.reduce((sum, n) => sum + n, 0)
  const peak = Math.max(4, ...rate)
  return (
    <svg
      data-slot="activity-heartbeat"
      role="img"
      aria-label={`${calls} tool call${calls === 1 ? '' : 's'} in the last ${rate.length} s`}
      viewBox="0 0 62 16"
      className={cn('block h-4 w-[62px] shrink-0', className)}
    >
      <path d="M0 15.5h62" className="stroke-border" />
      {rate.map((n, i) => {
        if (n <= 0) return null
        const h = Math.max(1.5, (n / peak) * 14)
        return <rect key={i} x={i * 2.07} y={15 - h} width={1.4} height={h} className="fill-status-running" />
      })}
    </svg>
  )
}
