/** Time words of the activity view. Every age and countdown is computed from the server's
 *  timestamps and a client `now`; the caller ticks `now` once a second. */

const pad = (n: number) => String(n).padStart(2, '0')

/** A ticking counter: `4:12`, or `1:04:12` past an hour. Negative spans read as `0:00`. */
export function counter(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** A coarse span for prose: `6 s`, `42 min`, `1 h 10 min`. */
export function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`
}

/** Milliseconds from `iso` to `now`; 0 when `iso` is absent or not a date. */
export function since(iso: string | undefined, now: number): number {
  const at = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(at) ? 0 : now - at
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** A wall-clock time in the user's time zone: `15:42`. An unparseable value reads as given. */
export function clockOf(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? iso : CLOCK.format(at)
}

/** The user's time zone name, for the header clock. */
export function timeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
