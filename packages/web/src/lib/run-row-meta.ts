import type { RunSummary } from '@open-mercato/cezar-api-client'
import { resolveWaitingOn } from '@open-mercato/cezar-api-client/contract/waits'
import type { Attention, AttentionRung } from '@/lib/attention'
import { checkTimeText, resumeLabel, shortAge } from '@/lib/format'
import { refPrefixMatches, runTitle, splitRefPrefix } from '@/lib/task-groups'
import { taskReference, taskReferences, type TaskReference } from '@/lib/tasks-table'

/**
 * What a sidebar task row paints, decided apart from the markup (hearsay-tools/cezarion#1773):
 * its title, and the pieces of its meta line. Pure, so `run-row-meta.test.ts` can table-test
 * every case without rendering a row — `task-quick-list.tsx` only lays the results out.
 */

/** What the meta line's state word (#617) says on each rung, beside the dot: nothing where the
 *  dot is the whole story (the amber, green and grey filled dots of needs you, done and
 *  cancelled), the label, or the label with the detail the dot cannot carry. Exhaustive: a new
 *  rung fails to compile until it says (hearsay-tools/cezarion#1496). */
const STATE_WORD: Record<AttentionRung, 'none' | 'label' | 'queue-position' | 'resume' | 'next-check' | 'until'> = {
  'needs-permission': 'label',
  failed: 'label',
  'needs-you': 'none',
  'needs-review': 'label',
  running: 'label',
  'usage-limit': 'resume',
  'waiting-on-workers': 'label',
  'waiting-for-ci': 'label',
  'waiting-for-merge': 'label',
  'waiting-for-command': 'until',
  monitoring: 'next-check',
  'waiting-for-capacity': 'label',
  queued: 'queue-position',
  done: 'none',
  cancelled: 'none',
  unseen: 'label',
}

/** The meta line's state word (#617): the attention label for the states the dot alone cannot
 *  say, with the queue position (`queued #2`), the resume (`usage limit, resumes in 12m`), the
 *  timer's next check or the command's deadline where the rung has one. */
export function metaStateWord(attention: Attention, queuePosition: number | null, run: RunSummary, now: number): string | undefined {
  const { label } = attention
  switch (STATE_WORD[attention.rung]) {
    case 'none':
      return undefined
    case 'queue-position':
      return queuePosition !== null ? `queued #${queuePosition}` : label
    case 'resume': {
      // When, not just that (#617 01b): `usage limit, resumes in 12m`, or `usage limit` once due.
      const resume = resumeLabel(run.autoResumeAt, now)
      return resume === 'scheduled' ? label : `${label}, ${resume}`
    }
    case 'next-check': {
      // The same detail for a timer: `monitoring, next check 15:05` (phase 4b, hearsay-tools/cezarion#1236).
      const waitingOn = resolveWaitingOn(run)
      const at = waitingOn?.kind === 'timer' ? new Date(waitingOn.at) : undefined
      return at && Number.isFinite(at.getTime()) ? `${label}, next check ${checkTimeText(at, new Date(now))}` : label
    }
    case 'until': {
      // And for a process wait: `waiting for a command, until 15:40` (hearsay-tools/cezarion#1446).
      const waitingOn = resolveWaitingOn(run)
      const until = waitingOn?.kind === 'process' ? new Date(waitingOn.deadline) : undefined
      return until && Number.isFinite(until.getTime()) ? `${label}, until ${checkTimeText(until, new Date(now))}` : label
    }
    case 'label':
      return label
  }
}

export interface RunRowMeta {
  stateWord: string | undefined
  references: TaskReference[]
  age: string
  /** Changes whenever the line's content does: the line re-measures its width on a new key. */
  key: string
}

/** The meta line's content: state word, references, age and the key that tells the line it changed. */
export function runRowMeta({ run, attention, queuePosition, inWorkingGroup, scope, now }: {
  run: RunSummary
  attention: Attention
  queuePosition: number | null
  inWorkingGroup: boolean
  /** Explicit `/p/<id>` link scope for a non-active project's row; null = the active scope. */
  scope: string | null
  now: number
}): RunRowMeta {
  const references = taskReferences(run, undefined, scope ?? undefined)
  // A queued row's position rides in its state word instead of an age.
  const age = queuePosition !== null ? '' : shortAge(run.finishedAt ?? run.createdAt, now)
  const stateWord = inWorkingGroup && attention.rung === 'running' ? undefined : metaStateWord(attention, queuePosition, run, now)
  const key = `${age}|${stateWord ?? ''}|${references.map((ref) => `${ref.kind}-${ref.number}-${ref.url}`).join(',')}|${run.notify ? 1 : 0}`
  return { stateWord, references, age, key }
}

/** The row's full stored title, and the title it paints. */
export function runRowTitle(run: RunSummary): { title: string; displayTitle: string } {
  const title = runTitle(run)
  // The strongest tracker reference the run knows about — the PR once one exists, else the issue
  // it was opened on. It is the reason the title may drop its `NNN: ` prefix (#788, option C):
  // the number is painted once, as a link on the meta line, instead of twice.
  const reference = taskReference(run)
  // Only when the two numbers are the same number — see `refPrefixMatches`. A run opened on issue
  // #788 that shipped as PR #790 keeps its prefix, because the reference is not saying it.
  const displayTitle = refPrefixMatches(title, reference?.number) ? splitRefPrefix(title).rest : title
  return { title, displayTitle }
}
