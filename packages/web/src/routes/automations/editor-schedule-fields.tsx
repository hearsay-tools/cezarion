import { useState } from 'react'
import { SCHEDULE_HOURS_OPTIONS, WEEKDAY_NAMES, cronOf, type NormalizedSchedule, type ScheduleEvery, type ScheduleType } from '@open-mercato/cezar-api-client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChipButton } from './chip-button'

const SHAPES: readonly { type: ScheduleType; label: string }[] = [
  { type: 'daily', label: 'Every day' },
  { type: 'weekdays', label: 'Weekdays' },
  { type: 'weekly', label: 'Weekly' },
  { type: 'hours', label: 'Every N hours' },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** A two-digit clock field. It holds its own text while typing — "7" is not yet "07" — and
 *  commits to the schedule only a value in range; blur settles it back to the committed value. */
function TimeField({ label, value, max, onCommit }: { label: string; value: number; max: number; onCommit: (next: number) => void }) {
  const [text, setText] = useState(pad(value))
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      maxLength={2}
      className="w-20 text-center tabular-nums"
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        if (/^\d{1,2}$/.test(event.target.value) && Number(event.target.value) <= max) onCommit(Number(event.target.value))
      }}
      onBlur={() => setText(pad(value))}
    />
  )
}

export function ScheduleFields({ value, onChange, timeZone }: { value: NormalizedSchedule; onChange: (next: NormalizedSchedule) => void; timeZone: string }) {
  const set = (patch: Partial<NormalizedSchedule>) => onChange({ ...value, ...patch })
  return (
    <div className="grid gap-4">
      <div role="group" aria-label="Repeat" className="flex flex-wrap gap-2">
        {SHAPES.map((shape) => (
          <ChipButton key={shape.type} pressed={value.type === shape.type} onClick={() => set({ type: shape.type })}>{shape.label}</ChipButton>
        ))}
      </div>
      {value.type === 'weekly' ? (
        <div role="group" aria-label="Day of the week" className="flex flex-wrap gap-2">
          {WEEKDAY_NAMES.map((name, index) => (
            <ChipButton key={name} pressed={value.day === index + 1} onClick={() => set({ day: index + 1 })}>{name}</ChipButton>
          ))}
        </div>
      ) : null}
      {value.type === 'hours' ? (
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
      <p className="text-xs text-muted-foreground">Cron: <code className="font-mono text-foreground">{cronOf(value)}</code></p>
    </div>
  )
}
