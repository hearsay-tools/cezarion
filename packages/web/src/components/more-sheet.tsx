import type { ComponentType, SVGProps } from 'react'

import { ChevronRightIcon } from '@/components/design-icons'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import type { NavItem } from '@/components/nav-items'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The tab bar's "More" destination (#621): a bottom sheet holding the views that do not earn a
 * permanent slot. Skills, Workflows and Project settings are always there; Inbox and Automations
 * sit below a divider and only exist while their flag is on, so `items` (the shell's
 * `visibleNavItems`) is the single gate — the same list the desktop sidebar and the ⌘K palette
 * render from, which is what keeps the three from disagreeing.
 *
 * A row closes the sheet AND navigates. Closing on the click, rather than waiting for the route
 * effect, is what covers re-tapping the row of the route the user is already on: no pathname
 * changes then, and the sheet would stay over the view it was asked to reveal.
 */

type Row = { to: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }

/** The settled rows, in the mock's order. Labels differ from the nav's where the sheet is more
 *  specific: the `/settings` nav item is "Settings", but here it is the project's. */
const FIXED_ROWS: readonly { to: string; label: string }[] = [
  { to: '/skills', label: 'Skills' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/settings', label: 'Project settings' },
]

const FLAG_ROWS: readonly string[] = ['/inbox', '/automations']

const ROW_CLASS =
  'flex h-[50px] min-h-11 w-full items-center gap-[14px] rounded-[10px] px-[10px] text-[14.5px] text-foreground hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

export function MoreSheet({
  open,
  onOpenChange,
  projectName,
  items,
  activeTo,
  inboxCount = null,
  skillsUpdateAvailable = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The current project's name, beside the title. Absent on global routes. */
  projectName?: string | null
  /** `visibleNavItems(...)` — the source of the icons and of the Inbox/Automations gates. */
  items: readonly NavItem[]
  activeTo: string | null
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
}) {
  const byPath = new Map(items.map((item) => [item.to, item]))
  const fixed: Row[] = FIXED_ROWS.flatMap(({ to, label }) => {
    const item = byPath.get(to)
    return item ? [{ to, label, icon: item.icon }] : []
  })
  const flagged: Row[] = FLAG_ROWS.flatMap((to) => {
    const item = byPath.get(to)
    return item ? [{ to, label: item.label, icon: item.icon }] : []
  })
  const close = () => onOpenChange(false)

  const renderRow = ({ to, label, icon: Icon }: Row) => {
    const active = to === activeTo
    return (
      <Link
        key={to}
        to={to}
        onClick={close}
        data-slot="more-row"
        data-more-row={to}
        aria-current={active ? 'page' : undefined}
        className={cn(ROW_CLASS, active && 'bg-sidebar-row-selected hover:bg-sidebar-row-selected')}
      >
        <Icon aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {to === '/skills' && skillsUpdateAvailable ? (
          <span data-slot="skills-update" className="shrink-0 rounded-full bg-muted px-[10px] py-[3px] text-[12.5px] font-medium text-foreground">
            1 update
          </span>
        ) : null}
        {to === '/inbox' && inboxCount ? (
          <span data-slot="inbox-count" className="shrink-0 rounded-full bg-inbox-count px-[10px] py-[3px] text-[12.5px] font-semibold text-inbox-count-foreground">
            {inboxCount}
          </span>
        ) : null}
        <ChevronRightIcon aria-hidden="true" className="!size-[15px]" />
      </Link>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-slot="more-sheet"
        showCloseButton={false}
        // Nothing to describe beyond the rows; Radix warns when it cannot find a description.
        aria-describedby={undefined}
        className="gap-0 rounded-t-[20px] border-border bg-sidebar px-[14px] pt-[10px] pb-[max(14px,env(safe-area-inset-bottom))] md:hidden"
      >
        <div aria-hidden="true" className="mx-auto mb-[14px] h-[5px] w-[36px] rounded-[3px] bg-border" />
        <div className="flex items-baseline gap-[10px] px-[10px] pb-[6px]">
          <SheetTitle className="text-[17px] leading-tight font-bold">More</SheetTitle>
          {projectName ? <span data-slot="more-project" className="min-w-0 truncate text-[12.5px] text-soft-foreground">{projectName}</span> : null}
        </div>
        <div className="flex flex-col gap-[2px]">{fixed.map(renderRow)}</div>
        {flagged.length > 0 ? (
          <>
            <div role="separator" className="mx-[10px] mt-[8px] border-t border-border" />
            <div className="px-[10px] pt-[12px] pb-[4px] text-[12px] font-medium text-soft-foreground">Shown when their flag is on</div>
            <div className="flex flex-col gap-[2px]">{flagged.map(renderRow)}</div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
