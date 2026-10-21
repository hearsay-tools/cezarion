import type { ApiRun } from '@open-mercato/cezar-api-client'

import { deriveAttention, type Attention } from '@/lib/attention'
import { checkTimeText } from '@/lib/format'

/**
 * The one status line a run shows (hearsay-tools/cezarion#1333): the desktop header pill and the
 * Session activity card both read it, so the two can never disagree about what the run is doing.
 *
 * `nextCheck` is an OPEN TIMER's deadline and nothing else. A CI or worker wait's deadline is when
 * cezar gives up, not when it looks again, so it is never presented as a next check.
 */
export interface RunStatusLine {
  attention: Attention
  label: string
  nextCheck?: { at: string; text: string }
}

/** Only these statuses can have a wait in flight; a finished run's leftovers are history. */
const IN_FLIGHT: readonly ApiRun['status'][] = ['running', 'queued', 'waiting']

export function runStatusLine(
  run: ApiRun,
  { queuePosition, now = new Date() }: { queuePosition?: number; now?: Date },
): RunStatusLine {
  const attention = deriveAttention(run)
  const base = attention.label.charAt(0).toUpperCase() + attention.label.slice(1)
  const label = queuePosition !== undefined ? `${base} #${queuePosition}` : base
  const nextCheck = IN_FLIGHT.includes(run.status) ? earliestOpenTimer(run, now) : undefined
  return nextCheck ? { attention, label, nextCheck } : { attention, label }
}

/** `Waiting for CI · Next check 2:30 PM`, or just the label. */
export function statusLineText(line: RunStatusLine): string {
  return line.nextCheck ? `${line.label} · Next check ${line.nextCheck.text}` : line.label
}

function earliestOpenTimer(run: ApiRun, now: Date): RunStatusLine['nextCheck'] {
  let earliest: Date | undefined
  for (const wait of Array.isArray(run.waits) ? run.waits : []) {
    if (wait?.kind !== 'timer' || wait.phase !== 'open') continue
    const at = new Date(wait.deadline)
    if (!Number.isFinite(at.getTime())) continue
    if (!earliest || at < earliest) earliest = at
  }
  if (!earliest) return undefined
  return { at: earliest.toISOString(), text: checkTimeText(earliest, now) }
}
