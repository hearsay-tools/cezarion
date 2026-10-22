import { WEEKDAY_NAMES, onceInstant, onceWallParts } from '@open-mercato/cezar-api-client/contract/automation-schedule'
import { isoWeekday, timeZoneOffsetMs, zonedParts } from '@open-mercato/cezar-api-client/contract/zoned-time'

/**
 * Time words for the automations screens. Pure and zone-explicit: every automation instant is
 * shown in the SERVER's zone (the one its schedules are evaluated in), never the browser's.
 */

/** `in 12m`, `in 3h`, `in 2d` — the coarsest whole unit; `now` once the instant has arrived. */
export function relativeIn(fromMs: number, toMs: number): string {
  const delta = toMs - fromMs
  if (delta <= 0) return 'now'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'in <1m'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

interface Zoned {
  weekday: string
  day: string
  month: string
  hour: string
  minute: string
  /** `YYYY-M-D` in the zone — equal keys are the same calendar day. */
  key: string
  /** Whole days since the epoch for the zone's calendar date. */
  dayNumber: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function zoned(ms: number, timeZone: string): Zoned | null {
  if (!Number.isFinite(ms)) return null
  let format = formatters.get(timeZone)
  try {
    format ??= new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    return null
  }
  formatters.set(timeZone, format)
  const parts: Record<string, string> = {}
  for (const part of format.formatToParts(ms)) parts[part.type] = part.value
  const monthIndex = new Date(`${parts.month} 1, ${parts.year} UTC`).getUTCMonth()
  return {
    weekday: parts.weekday!,
    day: parts.day!,
    month: parts.month!,
    hour: parts.hour!,
    minute: parts.minute!,
    key: `${parts.year}-${monthIndex}-${parts.day}`,
    dayNumber: Math.floor(Date.UTC(Number(parts.year), monthIndex, Number(parts.day)) / 86_400_000),
  }
}

/** `Thu 04:00` — the weekday and wall time of an instant in `timeZone`. */
export function dayTime(iso: string, timeZone: string): string {
  const parts = zoned(Date.parse(iso), timeZone)
  return parts ? `${parts.weekday} ${parts.hour}:${parts.minute}` : iso
}

/**
 * A log row's time: `Today 04:00`, `Yesterday 14:30`, `Sun 14:30` inside the last week,
 * `1 Jun 14:30` beyond it. "Today" is the zone's calendar day, not UTC's.
 */
export function logTime(iso: string, timeZone: string, now: number): string {
  const at = zoned(Date.parse(iso), timeZone)
  const today = zoned(now, timeZone)
  if (!at || !today) return iso
  const clock = `${at.hour}:${at.minute}`
  const ago = today.dayNumber - at.dayNumber
  if (ago === 0) return `Today ${clock}`
  if (ago === 1) return `Yesterday ${clock}`
  if (ago > 1 && ago < 7) return `${at.weekday} ${clock}`
  return `${at.day} ${at.month} ${clock}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const two = (n: number) => String(n).padStart(2, '0')

/**
 * A one-time schedule's stored wall time as `Thu 29 Oct 2026` and `09:00` (hearsay-tools/cezarion#1465).
 * Read off `at` itself, so it shows the time the user typed, in the zone the user picked.
 */
export function onceWall(at: string | undefined): { date: string; time: string } | null {
  const parts = at ? onceWallParts(at) : null
  if (!parts) return null
  const { year, month, day, hour, minute } = parts
  return { date: `${WEEKDAY_NAMES[isoWeekday(year, month, day) - 1]} ${day} ${MONTHS[month - 1]} ${year}`, time: `${two(hour)}:${two(minute)}` }
}

const HOUR_MS = 3_600_000

/**
 * The wall time a one-time schedule really runs at, in its own zone (hearsay-tools/cezarion#1465
 * review). It differs from the typed time only around a DST change: a time the clocks skip runs at
 * another time, and a time they repeat runs at one of the two. `note` says which, so the editor and
 * the preview never claim a time that is not the one the task starts at.
 */
export function onceResolved(schedule: Parameters<typeof onceInstant>[0]): { date: string; time: string; note?: string } | null {
  const instant = onceInstant(schedule)
  const zone = schedule.timeZone
  const typed = onceWall(schedule.at)
  const parts = instant === null || !zone ? null : zonedParts(instant, zone)
  if (instant === null || !zone || !typed || !parts) return null
  const resolved = { date: `${WEEKDAY_NAMES[isoWeekday(parts.year, parts.month, parts.day) - 1]} ${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`, time: `${two(parts.hour)}:${two(parts.minute)}` }
  if (resolved.date !== typed.date || resolved.time !== typed.time) return { ...resolved, note: `${typed.time} does not exist on ${typed.date} in ${zone}.` }
  const sameWall = (ms: number) => {
    const other = zonedParts(ms, zone)
    return !!other && other.day === parts.day && other.hour === parts.hour && other.minute === parts.minute
  }
  // The clocks go back by the zone's own step, which is not always an hour (Lord Howe: 30 min).
  const step = (timeZoneOffsetMs(zone, instant - 12 * HOUR_MS) ?? 0) - (timeZoneOffsetMs(zone, instant + 12 * HOUR_MS) ?? 0)
  if (step <= 0) return resolved
  const laterToo = sameWall(instant + step)
  if (!laterToo && !sameWall(instant - step)) return resolved
  const offset = (timeZoneOffsetMs(zone, instant) ?? 0) / 60_000
  const utc = `UTC${offset < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`
  return { ...resolved, note: `${typed.time} happens twice that day; it runs at ${laterToo ? 'the first' : 'the second'} (${utc}).` }
}
