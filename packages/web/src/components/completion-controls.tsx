import { useId } from 'react'

import { Switch } from '@/components/ui/switch'
import './completion-controls.css'

export function CompletionControls({ archiveWhenDone, autoMergePr, onChange, disabled = false, embedded = false }: {
  archiveWhenDone: boolean
  autoMergePr: boolean
  onChange: (patch: { archiveWhenDone?: boolean; autoMergePr?: boolean }) => void
  disabled?: boolean
  /** Share the host's settings card while retaining an accessible group name. */
  embedded?: boolean
}) {
  const id = useId()
  return (
    <fieldset data-slot="completion-controls" data-embedded={embedded || undefined} className="grid min-w-0 gap-3">
      <legend className={embedded ? 'sr-only' : 'text-sm font-medium [margin-block-end:0.5rem]'}>After Done</legend>
      <label htmlFor={`${id}-archive`} className="completion-control flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md text-sm">
        <span className="min-w-0 break-words"><span id={`${id}-archive-label`}>Archive when Done</span>{embedded ? <span id={`${id}-archive-help`} className="completion-control-help">Move to Archived after Done, even without a PR. You can restore it later.</span> : null}</span>
        <Switch id={`${id}-archive`} className="completion-switch" checked={archiveWhenDone} disabled={disabled}
          aria-labelledby={`${id}-archive-label`} aria-describedby={`${id}-archive-help`} onCheckedChange={(value) => onChange({ archiveWhenDone: value })} />
      </label>
      {!embedded ? <p id={`${id}-archive-help`} className="text-xs break-words text-muted-foreground">Move the task to Archived after it reaches Done. You can restore it later.</p> : null}
      <label htmlFor={`${id}-merge`} className="completion-control flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md text-sm">
        <span className="min-w-0 break-words"><span id={`${id}-merge-label`}>Auto-merge PR</span>{embedded ? <span id={`${id}-merge-help`} className="completion-control-help">After Done, mark the PR ready and merge when current-head CI and GitHub rules allow.</span> : null}</span>
        <Switch id={`${id}-merge`} className="completion-switch" checked={autoMergePr} disabled={disabled}
          aria-labelledby={`${id}-merge-label`} aria-describedby={`${id}-merge-help`} onCheckedChange={(value) => onChange({ autoMergePr: value })} />
      </label>
      {!embedded ? <p id={`${id}-merge-help`} className="text-xs break-words text-muted-foreground">After Done, mark a draft PR ready and merge when current-head CI and GitHub rules allow it.</p> : null}
      {!embedded || archiveWhenDone && autoMergePr ? <p className="completion-order-note text-xs break-words text-muted-foreground">{embedded ? 'Merge runs before archive when both are on.' : 'When both are on, merge comes before archive. Without a PR, Archive when Done still archives the task.'}</p> : null}
    </fieldset>
  )
}
