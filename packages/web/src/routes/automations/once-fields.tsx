import { useEffect, useId, useRef, useState } from 'react'
import { ONCE_PAST_DUE_MESSAGE, onceInstant, onceWallParts, unknownTimeZoneMessage, type AutomationSchedule, type NormalizedSchedule } from '@open-mercato/cezar-api-client/contract/automation-schedule'
import { isValidTimeZone, zonedParts } from '@open-mercato/cezar-api-client/contract/zoned-time'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { onceResolved } from '@/lib/automation-format'
import { TimeField } from './editor-schedule-fields'

/** "Latest start": how late after its time a one-time schedule may still launch. `none` = no limit. */
const LATEST_START: readonly { minutes: number | undefined; label: string }[] = [
  { minutes: undefined, label: 'No limit' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 120, label: '2 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 1_440, label: '1 day' },
  { minutes: 10_080, label: '7 days' },
]
const NO_LIMIT = 'none'

const two = (n: number) => String(n).padStart(2, '0')

/** Tomorrow at 09:00 in `timeZone`: where a fresh Once starts, always in the future. */
export function defaultOnceAt(timeZone: string, now = Date.now()): string {
  const today = zonedParts(now, timeZone) ?? zonedParts(now, 'UTC')!
  // The next calendar date, not 24 hours later: a 25-hour fall-back day would stay on today.
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1))
  return `${next.getUTCFullYear()}-${two(next.getUTCMonth() + 1)}-${two(next.getUTCDate())}T09:00`
}

/** Every IANA zone this browser knows, for the zone field's suggestions. */
function knownZones(): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return supported.includes('UTC') ? supported : ['UTC', ...supported]
}

/**
 * The fields of a one-time schedule (hearsay-tools/cezarion#1465): a date, the two-digit time
 * fields, a time zone and a latest start. Every field writes `at`, `timeZone` or
 * `latestStartMinutes`; a past time or an unknown zone sets the field's custom validity, so Save
 * is blocked and the draft stays as typed.
 */
export function OnceFields({ value, stored, onChange }: { value: NormalizedSchedule; stored?: AutomationSchedule; onChange: (next: NormalizedSchedule) => void }) {
  const set = (patch: Partial<NormalizedSchedule>) => onChange({ ...value, ...patch })
  const wall = value.at ? onceWallParts(value.at) : null
  const date = value.at?.slice(0, 10) ?? ''
  const hour = wall?.hour ?? 9
  const minute = wall?.minute ?? 0
  const setAt = (nextDate: string, nextHour: number, nextMinute: number) => set({ at: `${nextDate}T${two(nextHour)}:${two(nextMinute)}` })

  const dateRef = useRef<HTMLInputElement>(null)
  const pastId = useId()
  const instant = onceInstant(value)
  // A Failed or Missed schedule keeps its past due time; only a changed one must be in the future,
  // as the server judges it (#1465 review).
  const unchanged = stored?.type === 'once' && stored.at === value.at && stored.timeZone === value.timeZone
  const past = !unchanged && instant !== null && instant <= Date.now()
  useEffect(() => { dateRef.current?.setCustomValidity(past ? ONCE_PAST_DUE_MESSAGE : '') }, [past])

  const summary = onceResolved(value)
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="grid gap-2">
          <Label htmlFor="automation-once-date">Date</Label>
          <Input
            ref={dateRef}
            id="automation-once-date"
            type="date"
            className="w-44 max-w-full"
            value={date}
            aria-invalid={past || undefined}
            aria-describedby={past ? pastId : undefined}
            onChange={(event) => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setAt(event.target.value, hour, minute) }}
            required
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">at</span>
          <TimeField label="Hour" value={hour} max={23} onCommit={(next) => setAt(date, next, minute)} />
          <span aria-hidden="true">:</span>
          <TimeField label="Minute" value={minute} max={59} onCommit={(next) => setAt(date, hour, next)} />
        </div>
      </div>
      {past ? <p id={pastId} className="text-xs text-destructive">{ONCE_PAST_DUE_MESSAGE}</p> : null}
      <ZoneField value={value.timeZone ?? ''} onCommit={(timeZone) => set({ timeZone })} />
      <LatestStartField value={value.latestStartMinutes} onChange={(latestStartMinutes) => onChange(withLatestStart(value, latestStartMinutes))} />
      {summary ? (
        <p className="text-sm break-words">{`Runs once at ${summary.time} on ${summary.date} (${value.timeZone}). ${summary.note ? `${summary.note} ` : ''}Cezarion must be running then.`}</p>
      ) : null}
    </div>
  )
}

function withLatestStart(value: NormalizedSchedule, minutes: number | undefined): NormalizedSchedule {
  const { latestStartMinutes: _dropped, ...rest } = value
  return minutes === undefined ? rest : { ...rest, latestStartMinutes: minutes }
}

/** A typed IANA zone with the browser's zones as suggestions. It holds its own text while typing
 *  and commits only a zone the browser knows; anything else is invalid until fixed. */
function ZoneField({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const listId = useId()
  const messageId = useId()
  const [zones] = useState(knownZones)
  const invalid = text !== value || !isValidTimeZone(text)
  const message = unknownTimeZoneMessage(text)
  useEffect(() => { ref.current?.setCustomValidity(invalid ? message : '') }, [invalid, message])
  return (
    <div className="grid gap-2">
      <Label htmlFor="automation-once-zone">Time zone</Label>
      <Input
        ref={ref}
        id="automation-once-zone"
        list={listId}
        autoComplete="off"
        spellCheck={false}
        className="w-full sm:w-72"
        value={text}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? messageId : undefined}
        onChange={(event) => {
          setText(event.target.value)
          if (isValidTimeZone(event.target.value)) onCommit(event.target.value)
        }}
      />
      <datalist id={listId}>{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
      {invalid ? <p id={messageId} className="text-xs break-words text-destructive">{message}</p> : null}
    </div>
  )
}

function LatestStartField({ value, onChange }: { value: number | undefined; onChange: (next: number | undefined) => void }) {
  // A stored limit the presets do not hold (set through the API or the CLI) stays choosable.
  const options = LATEST_START.some((option) => option.minutes === value) || value === undefined
    ? LATEST_START
    : [...LATEST_START, { minutes: value, label: `${value} minutes` }]
  return (
    <div className="grid gap-2">
      <Label htmlFor="automation-once-latest">Latest start</Label>
      <Select value={value === undefined ? NO_LIMIT : String(value)} onValueChange={(next) => onChange(next === NO_LIMIT ? undefined : Number(next))}>
        <SelectTrigger id="automation-once-latest" className="w-full sm:w-48" aria-label="Latest start">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.label} value={option.minutes === undefined ? NO_LIMIT : String(option.minutes)}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs break-words text-muted-foreground">If Cezarion was not running at the time, it still starts the task this long afterwards; later, the schedule is marked missed.</p>
    </div>
  )
}
