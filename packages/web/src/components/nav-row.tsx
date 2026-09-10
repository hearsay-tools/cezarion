import type { ComponentType, ReactNode, SVGProps } from 'react'

import { cn } from '@/lib/utils'

/**
 * One sidebar navigation row, as the pen.dev redesign draws it (`.pencil/design.pen`,
 * "Navigation — selected Tasks"): a 30px row on desktop, a 44px touch target in the drawer; the
 * selected row wears a translucent brand fill, a 1px brand ring, accent ink, and a 3×18 brand bar
 * on its leading edge. Every other row is muted ink that brightens on hover.
 *
 * Shared by the flat single-project nav (`app-shell.tsx`) and the per-project groups
 * (`project-groups.tsx`) so the two sidebars cannot drift apart on what "selected" looks like —
 * the same reason `StatusDot` exists once.
 *
 * Classes only: the caller owns the element (a router `Link` with its own `to`, `onClick` and
 * `aria-current`), because which Link — scoped or plain — is the caller's question.
 */
export function navRowClass(active: boolean, className?: string): string {
  return cn(
    // `selection-row` paints the design's 3×18 bar itself (index.css: 3px wide, inset 6px, so
    // 18px tall in the 30px row) off `aria-current`; on nav rows it takes the per-theme
    // `--nav-indicator` (index.css). ONE indicator, not a bar plus a bar — the neutral rail
    // elsewhere stays neutral.
    'selection-row relative flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors [--selection-indicator:var(--nav-indicator)] hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground md:h-[30px]',
    active && 'bg-brand/15 font-semibold text-accent-ink ring-1 ring-brand ring-inset hover:bg-brand/20 hover:text-accent-ink',
    className,
  )
}

export function NavRowIcon({
  icon: Icon,
  active,
  className,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  active: boolean
  className?: string
}) {
  return (
    <Icon
      className={cn('size-3.5 shrink-0', active ? 'text-accent-ink' : 'text-muted-foreground', className)}
      aria-hidden="true"
    />
  )
}

/** The row's content in the redesign's order: icon → label → trailing. The selected bar is the
 *  row's own `selection-row` indicator, not a child. */
export function NavRowContent({
  icon,
  active,
  children,
  trailing,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  active: boolean
  children: ReactNode
  trailing?: ReactNode
}) {
  return (
    <>
      <NavRowIcon icon={icon} active={active} />
      {children}
      {trailing}
    </>
  )
}
