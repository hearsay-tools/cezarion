import { SCHEDULE_HOURS_OPTIONS, WEEKDAY_NAMES, cronOf, type AutomationSchedule, type NormalizedSchedule, type ScheduleEvery, type ScheduleType } from '@open-mercato/cezar-api-client/contract/automation-schedule'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChipButton } from './chip-button'
import { OnceFields, defaultOnceAt } from './once-fields'
import { TimeField } from './time-field'

const SHAPES: readonly { type: ScheduleType; label: string }[] = [
  { type: 'daily', label: 'Every day' },
  { type: 'weekdays', label: 'Weekdays' },
  { type: 'weekly', label: 'Weekly' },
  { type: 'hours', label: 'Every N hours' },
  { type: 'once', label: 'Once' },
]

// Moved to `time-field`; kept importable from here.
export { TimeField }

/** `stored` is the saved schedule when editing: a one-time due time left as saved is not re-judged as past. */
export function ScheduleFields({ value, stored, onChange, timeZone }: { value: NormalizedSchedule; stored?: AutomationSchedule | undefined; onChange: (next: NormalizedSchedule) => void; timeZone: string }) {
  const set = (patch: Partial<NormalizedSchedule>) => onChange({ ...value, ...patch })
  // Once starts tomorrow at 09:00 in the cockpit's zone; the draft keeps what it had if it had one.
  const choose = (type: ScheduleType) => set(type === 'once'
    ? { type, at: value.at ?? defaultOnceAt(timeZone), timeZone: value.timeZone ?? timeZone }
    : { type })
  return (
    <div className="grid gap-4">
      <div role="group" aria-label="Repeat" className="flex flex-wrap gap-2">
        {SHAPES.map((shape) => (
          <ChipButton key={shape.type} pressed={value.type === shape.type} onClick={() => choose(shape.type)}>{shape.label}</ChipButton>
        ))}
      </div>
      {value.type === 'once' ? <OnceFields value={value} stored={stored} onChange={onChange} /> : null}
      {value.type === 'weekly' ? (
        <div role="group" aria-label="Day of the week" className="flex flex-wrap gap-2">
          {WEEKDAY_NAMES.map((name, index) => (
            <ChipButton key={name} pressed={value.day === index + 1} onClick={() => set({ day: index + 1 })}>{name}</ChipButton>
          ))}
        </div>
      ) : null}
      {value.type === 'once' ? null : value.type === 'hours' ? (
        <div className="grid gap-2">
          <Label htmlFor="automation-every">Run every</Label>
          <Select value={String(value.every)} onValueChange={(next) => set({ every: Number(next) as ScheduleEvery })}>
            <SelectTrigger id="automation-every" className="w-full sm:w-48" aria-label="Run every">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_HOURS_OPTIONS.map((hours) => (
                <SelectItem key={hours} value={String(hours)}>{hours === 1 ? 'hour' : `${hours} hours`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Counted from midnight, so “every 6 hours” runs at 00:00, 06:00, 12:00 and 18:00.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">at</span>
          <TimeField label="Hour" value={value.hour} max={23} onCommit={(hour) => set({ hour })} />
          <span aria-hidden="true">:</span>
          <TimeField label="Minute" value={value.minute} max={59} onCommit={(minute) => set({ minute })} />
          <span className="text-sm break-all text-muted-foreground">{timeZone}</span>
        </div>
      )}
      {value.type === 'once' ? null : <p className="text-xs text-muted-foreground">Cron: <code className="font-mono text-foreground">{cronOf(value)}</code></p>}
    </div>
  )
}
