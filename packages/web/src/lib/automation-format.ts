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
