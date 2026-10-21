import { bucketOf } from '@/lib/task-groups'
import { deriveAttention } from '@/lib/attention'
import { isUnread } from '@/lib/read-state'
import type { VoiceStatus } from '@open-mercato/cezar-api-client/contract/voice'
import type { RunSummary } from '@open-mercato/cezar-api-client'

/**
 * The code-owned half of "open the next failed task" (spec 2026-10-21-voice-mode, § Open by status
 * and position): one predicate per status id the engine may name. The ids and the one-line
 * descriptions Jev reads live in the contract; this file says what each one means for a run.
 *
 * The predicates overlap on purpose. The dot shows exactly one label per run, but a failed,
 * unread run is also in Finished, so it answers to `failed`, `finished` and `unread`.
 */

/** `deriveAttention`'s label for a status id: `waiting-for-ci` → `waiting for ci`, compared
 *  case-insensitively against the label `waiting for CI`. */
const labelIs = (run: RunSummary, id: string): boolean =>
  deriveAttention(run).label.toLowerCase() === id.replaceAll('-', ' ')

export function voiceStatusMatches(status: VoiceStatus, run: RunSummary): boolean {
  switch (status) {
    case 'needs-you':
      return bucketOf(run, 'active') === 'Needs you'
    case 'working':
      return bucketOf(run, 'active') === 'Working'
    case 'finished':
      return bucketOf(run, 'active') === 'Finished'
    case 'archived':
      return run.archived === true
    case 'needs-permission':
      return deriveAttention(run).bucket === 'permission'
    case 'failed':
      return deriveAttention(run).bucket === 'error'
    case 'needs-review':
    case 'running':
    case 'waiting-for-ci':
    case 'monitoring':
    case 'waiting-for-capacity':
    case 'queued':
      return labelIs(run, status)
    // The dot names a booked resume after its cause (hearsay-tools/cezarion#1236); the status id
    // keeps the sidebar's word for it (`SCHEDULED_WEIGHT` in `lib/task-groups.ts`).
    case 'scheduled':
      return deriveAttention(run).label === 'usage limit'
    case 'waiting-on-workers':
      return deriveAttention(run).label.startsWith('waiting on ')
    case 'done':
    case 'cancelled':
      return run.status === status
    case 'unread':
      return isUnread(run)
  }
}
