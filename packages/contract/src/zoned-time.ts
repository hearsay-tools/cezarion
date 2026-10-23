/**
 * Shared Node-free wall-clock conversion using Intl. At DST gaps or overlaps choose one
 * converged instant, so occurrence math does not emit duplicate local occurrences.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number;
  second: number;
  /** ISO weekday: Monday = 1 … Sunday = 7. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** The wall-clock parts of an instant in a zone, or `null` for an unknown zone. */
export function zonedParts(utcMs: number, timeZone: string): ZonedParts | null {
  try {
    const parts = formatter(timeZone).formatToParts(new Date(utcMs));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const year = value('year');
    const month = value('month');
    const day = value('day');
    // `hourCycle: 'h23'` — but some engines still print 24 for midnight; fold it.
    const hour = value('hour') % 24;
    return {
      year,
      month,
      day,
      hour,
      minute: value('minute'),
      second: value('second'),
      weekday: isoWeekday(year, month, day),
    };
  } catch {
    return null;
  }
}

/** ISO weekday (Mon = 1 … Sun = 7) of a calendar date, zone-independent. */
export function isoWeekday(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sun
  return ((dow + 6) % 7) + 1;
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function timeZoneOffsetMs(timeZone: string, utcMs: number): number | null {
  const parts = zonedParts(utcMs, timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

/** The instant at which a zone's clock reads the given wall time. See the header for DST. */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = wallAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const offset = timeZoneOffsetMs(timeZone, candidate);
    if (offset === null) return null;
    const next = wallAsUtc - offset;
    if (Math.abs(next - candidate) < 1_000) return next;
    candidate = next;
  }
  return candidate;
}

/** `true` when `Intl` knows the zone. */
export function isValidTimeZone(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    formatter(candidate).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** The host's own zone, as `Intl` reports it. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
