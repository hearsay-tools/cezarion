import type { RunRecord } from '@open-mercato/cezar-api-client'

import { deriveAttention } from './attention'
import { shortAge } from './format'
import { taskReferences } from './tasks-table'

/**
 * The words a variant GROUP row says about its members (#617 addendum 01a). UI-free, like
 * `lib/attention.ts`, whose labels it folds into families.
 *
 * Families, not labels: `working` covers running, monitoring and a parent waiting on its own
 * workers — the whole violet family — because "waiting" in the data model means needs you, and a
 * group that read `1 needs you · 1 waiting on workers` would say "you" twice. The order is the
 * order a person acts in. Needs permission (not emitted today) keeps its own word, so a tool
 * approval is never described as a review; scheduled keeps its own word apart from queued —
 * queued waits for a slot, scheduled for a clock time, and a member saying "resumes 14:05" must
 * not be summed up as "1 queued". Cancelled comes after done.
 */
export const GROUP_FAMILIES = ['needs you', 'needs permission', 'needs review', 'failed', 'working', 'queued', 'scheduled', 'done', 'cancelled'] as const
export type GroupFamily = (typeof GROUP_FAMILIES)[number]

export function attentionFamily(label: string): GroupFamily {
  switch (label) {
    case 'needs you': return 'needs you'
    case 'needs permission': return 'needs permission'
    case 'needs review': return 'needs review'
    case 'failed': return 'failed'
    case 'queued': return 'queued'
    case 'scheduled': return 'scheduled'
    case 'done': return 'done'
    case 'cancelled': return 'cancelled'
    // running, monitoring and every dependency wait (`waiting on …`).
    default: return 'working'
  }
}

/** `['1 needs you', '1 working']` — at most two families, in family order. */
export function groupFamilies(members: readonly RunRecord[], limit = 2): string[] {
  return familiesOfLabels(members.map((member) => deriveAttention(member).label), limit)
}

/** The same count, from attention labels — the seam a test can reach for a rung no record can
 *  produce yet (needs permission). */
export function familiesOfLabels(labels: readonly string[], limit = 2): string[] {
  const counts = new Map<GroupFamily, number>()
  for (const label of labels) {
    const family = attentionFamily(label)
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  return GROUP_FAMILIES.filter((family) => counts.has(family))
    .slice(0, limit)
    .map((family) => `${counts.get(family)} ${family}`)
}

/**
 * A reference's identity: kind, number AND where it points. Kind + number alone would call two
 * repositories' PR #7 the same reference, so the group row would link to the first variant's and
 * hide the other's (review round 6). With a URL the key carries its host and `owner/repo`
 * (lower-cased, so `github.com/O/R` and `github.com/o/r` agree); an unparseable URL counts as
 * itself; only a number-only reference falls back to kind + number. The group row's line 2 and
 * every variant's own-reference filter use this one key.
 */
export function referenceKey(reference: { kind: string; number?: number; url?: string }): string {
  const base = `${reference.kind}#${reference.number}`
  if (!reference.url) return base
  try {
    const url = new URL(reference.url)
    const repo = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/')
    return `${base}@${url.host.toLowerCase()}/${repo.toLowerCase()}`
  } catch {
    return `${base}@${reference.url}`
  }
}

/** The references EVERY member carries. The group row shows these; a variant shows only the ones
 *  not in this set (each variant that opened its own PR shows it). */
export function sharedReferenceKeys(members: readonly RunRecord[]): Set<string> {
  const [first, ...rest] = members
  if (!first) return new Set()
  const shared = new Set(taskReferences(first).map(referenceKey))
  for (const member of rest) {
    const own = new Set(taskReferences(member).map(referenceKey))
    for (const key of shared) if (!own.has(key)) shared.delete(key)
  }
  return shared
}

/** The age of the member with the latest `finishedAt ?? createdAt` — the task row's own age rule,
 *  so a running group shows its shared start and a finished one when it last changed. */
export function groupAge(members: readonly RunRecord[], now: number): string {
  let latest: string | undefined
  let latestMs = -Infinity
  for (const member of members) {
    const iso = member.finishedAt ?? member.createdAt
    const ms = Date.parse(iso)
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = iso
      latestMs = ms
    }
  }
  return shortAge(latest, now)
}

export function groupMetaParts(members: readonly RunRecord[], now: number): { families: string[]; shared: Set<string>; age: string } {
  return { families: groupFamilies(members), shared: sharedReferenceKeys(members), age: groupAge(members, now) }
}

/**
 * A scheduled run's meta word (#617 01b): when it resumes, short enough for a sidebar line —
 * `resumes in 12m` under an hour, `resumes 14:05` from an hour out (the date too beyond a day).
 * `scheduled` when the time is missing, unreadable or already due. The auto-resume hint's
 * medium date + long time is the thread's wording; it does not fit here.
 */
export function resumeLabel(autoResumeAt: string | undefined, now: number): string {
  const at = autoResumeAt ? Date.parse(autoResumeAt) : Number.NaN
  if (!Number.isFinite(at) || at <= now) return 'scheduled'
  // Floored like `shortAge`, but never "in 0m": a run a few seconds out still resumes in 1m.
  const minutes = Math.max(1, Math.floor((at - now) / 60_000))
  if (minutes < 60) return `resumes in ${minutes}m`
  const date = new Date(at)
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (at - now < 86_400_000) return `resumes ${clock}`
  return `resumes ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)} ${clock}`
}
