import { automationEventSchema, type AutomationEvent, type AutomationFilters } from '@open-mercato/cezar-api-client'

import { ChevronDownIcon } from '@/components/design-icons'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChipButton } from './chip-button'
import type { AutomationDraft } from './editor-draft'

const EVENTS = automationEventSchema.options
const INTERVALS: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 1_800, label: '30 minutes' },
  { seconds: 3_600, label: '1 hour' },
]

type ListKey = 'authors' | 'assignees' | 'allLabels' | 'anyLabels' | 'excludeLabels' | 'changedLabels'
const LIST_FILTERS: readonly { key: ListKey; label: string; hint?: string }[] = [
  { key: 'authors', label: 'Authors' },
  { key: 'assignees', label: 'Assignees' },
  { key: 'allLabels', label: 'Has all labels' },
  { key: 'anyLabels', label: 'Has any label' },
  { key: 'excludeLabels', label: 'Excludes labels' },
  { key: 'changedLabels', label: 'Changed labels', hint: 'Required for the two label events.' },
]

const csv = (values: readonly string[] | undefined) => (values ?? []).join(', ')
const parseCsv = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean)

/** One-sentence explanation of how a GitHub automation polls — also the preview column's text. */
export function pollSentence(draft: Pick<AutomationDraft, 'events' | 'intervalSeconds'>): string {
  const minutes = Math.max(1, Math.round(draft.intervalSeconds / 60))
  return `Polls GitHub every ${minutes} minute${minutes === 1 ? '' : 's'} for ${draft.events.join(', ') || 'no events'}. Enabling starts from a current-time baseline, so existing matches never launch tasks.`
}

export function GithubFields({ draft, onChange, disabledReason }: { draft: AutomationDraft; onChange: (patch: Partial<AutomationDraft>) => void; disabledReason?: string }) {
  const toggleEvent = (event: AutomationEvent) => {
    const events = draft.events.includes(event) ? draft.events.filter((item) => item !== event) : [...draft.events, event]
    onChange({ events })
  }
  const setFilter = (patch: Partial<AutomationFilters>) => onChange({ filters: { ...draft.filters, ...patch } })
  const setList = (key: ListKey, text: string) => {
    const list = parseCsv(text)
    const { [key]: _old, ...rest } = draft.filters
    onChange({ filters: list.length ? { ...rest, [key]: list } : rest })
  }
  const intervals = INTERVALS.some((item) => item.seconds === draft.intervalSeconds)
    ? INTERVALS
    : [...INTERVALS, { seconds: draft.intervalSeconds, label: `${Math.round(draft.intervalSeconds / 60)} minutes` }].sort((a, b) => a.seconds - b.seconds)
  return (
    <div className="grid gap-4">
      {disabledReason ? <p className="text-xs text-pending-strong">{`GitHub unavailable · ${disabledReason}`}</p> : null}
      <div role="group" aria-label="GitHub events" className="flex flex-wrap gap-2">
        {EVENTS.map((event) => (
          <ChipButton key={event} pressed={draft.events.includes(event)} onClick={() => toggleEvent(event)}>{event}</ChipButton>
        ))}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="automation-interval">Check every</Label>
        <Select value={String(draft.intervalSeconds)} onValueChange={(next) => onChange({ intervalSeconds: Number(next) })}>
          <SelectTrigger id="automation-interval" className="w-full sm:w-48" aria-label="Check every">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {intervals.map((item) => <SelectItem key={item.seconds} value={String(item.seconds)}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-11 items-center gap-2 text-sm font-medium">
          Filters
          <ChevronDownIcon aria-hidden="true" className="size-4 text-soft-foreground transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-4 pt-2 sm:grid-cols-2">
            {LIST_FILTERS.map((filter) => (
              <div key={filter.key} className="grid min-w-0 gap-2">
                <Label htmlFor={`automation-filter-${filter.key}`}>{filter.label}</Label>
                <Input id={`automation-filter-${filter.key}`} placeholder="comma separated" value={csv(draft.filters[filter.key])} onChange={(event) => setList(filter.key, event.target.value)} />
                {filter.hint ? <p className="text-xs text-muted-foreground">{filter.hint}</p> : null}
              </div>
            ))}
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="automation-filter-lookback">Look back (days)</Label>
              <Input id="automation-filter-lookback" type="number" min={1} value={draft.filters.lookbackDays} onChange={(event) => setFilter({ lookbackDays: Math.max(1, Number(event.target.value) || 1) })} />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="automation-filter-max">Max records per check</Label>
              <Input id="automation-filter-max" type="number" min={1} value={draft.filters.maxRecords} onChange={(event) => setFilter({ maxRecords: Math.max(1, Number(event.target.value) || 1) })} />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
