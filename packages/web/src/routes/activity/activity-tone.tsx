import {
  BanIcon,
  BotIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  EyeIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HourglassIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PauseIcon,
  TerminalIcon,
  UserIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ActivityRun, ActivityWorker } from '@open-mercato/cezar-api-client/contract/activity'

import { StatusDot } from '@/components/status-dot'
import { attentionOfRung, type AttentionShape, type AttentionTone } from '@/lib/attention'

import type { NowIcon } from './now-box'

/** Readable ink for each attention tone on a card or on card-2 (packages/web/docs/card-2-contrast.md):
 *  danger reads as the red signal word and neutral as muted text. */
export const TONE_INK: Record<AttentionTone, string> = {
  success: 'text-success',
  pending: 'text-pending-strong',
  danger: 'text-signal-word-red',
  accent: 'text-accent-text',
  info: 'text-info',
  running: 'text-status-running',
  neutral: 'text-muted-foreground',
}

export const NOW_ICON: Record<NowIcon, LucideIcon> = {
  tool: WrenchIcon,
  user: UserIcon,
  workers: BotIcon,
  reply: MessageSquareIcon,
  peer: MessagesSquareIcon,
  subagents: BotIcon,
  ci: GitPullRequestIcon,
  merge: GitMergeIcon,
  command: TerminalIcon,
  timer: ClockIcon,
  pause: PauseIcon,
  queued: HourglassIcon,
  review: EyeIcon,
  failed: CircleXIcon,
  done: CircleCheckIcon,
  cancelled: BanIcon,
}

/**
 * The status shape of a card or a worker row, from the snapshot's rung. A worker that waits on
 * its parent, and a root that waits on peers, wait outside themselves: the ring, as
 * `deriveAttention` draws them.
 */
export function shapeOf(run: Pick<ActivityRun | ActivityWorker, 'rung' | 'wait'>, role: 'root' | 'worker'): { tone: AttentionTone; shape: AttentionShape; label: string } {
  const attention = attentionOfRung(run.rung)
  const outside = run.rung === 'waiting-on-workers' && (role === 'worker' || run.wait?.kind === 'peers')
  return { tone: attention.tone, shape: outside ? 'ring' : attention.shape, label: attention.label }
}

/** The status shape with its anchor for the lines. No pulse: slice S6 adds motion. */
export function RunShape({ run, role }: { run: Pick<ActivityRun | ActivityWorker, 'runId' | 'rung' | 'wait'>; role: 'root' | 'worker' }) {
  const { tone, shape, label } = shapeOf(run, role)
  return (
    <span data-activity-anchor={run.runId} className="inline-flex size-[12px] shrink-0 items-center justify-center">
      <StatusDot tone={tone} shape={shape} role="img" aria-label={label} />
    </span>
  )
}
