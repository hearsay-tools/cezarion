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

/*
 * The per-view sidebar lists (#622): Settings, GitHub and Git all build their body from these,
 * so the three cannot drift apart. Numbers are the design board's (`cezarion-session.pen`,
 * "Sidebar v3 · per-project views" and "Sidebar v4 · project rail"), in fixed px so a density
 * that shrinks `--spacing` cannot shrink a list the mockups draw at one size.
 *
 * The body sits 12px under the view tabs; its optional heading is a 26px bar with 12px beneath
 * it. A group is a column of rows 1px apart, led by its label (2px above, 4px below the text).
 * A labelled group that follows another one starts 18px lower (the board's 12px body gap plus
 * the group's own 6px top padding); an unlabelled nav hands over to the next group at 12px.
 */
export const SIDEBAR_LIST_BODY_CLASS = 'px-2 pt-[12px]'
export const SIDEBAR_LIST_HEADING_CLASS = 'mb-[12px] flex h-[26px] items-center pr-[6px] pl-[10px] text-[13px] font-semibold'
export const SIDEBAR_LIST_GROUP_CLASS = 'mb-[18px] flex flex-col gap-px'
export const SIDEBAR_LIST_UNLABELLED_GROUP_CLASS = 'mb-[12px] flex flex-col gap-px'
export const SIDEBAR_LIST_GROUP_LABEL_CLASS = 'truncate px-[10px] pt-[2px] pb-[4px] text-[11px] font-medium text-soft-foreground'
/** A 32px row: 15px icon, 13px label, 10px padding and gap. Add the hover, or a disabled look. */
export const SIDEBAR_LIST_ROW_CLASS = 'group flex h-[32px] items-center gap-[10px] rounded-[6px] px-[10px] text-[13px] text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring'
export const SIDEBAR_LIST_ROW_HOVER_CLASS = 'hover:bg-sidebar-row-hover hover:text-foreground'
export const SIDEBAR_LIST_ICON_CLASS = 'size-[15px] shrink-0 text-soft-foreground group-aria-[current=page]:text-foreground'
export const SIDEBAR_LIST_COUNT_CLASS = 'ml-auto text-[11.5px] tabular-nums text-soft-foreground'

/*
 * The same lists as their own phone screen (board "Mobile · same principles", GitHub screen):
 * 14px screen padding, a 22px bold title, 16px between groups, 12px group labels, and 48px rows
 * with an 18px icon, a 14px label, a 13px count and a 15px chevron.
 */
export const SCREEN_LIST_BODY_CLASS = 'flex min-h-full flex-col px-[14px] pt-[14px] pb-[calc(90px+env(safe-area-inset-bottom))]'
export const SCREEN_LIST_TITLE_CLASS = 'px-[10px] text-[22px] leading-tight font-bold'
export const SCREEN_LIST_GROUP_CLASS = 'mb-[16px] flex flex-col'
export const SCREEN_LIST_GROUP_LABEL_CLASS = 'px-[10px] pt-[2px] pb-[4px] text-[12px] font-medium text-soft-foreground'
export const SCREEN_LIST_ROW_CLASS = 'group flex h-[48px] items-center gap-[12px] rounded-[8px] px-[10px] text-[14px] text-foreground focus-visible:outline-2 focus-visible:outline-ring'
export const SCREEN_LIST_ICON_CLASS = 'size-[18px] shrink-0 text-soft-foreground group-aria-[current=page]:text-foreground'
export const SCREEN_LIST_COUNT_CLASS = 'ml-auto text-[13px] tabular-nums text-soft-foreground'
export const SCREEN_LIST_CHEVRON_CLASS = 'size-[15px] shrink-0 text-soft-foreground'
