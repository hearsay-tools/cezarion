import { bucketOf } from '@/lib/task-groups'
import { deriveAttention, type AttentionRung } from '@/lib/attention'
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

/** The status id that names each rung, or `null` when none does: `needs-you` names the sidebar
 *  group (`bucketOf`) rather than the rung, and the dot's merge and command waits have no id of
 *  their own. A booked resume keeps the sidebar's word, `scheduled` (`SCHEDULED_WEIGHT` in
 *  `lib/task-groups.ts`), though the dot names it after its cause (hearsay-tools/cezarion#1236).
 *  Exhaustive: a new rung fails to compile until it says (hearsay-tools/cezarion#1496). */
const VOICE_STATUS_OF_RUNG: Record<AttentionRung, VoiceStatus | null> = {
  'needs-permission': 'needs-permission',
  failed: 'failed',
  'needs-you': null,
  'needs-review': 'needs-review',
  running: 'running',
  'usage-limit': 'scheduled',
  'waiting-on-workers': 'waiting-on-workers',
  'waiting-for-ci': 'waiting-for-ci',
  'waiting-for-merge': null,
  'waiting-for-command': null,
  monitoring: 'monitoring',
  'waiting-for-capacity': 'waiting-for-capacity',
  queued: 'queued',
  done: 'done',
  cancelled: 'cancelled',
  unseen: null,
}

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
    case 'scheduled':
    case 'waiting-on-workers':
      return VOICE_STATUS_OF_RUNG[deriveAttention(run).rung] === status
    case 'done':
    case 'cancelled':
      return run.status === status
    case 'unread':
      return isUnread(run)
  }
}
