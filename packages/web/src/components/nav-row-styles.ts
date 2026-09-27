import { cn } from '@/lib/utils'

/*
 * One selection language for the sidebar (#617 addendum 01c): a selected nav item looks like a
 * selected task row. The single-project nav (`app-shell.tsx`), every project group's nav
 * (`project-groups.tsx`), New task on `/new` and the footer's active icon all read their classes
 * from here, so the fills the addendum requires to match cannot drift apart. No teal: the brand
 * accent stays out of the sidebar list, and badges take the colour of what they mean.
 */

/** The fill, ink and weight a selected sidebar item shares with a selected task row. */
export const SIDEBAR_SELECTED_CLASS = 'bg-sidebar-row-selected text-foreground font-medium hover:bg-sidebar-row-selected'

/**
 * A nav row. `h-11` is the drawer's touch target; desktop relaxes to the mockup's 30px. Below
 * 48rem the unlayered floor in `styles/index.css` holds `nav a` at 44px whatever the density.
 * Hover takes the task row's neutral hover fill; `group/nav` lets the icon follow the label.
 */
export function navRowClass(isActive: boolean): string {
  return cn(
    'selection-row group/nav focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-normal text-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-foreground md:h-[30px]',
    isActive && SIDEBAR_SELECTED_CLASS,
  )
}

/** The row's icon: `--soft-foreground` at rest, `--foreground` when the row is hovered or selected. */
export function navIconClass(isActive: boolean): string {
  return cn('size-[15px] shrink-0 group-hover/nav:text-foreground', isActive ? 'text-foreground' : 'text-soft-foreground')
}

/* The count chips share the variant letter chip's geometry in fixed px, so a density that
 * shrinks `--spacing` cannot shrink them. */
const NAV_COUNT_SHAPE = 'ml-auto rounded-[9px] px-[6px] py-px text-[11px] leading-[16px] font-semibold tabular-nums'

/** The Inbox count: soft amber, because follow-ups wait for you (tokens in `styles/index.css`). */
export const NAV_INBOX_COUNT_CLASS = cn(NAV_COUNT_SHAPE, 'bg-inbox-count text-inbox-count-foreground')

/**
 * The Tasks unread count: neutral, because unread is news rather than a to-do. On a selected
 * row the `--muted` chip would sit on a near-identical fill, so it takes `--sidebar`, the same
 * rule the variant letter chip follows.
 */
export function navUnreadCountClass(isActive: boolean): string {
  return cn(NAV_COUNT_SHAPE, 'text-foreground', isActive ? 'bg-sidebar' : 'bg-muted')
}

/** The Skills update marker: a 6px `--info` dot, the meaning it carries on the Skills tab too. */
export const NAV_UPDATE_DOT_CLASS = 'size-[6px] rounded-full bg-info'

/** The footer's active icon (All tasks, Global settings): a 36px square on the selected fill. */
export const FOOTER_ICON_ACTIVE_CLASS = 'bg-sidebar-row-selected text-foreground hover:bg-sidebar-row-selected'
