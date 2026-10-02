import { ChevronDownIcon, SearchIcon } from '@/components/design-icons'
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

import { DEFAULT_AGENT_ACCOUNT_ID, type Runner } from '@open-mercato/cezar-api-client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * The composer's single-choice pill, factored out of new-task.tsx (#401) so the follow-up
 * surface reuses the exact same runner/model control — one pill grammar, one place to change it.
 */

/** The mockup's `.chip`: a quiet bordered pill that darkens on hover. */
export const chipClass =
  'inline-flex h-[26px] min-w-0 max-w-full items-center gap-1.5 rounded-full border border-control-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:border-dashed disabled:bg-muted'

export const chevron = (
  <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-supporting-foreground" />
)

interface GroupMember {
  pill: HTMLElement
  box: HTMLElement
  full: HTMLElement
}
interface PrefixGroup {
  register: (id: string, member: GroupMember) => () => void
  /** True while every pill in the row fits with its prefix. */
  showPrefixes: boolean
}
const PrefixGroupContext = createContext<PrefixGroup | null>(null)

const px = (value: string): number => Number.parseFloat(value) || 0

/** The width a pill needs with its full `Field · value` label: everything around the label box
 * (icon, chevron, gaps, padding, border) plus the label's own intrinsic width. Independent of
 * whether the prefix is currently shown, so the decision cannot feed back into itself. */
function naturalWidth({ pill, box, full }: GroupMember): number {
  const style = getComputedStyle(pill)
  const items = [...pill.children].filter((child) => {
    if (child === box) return false
    const childStyle = getComputedStyle(child)
    return childStyle.display !== 'none' && childStyle.position !== 'absolute'
  })
  const around = items.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
  const gaps = px(style.columnGap) * items.length
  return around + gaps + full.getBoundingClientRect().width
    + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
}

/** The row layout containing the pills: the nearest grid or flex ancestor. */
function rowContainer(pill: HTMLElement): HTMLElement {
  for (let node = pill.parentElement; node; node = node.parentElement) {
    // Grid/flex items blockify inline-flex; the tooltip wrapper is not the shared row.
    if (node.dataset.slot === 'picker-pill-disabled-wrapper') continue
    const display = getComputedStyle(node).display
    if (display === 'grid' || display === 'flex') return node
  }
  return pill.parentElement!
}

/** Pills sharing a visual line must fit it together; separate lines fit independently. */
function allRowsFit(members: GroupMember[]): boolean {
  const lines = new Map<HTMLElement, Map<number, GroupMember[]>>()
  for (const member of members) {
    const container = rowContainer(member.pill)
    const byTop = lines.get(container) ?? new Map<number, GroupMember[]>()
    const top = Math.round(member.pill.getBoundingClientRect().top)
    byTop.set(top, [...(byTop.get(top) ?? []), member])
    lines.set(container, byTop)
  }
  for (const [container, byTop] of lines) {
    const style = getComputedStyle(container)
    const available = container.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
    for (const line of byTop.values()) {
      const needed = line.reduce((sum, member) => sum + naturalWidth(member), 0) + px(style.columnGap) * (line.length - 1)
      if (needed > available + 0.5) return false
    }
  }
  return true
}

/**
 * Coordinates the prefixes of sibling pills (#541). Wrap a runner/model/effort row in it: every
 * prefix drops as soon as the row cannot hold all of them, so no value truncates while a sibling
 * still spends width on a prefix, and they return together once everything fits. Outside a group
 * each pill decides for itself (#522). Renders no DOM, so the row's own layout is untouched.
 */
export function PickerPillGroup({ children }: { children: ReactNode }) {
  const members = useRef(new Map<string, GroupMember>())
  const observer = useRef<ResizeObserver | null>(null)
  const [showPrefixes, setShowPrefixes] = useState(true)
  const evaluate = useCallback(() => setShowPrefixes(allRowsFit([...members.current.values()])), [])
  const register = useCallback((id: string, member: GroupMember) => {
    members.current.set(id, member)
    if (typeof ResizeObserver !== 'undefined') {
      observer.current ??= new ResizeObserver(evaluate)
      for (const element of [member.box, member.full, rowContainer(member.pill)]) observer.current.observe(element)
    }
    evaluate()
    return () => {
      members.current.delete(id)
      if (typeof ResizeObserver !== 'undefined') {
        for (const element of [member.box, member.full]) observer.current?.unobserve(element)
      }
      evaluate()
    }
  }, [evaluate])
  useLayoutEffect(() => () => observer.current?.disconnect(), [])
  const value = useMemo(() => ({ register, showPrefixes }), [register, showPrefixes])
  return <PrefixGroupContext.Provider value={value}>{children}</PrefixGroupContext.Provider>
}

/** Keep the intrinsic full-label width even when the prefix is hidden, avoiding a
 * shrink/restore loop on auto-sized pills. Both measurements follow the actual font
 * and container; a breakpoint cannot tell whether a particular value fits. In a group the
 * hidden prefix releases its width to the row instead (#541): the group measures the natural
 * width itself, so nothing here feeds back into the decision. */
function FieldLabel({ field, children }: { field: string; children: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const group = useContext(PrefixGroupContext)
  const register = group?.register
  const id = useId()
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const container = box.current!
    const full = measure.current!
    if (register) {
      const pill = container.closest<HTMLElement>('[data-slot$="pill"]')
      return pill ? register(id, { pill, box: container, full }) : undefined
    }
    const update = () => setFits(
      full.getBoundingClientRect().width <= container.getBoundingClientRect().width + 0.5,
    )
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(container)
    observer.observe(full)
    return () => observer.disconnect()
  }, [field, children, id, register])
  const grouped = group !== null
  const showField = grouped ? group.showPrefixes : fits
  // Grouped and prefix-less, the visible label carries the width itself so the row can reclaim it.
  const releasing = grouped && !showField
  return (
    <span ref={box} className="relative min-w-0 overflow-hidden" aria-hidden="true">
      <span ref={measure} className={cn('invisible w-max whitespace-nowrap', releasing ? 'absolute left-0 top-0' : 'block')}>{field} · {children}</span>
      <span data-slot="picker-label" className={cn('block truncate', releasing ? 'relative' : 'absolute inset-0')}>
        {showField ? <span className="text-muted-foreground">{field} · </span> : null}{children}
      </span>
    </span>
  )
}

