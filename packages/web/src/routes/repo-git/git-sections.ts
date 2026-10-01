import type { LogEntry, RepoInfo, RepoResponse, RepoTracking } from '@open-mercato/cezar-api-client'

import { shortAge } from '@/lib/format'

import { stripProjectPrefix } from '@/lib/project-router'

/**
 * The Git view's sections (issue 06 §3, #622). Each is a URL, so every section deep-links and
 * survives a refresh; the old facet URLs keep resolving (`/git/commits[/:sha]` is Recently on
 * main, which is where a commit opens). `changes` is the main tree's uncommitted files, reached
 * from the checkout block's warning rather than a row of its own.
 */
export type GitSection = 'main' | 'not-landed' | 'cleanup' | 'branches' | 'changes'

/** The section a `/git…` pathname shows, or null outside the Git view. */
export function gitSectionOf(pathname: string): GitSection | null {
  const flat = stripProjectPrefix(pathname)
  if (/^\/git\/branches(?:\/|$)/.test(flat)) return 'branches'
  if (/^\/git\/not-landed(?:\/|$)/.test(flat)) return 'not-landed'
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
  'not-landed': '/git/not-landed',
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

export interface CommitDay {
  label: string
  commits: LogEntry[]
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const DAY_FORMAT_WITH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * Which day group a commit belongs to: Today, Yesterday, or its date ("Mon, Sep 28", with the
 * year once it is not this one), all in the browser's own time zone. Grouped by the commit's
 * absolute `at` (issue 08): git's relative `%cr` rounds, which misfiled commits made near
 * midnight. A row whose `at` does not parse lands in "Earlier" rather than on a wrong day.
 */
export function commitDayLabel(at: string, now: number): string {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return 'Earlier'
  const today = startOfDay(now)
  if (time >= today) return 'Today'
  if (time >= startOfDay(today - 1)) return 'Yesterday'
  const date = new Date(time)
  return (date.getFullYear() === new Date(now).getFullYear() ? DAY_FORMAT : DAY_FORMAT_WITH_YEAR).format(date)
}

/** The log grouped by day, newest first. git already sorts the log, so groups are contiguous runs. */
export function groupCommitsByDay(log: readonly LogEntry[], now = Date.now()): CommitDay[] {
  const days: CommitDay[] = []
  for (const commit of log) {
    const label = commitDayLabel(commit.at, now)
    const last = days.at(-1)
    if (last?.label === label) last.commits.push(commit)
    else days.push({ label, commits: [commit] })
  }
  return days
}

/** How many of the log's commits landed today (the phone row's "6 today"). */
export function commitsToday(log: readonly LogEntry[], now = Date.now()): number {
  return log.filter((commit) => commitDayLabel(commit.at, now) === 'Today').length
}

/**
 * The base's tracking as the CHECKOUT's, or null. `repo.tracking` is the configured base against
 * its upstream, but everything that shows it sits beside a Pull that acts on the checked-out
 * branch; with another branch checked out, "2 behind" would describe one branch and Pull update
 * another. Null then, the same as no upstream.
 */
export function checkoutTracking(repo: Pick<RepoResponse, 'baseBranch' | 'tracking'>, info: RepoInfo): RepoTracking | null {
  return (repo.baseBranch ?? info.branch) === info.branch ? repo.tracking : null
}

/** "fetched 6m ago" from `tracking.fetchedAt`, or "never fetched" when the repository has no
 *  `FETCH_HEAD`. Freshness is always as of the last fetch: nothing here fetches (issue 08 §B1). */
export function fetchedAgo(tracking: RepoTracking, now = Date.now()): string {
  const age = tracking.fetchedAt ? shortAge(tracking.fetchedAt, now) : ''
  return age ? `fetched ${age} ago` : 'never fetched'
}
