import { CommandGroup, CommandItem } from '@/components/ui/command'
import { VOICE_ROW_VALUE, type VoiceRow } from './use-voice-command'

/**
 * The palette's voice rows (spec 2026-10-21-voice-mode, § Input): the Will do row, the numbered
 * candidates when the engine was not sure, or one notice line. Rendered first in the list, with
 * `forceMount`, so cmdk's filter never hides them. They sit in a headless group of their own:
 * cmdk's sort on each search appends an item outside every group to the END of the list, which
 * would move the Will do row below the results it must stay above (hearsay-tools/cezarion#1461).
 *
 * A notice is a disabled item, never cmdk's selection: Return's fallback to "the selected item"
 * must reach an ordinary palette row. The Will do row is selectable only while it previews a
 * sentence (`committable`); its click commits like Return. A proposal's row is display only.
 * Its value is `VOICE_ROW_VALUE`, which Return compares cmdk's selection against.
 */
export function VoiceRows({
  row,
  committable,
  onSelect,
}: {
  row: VoiceRow | undefined
  committable: boolean
  onSelect(choice?: number): void
}) {
  if (!row) return null
  const lead = (
    <CommandItem
      forceMount
      value={VOICE_ROW_VALUE}
      data-slot="voice-row"
      data-voice-kind={row.kind}
      disabled={row.kind === 'notice' || row.choices !== undefined || !committable}
      onSelect={() => onSelect()}
      className="data-[disabled=true]:opacity-100"
    >
      {row.kind === 'will-do' ? <span className="shrink-0 text-xs text-soft-foreground">Will do</span> : null}
      <span
        role={row.kind === 'notice' ? 'status' : undefined}
        className={row.pending ? 'min-w-0 flex-1 truncate text-muted-foreground' : 'min-w-0 flex-1 truncate'}
      >
        {row.text}
      </span>
    </CommandItem>
  )
  return (
    <CommandGroup forceMount data-slot="voice-rows">
      {lead}
      {row.choices?.map((choice, index) => (
        <CommandItem
          key={index}
          forceMount
          value={`voice-choice-${index + 1}`}
          data-slot="voice-choice"
          onSelect={() => onSelect(index)}
        >
          <span className="w-4 shrink-0 text-center text-xs text-soft-foreground tabular-nums">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate">{choice}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}
