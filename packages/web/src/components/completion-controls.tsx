import { useId } from 'react'

import { Switch } from '@/components/ui/switch'
import './completion-controls.css'

export function CompletionControls({ archiveWhenDone, autoMergePr, onChange, disabled = false }: {
  archiveWhenDone: boolean
  autoMergePr: boolean
  onChange: (patch: { archiveWhenDone?: boolean; autoMergePr?: boolean }) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <fieldset data-slot="completion-controls" className="grid min-w-0 gap-3">
      <legend className="text-sm font-medium [margin-block-end:0.5rem]">After Done</legend>
      <label htmlFor={`${id}-archive`} className="completion-control flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md text-sm">
        <span className="min-w-0 break-words">Archive when Done</span>
        <Switch id={`${id}-archive`} className="completion-switch" checked={archiveWhenDone} disabled={disabled}
          aria-describedby={`${id}-archive-help`} onCheckedChange={(value) => onChange({ archiveWhenDone: value })} />
      </label>
      <p id={`${id}-archive-help`} className="text-xs break-words text-muted-foreground">Move the task to Archived after it reaches Done. You can restore it later.</p>
      <label htmlFor={`${id}-merge`} className="completion-control flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md text-sm">
        <span className="min-w-0 break-words">Auto-merge PR</span>
        <Switch id={`${id}-merge`} className="completion-switch" checked={autoMergePr} disabled={disabled}
          aria-describedby={`${id}-merge-help`} onCheckedChange={(value) => onChange({ autoMergePr: value })} />
      </label>
      <p id={`${id}-merge-help`} className="text-xs break-words text-muted-foreground">After Done, mark a draft PR ready and merge when current-head CI and GitHub rules allow it.</p>
      <p className="text-xs break-words text-muted-foreground">When both are on, merge comes before archive. Without a PR, Archive when Done still archives the task.</p>
    </fieldset>
  )
}