/** A generic single-choice pill (runner / model / variants): DropdownMenu radio semantics,
 *  two-line items (label + quiet description), disabled state carries its reason as `title`. */
export function PickerPill({
  slot,
  ariaLabel,
  label,
  value,
  options,
  onPick,
  disabled = false,
  readOnly = false,
  hint,
  disabledHint,
  status,
  searchPlaceholder,
  icon,
  fieldLabel = false,
}: {
  slot: string
  ariaLabel: string
  label: ReactNode
  /** Optional engine-control presentation; compact composer pills keep their defaults. */
  icon?: ReactNode
  fieldLabel?: boolean
  value: string
  options: ReadonlyArray<{ value: string; label: string; desc?: string }>
  onPick: (value: string) => void
  disabled?: boolean
  /** Display the resolved value without presenting a selector. */
  readOnly?: boolean
  /** Hover explanation for the enabled pill — what the setting does (e.g. the ×1 variants pill). */
  hint?: string
  disabledHint?: string
  /** Quiet non-selectable catalog state, kept inside the menu's accessible reading order. */
  status?: string
  /** Add a name filter above longer option catalogs. */
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const visibleOptions = searchPlaceholder
    ? options.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options

  useEffect(() => {
    if (!open || !searchPlaceholder) return
    const timeout = window.setTimeout(() => searchRef.current?.focus())
    return () => window.clearTimeout(timeout)
  }, [open, searchPlaceholder])

  const retainSearchFocus = (event: PointerEvent<HTMLElement>) => {
    if (searchRef.current && document.activeElement === searchRef.current) event.preventDefault()
  }

  const presentation = icon ? ' h-11 gap-2 rounded-lg border-border px-3 text-foreground' : ''
  const fullLabel = fieldLabel
    ? `${ariaLabel} · ${typeof label === 'string' ? label : options.find(option => option.value === value)?.label ?? value}`
    : ariaLabel
  const explanation = readOnly ? disabledHint ?? hint : disabled ? disabledHint : hint
  const title = fieldLabel ? [fullLabel, explanation].filter(Boolean).join(' — ') : explanation
  const contents = <>{icon}{fieldLabel
    ? <FieldLabel field={ariaLabel}>{label}</FieldLabel>
    : <span className="min-w-0 truncate" title={typeof label === 'string' ? label : undefined}>{label}</span>}</>
  if (readOnly) {
    return (
      <span
        data-slot={slot}
        aria-label={fullLabel}
        title={title}
        className={cn(chipClass, presentation, 'cursor-default hover:bg-card hover:text-muted-foreground')}
      >
        {contents}
        {fieldLabel ? <span className="sr-only">{fullLabel}</span> : null}
      </span>
    )
  }
  const trigger = (
    <button
      type="button"
      data-slot={slot}
      aria-label={fullLabel}
      disabled={disabled}
      title={title}
      className={cn(chipClass, presentation)}
    >
      {contents}
      {icon ? <ChevronDownIcon aria-hidden="true" className="size-[13px] shrink-0 text-muted-foreground" /> : chevron}
    </button>
  )
  // Radix never opens a disabled trigger, but `disabled:pointer-events-none` would also kill
  // the explanatory title tooltip — so the disabled pill renders bare, in a plain span wrapper
  // that still receives hover.
  if (disabled) {
    return (
      <span data-slot="picker-pill-disabled-wrapper" title={title} className="inline-flex min-w-0 max-w-full">
        {trigger}
      </span>
    )
  }
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent ref={contentRef} align="start" data-testid={`${slot}-menu`}>
        {searchPlaceholder ? (
          <div className="mb-1 flex min-h-11 items-center gap-2 border-b border-border px-2">
            <SearchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="search"
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  event.stopPropagation()
                  const options = contentRef.current?.querySelectorAll<HTMLElement>(
                    '[role="menuitemradio"]:not([data-disabled])',
                  )
                  const next = event.key === 'ArrowDown' ? options?.[0] : options?.[options.length - 1]
                  next?.focus()
                } else if (event.key !== 'Escape') {
                  // Keep printable keys out of Radix's typeahead. Once an arrow moves focus into
                  // the menu, Radix owns the usual ArrowUp/ArrowDown/Enter interaction again.
                  event.stopPropagation()
                }
              }}
              className="h-11 w-48 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : null}
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {visibleOptions.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className={cn('gap-2.5', searchPlaceholder && 'min-h-11')}
              onPointerMove={retainSearchFocus}
              onPointerLeave={retainSearchFocus}
              onKeyDown={(event) => {
                if (searchRef.current && ((event.key === 'ArrowUp' && option === visibleOptions[0])
                  || (event.key === 'Tab' && event.shiftKey))) {
                  event.preventDefault()
                  event.stopPropagation()
                  searchRef.current.focus()
                }
              }}
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium">{option.label}</span>
                {option.desc ? (
                  <span className="text-[11px] text-muted-foreground">{option.desc}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {searchPlaceholder && visibleOptions.length === 0 ? (
          <p role="status" className="px-2 py-5 text-center text-xs text-muted-foreground">No matches found.</p>
        ) : null}
        {status ? (
          <DropdownMenuItem disabled onPointerMove={retainSearchFocus} onPointerLeave={retainSearchFocus} className="border-t border-border text-[11px] text-muted-foreground">
            {status}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One agent account, as this pill needs to show it (spec 2026-07-29-agent-profiles).
 *
 * `id` is the reserved `default` for the DISCOVERED account — the one `agentHomePaths()` finds —
 * and a stored slug otherwise.
 */
export interface RunnerAccountChoice {
  provider: Runner
  id: string
  label: string
  /** The folder, as written. The labels are cezar's invention; the folder IS the account. */
  configDir: string
}

/** How one row of the pill's menu is addressed: the agent, and which of its logins. */
const choiceValue = (runner: Runner, account: string | null): string =>
  account === null ? runner : `${runner}:${account}`

/**
 * Which agent — and, when there is more than one login for it, which account — in ONE flat list:
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * Not a runner group with an account group nested under it. Every row is a concrete thing that can
 * run this task, so what will happen is readable at a glance instead of assembled from two
 * selections. An agent with a single login stays a single row, which is why a machine with no extra
 * accounts sees exactly the list it always saw.
 *
 * The pill renders for a CHOICE: more than one runner, or more than one account for one runner. A
 * host with one agent and one login has neither, and the caller leaves it out.
 *
 * Three wire states, and the difference between the first two matters:
 *   - `account === null` — follow the repo's setting. What an untouched pill means, and it stays
 *     true if that setting changes before the task starts.
 *   - `'default'` — the discovered account, EXPLICITLY. Beats the repo setting server-side
 *     (`selectProfile`), which is what makes "claude · Default" mean it in a repo set to another
 *     account.
 *   - a stored id — that account.
 */
export function RunnerPill({
  runners,
  value,
  onPick,
  disabled = false,
  accounts = [],
  account = null,
  repoAccount,
  icon,
  fieldLabel,
}: {
  runners: readonly Runner[]
  icon?: ReactNode
  fieldLabel?: boolean
  value: Runner
  /** `account` is `null` only while the repo's own choice is still the one in force. */
  onPick: (runner: Runner, account: string | null) => void
  disabled?: boolean
  /** Every login for every runner, discovered accounts included. Empty = the zero-config host. */
  accounts?: readonly RunnerAccountChoice[]
  /** The per-task override. */
  account?: string | null
  /** What the repo's setting resolves to per runner — the row that is selected until overridden. */
  repoAccount?: Partial<Record<Runner, string>>
}) {
  const available = RUNNERS.filter((r) => runners.includes(r.id))
  const options = available.flatMap((runner) => {
    const logins = accounts.filter((entry) => entry.provider === runner.id)
    // One login is not a choice, so it does not become a row of its own — the agent is the row.
    if (logins.length < 2) return [{ value: choiceValue(runner.id, null), label: runner.id, desc: runner.desc }]
    return logins.map((login) => ({
      value: choiceValue(runner.id, login.id),
      label: `${runner.id} · ${login.label}`,
      // The folder, because the label is cezar's invention and the folder is the account.
      desc: login.configDir,
    }))
  })

  // What is selected right now: the override if the user made one, else whatever the repo resolves
  // to, else the discovered account. Falls back to the plain runner row for an agent with one login
  // — and for an override naming an account that has since been deleted, which must not leave the
  // pill pointing at nothing.
  const selected = account ?? repoAccount?.[value] ?? DEFAULT_AGENT_ACCOUNT_ID
  const value_ = options.some((option) => option.value === choiceValue(value, selected))
    ? choiceValue(value, selected)
    : choiceValue(value, null)

  return (
    <PickerPill
      icon={icon}
      fieldLabel={fieldLabel}
      slot="runner-pill"
      ariaLabel="Runner"
      label={options.find((option) => option.value === value_)?.label ?? value}
      value={value_}
      disabled={disabled}
      onPick={(next) => {
        const [runner, picked] = next.split(':')
        onPick(runner as Runner, picked ?? null)
      }}
      options={options}
    />
  )
}
