import type { RunIndexEntry } from '@open-mercato/cezar-api-client'

import { deriveAttention } from './attention'
import { isUnread } from './read-state'
import { isOwnedWorker } from './task-groups'

/**
 * What a project's mark on the rail says (#618): four counts, two pills.
 *
 * Top pill, "for you": `needsYou` (amber) and `failedUnread` (red). Bottom pill, "in motion and
 * new": `inMotion` (violet) and `finishedUnread` (green). Position carries the meaning, so the
 * rail needs no dots — a dot means a run's state on a task row, and no shape may mean two things.
 */
export type ProjectSignal = {
  /** Top-level runs whose attention bucket is `waiting`: needs you, needs review. */
  needsYou: number
  /** Top-level runs that failed and have not been opened since. */
  failedUnread: number
  /** Top-level runs that are running, monitoring, or waiting on their own workers. */
  inMotion: number
  /** Top-level runs that finished and have not been opened since. */
  finishedUnread: number
}

const IDLE: ProjectSignal = { needsYou: 0, failedUnread: 0, inMotion: 0, finishedUnread: 0 }

/**
 * The four counts for one project's runs.
 *
 * Built only on the deciders every other surface reads (`deriveAttention`, `isUnread`,
 * `isOwnedWorker`), so the rail cannot disagree with a task row.
 *  - Tasks, not processes: owned workers are skipped, so a parent waiting on two workers is ONE
 *    task in motion. Archived runs are ignored everywhere.
 *  - Queued runs and scheduled usage-limit resumes are neither for you nor in motion: their
 *    attention tone is neutral, and `isUnread` already excludes a scheduled resume.
 *  - Green and red count only unread runs, so opening a task clears its contribution.
 */
export function projectSignal(runs: readonly RunIndexEntry[]): ProjectSignal {
  const signal = { ...IDLE }
  for (const run of runs) {
    if (run.archived || isOwnedWorker(run)) continue
    const attention = deriveAttention(run)
    if (attention.bucket === 'waiting') signal.needsYou += 1
    // Violet is the running family: running, monitoring, and a parent parked on its workers.
    else if (attention.tone === 'running') signal.inMotion += 1
    else if (isUnread(run)) {
      if (run.status === 'failed') signal.failedUnread += 1
      else if (run.status === 'done') signal.finishedUnread += 1
    }
  }
  return signal
}

/** Every project's signal from the workspace runs index. A project with no runs has no entry. */
export function signalsByProject(runs: readonly RunIndexEntry[]): Map<string, ProjectSignal> {
  const byProject = new Map<string, RunIndexEntry[]>()
  for (const run of runs) {
    const rows = byProject.get(run.projectId)
    if (rows) rows.push(run)
    else byProject.set(run.projectId, [run])
  }
  return new Map([...byProject].map(([projectId, rows]) => [projectId, projectSignal(rows)]))
}

/**
 * The signal in words, for a mark's tooltip and accessible name: `toolkit-dev · 1 needs you ·
 * 1 failed · 2 working · 1 finished`, or `toolkit-dev · idle`. Zero parts are omitted. The mobile
 * drawer reuses this string (slice 4).
 *
 * `truncated`: the index caps each project's contribution, so an old unread item may be missing
 * from the counts. Say so rather than claim the count is complete.
 * `unknown`: the index has not loaded (or never arrived), so nothing is known about this project.
 * That is not "idle" — a quiet claim needs a fetched index behind it.
 */
export function projectSignalLabel(
  name: string,
  signal: ProjectSignal | undefined,
  options: { truncated?: boolean; unknown?: boolean } = {},
): string {
  if (options.unknown) return `${name} · activity unknown`
  const { needsYou, failedUnread, inMotion, finishedUnread } = signal ?? IDLE
  const parts = [
    needsYou > 0 ? `${needsYou} needs you` : null,
    failedUnread > 0 ? `${failedUnread} failed` : null,
    inMotion > 0 ? `${inMotion} working` : null,
    finishedUnread > 0 ? `${finishedUnread} finished` : null,
  ].filter((part): part is string => part !== null)
  return [name, parts.length > 0 ? parts.join(' · ') : 'idle', ...(options.truncated ? ['recent runs only'] : [])].join(' · ')
}

/**
 * The two lower-case letters on a mark: the first letters of the first two words of the name
 * (split on `-`, `_`, space or `.`), or the first two letters of a one-word name.
 */
export function projectInitials(name: string): string {
  const words = name.split(/[-_ .]+/).filter((word) => word !== '')
  const letters = words.length >= 2 ? [words[0]!, words[1]!].map((word) => [...word][0]!) : [...(words[0] ?? '')].slice(0, 2)
  return letters.join('').toLowerCase()
}
