import type { RunSummary } from '@open-mercato/cezar-api-client'
import { resolveWaitingOn } from '@open-mercato/cezar-api-client/contract/waits'
import type { Attention } from '@/lib/attention'
import { checkTimeText, resumeLabel, shortAge } from '@/lib/format'
import { refPrefixMatches, runTitle, splitRefPrefix } from '@/lib/task-groups'
import { taskReference, taskReferences, type TaskReference } from '@/lib/tasks-table'

/**
 * What a sidebar task row paints, decided apart from the markup (hearsay-tools/cezarion#1773):
 * its title, and the pieces of its meta line. Pure, so `run-row-meta.test.ts` can table-test
 * every case without rendering a row — `task-quick-list.tsx` only lays the results out.
 */

/** The meta line's state word (#617): the attention label only for the states the issue lists,
 *  where the dot alone cannot say it — monitoring, the dependency waits (waiting on N workers,
 *  on worker replies, on a parent reply), needs review, needs permission, failed, usage limit,
 *  queued (with its position, `queued #2`) and running. `needs you`, `done` and `cancelled` get
 *  none: the amber, green and grey filled dots already are the whole story. */
export function metaStateWord(attention: Attention, queuePosition: number | null, run: RunSummary, now: number): string | undefined {
  const { label } = attention
  if (label === 'queued') return queuePosition !== null ? `queued #${queuePosition}` : label
  if (label === 'needs you' || label === 'done' || label === 'cancelled') return undefined
  // When, not just that (#617 01b): `usage limit, resumes in 12m`, or `usage limit` once due.
  if (label === 'usage limit') {
    const resume = resumeLabel(run.autoResumeAt, now)
    return resume === 'scheduled' ? label : `${label}, ${resume}`
  }
  // The same detail for a timer: `monitoring, next check 15:05` (phase 4b, hearsay-tools/cezarion#1236).
  const waitingOn = label === 'monitoring' ? resolveWaitingOn(run) : undefined
  if (waitingOn?.kind === 'timer') {
    const at = new Date(waitingOn.at)
    if (Number.isFinite(at.getTime())) return `${label}, next check ${checkTimeText(at, new Date(now))}`
  }
  // And for a process wait: `waiting for a command, until 15:40` (hearsay-tools/cezarion#1446).
  const command = label === 'waiting for a command' ? resolveWaitingOn(run) : undefined
  if (command?.kind === 'process') {
    const until = new Date(command.deadline)
    if (Number.isFinite(until.getTime())) return `${label}, until ${checkTimeText(until, new Date(now))}`
  }
  return label
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
  const stateWord = inWorkingGroup && attention.label === 'running' ? undefined : metaStateWord(attention, queuePosition, run, now)
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
