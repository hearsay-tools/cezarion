import { occurrencesBetween, onceInstant, type NormalizedSchedule } from '@open-mercato/cezar-api-client/contract/automation-schedule'

import { dayTime, onceWall, relativeIn } from '@/lib/automation-format'

/** Five runs need room: a weekly schedule is five weeks deep, an hourly one a few hours. The
 *  search is capped by `limit`, so the wide window costs nothing for the dense shapes. */
const PREVIEW_WINDOW_MS = 40 * 86_400_000
const PREVIEW_COUNT = 5

/** The next five instants the schedule fires, from the same math the server's timer runs. */
export function NextRunsPreview({ schedule, timeZone, now = Date.now() }: { schedule: NormalizedSchedule; timeZone: string; now?: number }) {
  if (schedule.type === 'once') return <OnceRun schedule={schedule} now={now} />
  // `+ 1`: the range is half-open at the start, and "next" is strictly after `now`.
  const runs = occurrencesBetween(schedule, now + 1, now + PREVIEW_WINDOW_MS, timeZone, PREVIEW_COUNT)
  return (
    <section aria-labelledby="next-runs-heading" className="rounded-xl border bg-card p-4">
      <h2 id="next-runs-heading" className="mb-3 text-[15px] font-medium">Next 5 runs</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs in the next 40 days.</p>
      ) : (
        <ol aria-label="Next 5 runs" className="grid gap-1.5 text-sm">
          {runs.map((at) => (
            <li key={at} className="flex items-baseline justify-between gap-3">
              <span className="font-medium tabular-nums">{dayTime(new Date(at).toISOString(), timeZone)}</span>
              <span className="text-muted-foreground">{relativeIn(now, at)}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Times are in {timeZone}, the zone this cezar runs in.</p>
    </section>
  )
}

/** A one-time schedule's single instant, in the zone it was set in (hearsay-tools/cezarion#1465). */
function OnceRun({ schedule, now }: { schedule: NormalizedSchedule; now: number }) {
  const instant = onceInstant(schedule)
  const wall = onceWall(schedule.at)
  return (
    <section aria-labelledby="next-runs-heading" className="rounded-xl border bg-card p-4">
      <h2 id="next-runs-heading" className="mb-3 text-[15px] font-medium">Runs once</h2>
      {instant === null || !wall ? (
        <p className="text-sm text-muted-foreground">Pick a date, a time and a time zone.</p>
      ) : (
        <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="font-medium tabular-nums">{`${wall.date} ${wall.time}`}</span>
          {instant > now ? <span className="text-muted-foreground">{relativeIn(now, instant)}</span> : null}
        </p>
      )}
      {instant !== null && instant <= now ? <p className="mt-2 text-sm text-destructive">The due time has passed.</p> : null}
      <p className="mt-3 text-xs break-words text-muted-foreground">{`Times are in ${schedule.timeZone ?? 'UTC'}. Cezarion must be running then; afterwards the schedule is archived with its task.`}</p>
    </section>
  )
}
