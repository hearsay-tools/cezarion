import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { filterTemplateSuggestions } from '@/lib/github-templates'
import { cn } from '@/lib/utils'

/**
 * The New project dialog's template field: free text (`owner/repo` or a GitHub URL) with the
 * curated suggestions listed under it (spec 2026-10-15-create-new-project).
 *
 * The list is rendered INLINE, not in a portalled popover: a portal sits outside the dialog's DOM,
 * where the dialog's scroll lock swallows wheel and touch scrolling (open-mercato/cezar#1402 hit
 * exactly that). It is always visible while the template mode is chosen, so picking never resizes
 * the dialog under the pointer. Keyboard: ArrowDown/ArrowUp move the highlight, Enter picks it.
 */
export function GithubTemplateInput({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  id: string
}) {
  const listId = useId()
  const suggestions = filterTemplateSuggestions(value)
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLUListElement>(null)

  // A new query starts the highlight over: the old index points into a different list.
  useEffect(() => setActive(-1), [value])

  useEffect(() => {
    if (active < 0) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const optionId = (index: number) => `${listId}-option-${index}`

  return (
    <div className="grid min-w-0 gap-1.5">
      <Input
        id={id}
        data-slot="create-project-template"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="owner/repo or https://github.com/owner/repo"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (suggestions.length === 0) return
            const down = event.key === 'ArrowDown'
            // With nothing highlighted, Down starts at the first suggestion and Up at the last.
            setActive((current) =>
              current < 0
                ? down ? 0 : suggestions.length - 1
                : (current + (down ? 1 : -1) + suggestions.length) % suggestions.length,
            )
          } else if (event.key === 'Enter' && active >= 0) {
            // Enter picks the highlighted suggestion; it never submits the form behind it.
            event.preventDefault()
            event.stopPropagation()
            const picked = suggestions[active]
            if (picked) onChange(picked.slug)
          }
        }}
      />
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Suggested templates"
        data-slot="create-project-template-list"
        className="max-h-48 min-h-0 overflow-y-auto overscroll-contain rounded-md border border-border"
      >
        {suggestions.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted-foreground" role="presentation">
            No suggestion matches — any GitHub template repository works.
          </li>
        ) : (
          suggestions.map((suggestion, index) => {
            const chosen = suggestion.slug.toLowerCase() === value.trim().toLowerCase()
            return (
              <li
                key={suggestion.slug}
                id={optionId(index)}
                role="option"
                aria-selected={chosen}
                data-index={index}
                data-slot="create-project-template-option"
                // mousedown would move focus off the input; the pick happens on click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!disabled) onChange(suggestion.slug)
                }}
                className={cn(
                  'grid min-h-11 cursor-pointer content-center gap-0.5 px-3 py-1.5 text-start',
                  'pointer-hover:hover:bg-accent',
                  index === active && 'bg-accent',
                  chosen && 'font-medium',
                )}
              >
                <span className="truncate text-[13px]">
                  {suggestion.label} <span className="font-mono text-[11px] text-soft-foreground">{suggestion.slug}</span>
                </span>
                <span className="truncate text-xs text-muted-foreground">{suggestion.description}</span>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}
