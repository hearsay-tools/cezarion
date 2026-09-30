import type { LogEntry } from '@open-mercato/cezar-api-client'

import { stripProjectPrefix } from '@/lib/project-router'

/**
 * The Git view's sections (issue 06 §3, #622). Each is a URL, so every section deep-links and
 * survives a refresh; the old facet URLs keep resolving (`/git/commits[/:sha]` is Recently on
 * main, which is where a commit opens). `changes` is the main tree's uncommitted files, reached
 * from the checkout block's warning rather than a row of its own.
 */
export type GitSection = 'main' | 'cleanup' | 'branches' | 'changes'

/** The section a `/git…` pathname shows, or null outside the Git view. */
export function gitSectionOf(pathname: string): GitSection | null {
  const flat = stripProjectPrefix(pathname)
  if (/^\/git\/branches(?:\/|$)/.test(flat)) return 'branches'
  if (/^\/git\/cleanup(?:\/|$)/.test(flat)) return 'cleanup'
  if (/^\/git\/changes(?:\/|$)/.test(flat)) return 'changes'
  return /^\/git(?:\/commits(?:\/[^/]+)?)?\/?$/.test(flat) ? 'main' : null
}

/**
 * Where each section lives. On a phone the bare `/git` is the Git screen (checkout block and the
 * section rows), so the phone reaches Recently on main as `/git?view=repo` (`GIT_PHONE_MAIN_PATH`);
 * desktop treats both spellings the same.
 */
export const GIT_SECTION_PATH: Record<GitSection, string> = {
  main: '/git',
  cleanup: '/git/cleanup',
  branches: '/git/branches',
  changes: '/git/changes',
}

export const GIT_PHONE_MAIN_PATH = '/git?view=repo'

const GIT_AGE_UNITS: Record<string, string> = {
  second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y',
}

/** git's relative `%cr` ("3 hours ago") as the board's compact age ("3h"); anything git words otherwise stays as it is. */
export function shortGitAge(when: string): string {
  const match = /^(\d+) (second|minute|hour|day|week|month|year)s? ago$/.exec(when.trim())
  return match ? `${match[1]}${GIT_AGE_UNITS[match[2]!]}` : when
}

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
}

/**
 * The commit time `%cr` implies, or null when git worded it some other way ("1 year, 2 months
 * ago"). `GET /repo` carries only the relative age (the contract is out of scope here), so this
 * is an estimate: git rounds, which can misfile a commit made within about half an hour of
 * midnight. Good enough to group a log by day; never shown as a timestamp.
 */
export function estimatedCommitTime(when: string, now: number): number | null {
  const match = /^(\d+) (second|minute|hour|day|week|month|year)s? ago$/.exec(when.trim())
  return match ? now - Number(match[1]) * UNIT_MS[match[2]!]! : null
}

export interface CommitDay {
  label: string
  commits: LogEntry[]
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Which day group a commit belongs to: Today, Yesterday, This week, or Earlier. */
function dayLabel(when: string, now: number): string {
  const time = estimatedCommitTime(when, now)
  if (time === null) return 'Earlier'
  const today = startOfDay(now)
  if (time >= today) return 'Today'
  const yesterday = startOfDay(today - 1)
  if (time >= yesterday) return 'Yesterday'
  return time >= today - 6 * UNIT_MS.day! ? 'This week' : 'Earlier'
}

/** The log grouped by day, newest first. git already sorts the log, so groups are contiguous runs. */
export function groupCommitsByDay(log: readonly LogEntry[], now = Date.now()): CommitDay[] {
  const days: CommitDay[] = []
  for (const commit of log) {
    const label = dayLabel(commit.when, now)
    const last = days.at(-1)
    if (last?.label === label) last.commits.push(commit)
    else days.push({ label, commits: [commit] })
  }
  return days
}

/** How many of the log's commits landed today (the phone row's "6 today"). */
export function commitsToday(log: readonly LogEntry[], now = Date.now()): number {
  return log.filter((commit) => dayLabel(commit.when, now) === 'Today').length
}
