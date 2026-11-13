import { productName } from '@/lib/product-name'
import { Fragment, useId } from 'react'

import { Switch } from '@/components/ui/switch'
import './completion-controls.css'

export interface TaskAccessPatch {
  allowWorkers?: boolean
  allowMessaging?: boolean
}

const ROWS = [
  {
    key: 'allowWorkers',
    slot: 'workers',
    label: `Allow ${productName('cezar')} workers`,
    help: `Agents in this task can start ${productName('Cezar')} workers. Each worker is a separate paid agent session. Worker limits cap resources, not spending.`,
  },
  {
    key: 'allowMessaging',
    slot: 'messaging',
    label: 'Allow task messaging',
    help: 'Agents in this task can message other tasks in this project.',
  },
] as const

/** The per-task Squawk access switches (hearsay-tools/cezarion#2784). Both default on. */
export function TaskAccessControls({ allowWorkers, allowMessaging, onChange, disabled = false, embedded = false }: {
  allowWorkers: boolean
  allowMessaging: boolean
  onChange: (patch: TaskAccessPatch) => void
  disabled?: boolean
  /** Share the host's settings card while retaining an accessible group name. */
  embedded?: boolean
}) {
  const id = useId()
  const values = { allowWorkers, allowMessaging }
  return (
    <fieldset data-slot="task-access-controls" data-embedded={embedded || undefined} className="grid min-w-0 gap-3">
      <legend className={embedded ? 'sr-only' : 'text-sm font-medium [margin-block-end:0.5rem]'}>Task access</legend>
      {ROWS.map((row) => (
        <Fragment key={row.key}>
          <label htmlFor={`${id}-${row.slot}`} data-slot={`task-access-${row.slot}`}
            className="completion-control flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md text-sm">
            <span className="min-w-0 break-words">
              <span id={`${id}-${row.slot}-label`}>{row.label}</span>
              {embedded ? <span id={`${id}-${row.slot}-help`} className="completion-control-help">{row.help}</span> : null}
            </span>
            <Switch id={`${id}-${row.slot}`} className="completion-switch shrink-0" checked={values[row.key]} disabled={disabled}
              aria-labelledby={`${id}-${row.slot}-label`} aria-describedby={`${id}-${row.slot}-help`}
              onCheckedChange={(value) => onChange({ [row.key]: value })} />
          </label>
          {!embedded ? <p id={`${id}-${row.slot}-help`} className="text-xs break-words text-muted-foreground">{row.help}</p> : null}
        </Fragment>
      ))}
    </fieldset>
  )
}
