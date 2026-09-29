import * as React from 'react'

import { EllipsisIcon, PlusIcon } from '@/components/design-icons'
import { MoreSheet } from '@/components/more-sheet'
import { MORE_SHEET_PATHS, TAB_BAR_PATHS, type NavItem } from '@/components/nav-items'
import { SignalPill, signalPillSegments } from '@/components/signal-pill'
import type { ProjectSignal } from '@/lib/project-signal'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The phone's view switcher (#621), mirroring the desktop view tabs: Tasks, Git, GitHub (only
 * while the forge is available) and More, in the slot the shell reserves as grid row 4. It is
 * for LIST screens; the shell does not render it on a pushed screen (an opened task) or while
 * the keyboard is up, and the floating New task button rides along with it for the same reasons.
 *
 * `items` is `visibleNavItems(...)`, so the forge gate is decided once, for every surface. The
 * bar restricts it to `TAB_BAR_PATHS`; the rest are the More sheet's.
 *
 * The Tasks badge is the current project's TOP pill only (amber needs you, red unread failure).
 * The bottom "in motion" pill stays off the bar: it is status, not a reason to tap.
 */
export function MobileTabBar({
  items,
  activeTo,
  signal,
  projectName,
  inboxCount,
  skillsUpdateAvailable,
  showNewTask = true,
}: {
  items: readonly NavItem[]
  activeTo: string | null
  /** The current project's signal; undefined while unknown or outside a project. */
  signal?: ProjectSignal
  projectName?: string | null
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
  /** The floating New task button. Off on `/new`, where it would point at the page it is on. */
  showNewTask?: boolean
}) {
  const [moreOpen, setMoreOpen] = React.useState(false)
  const tabs = items.filter((item) => TAB_BAR_PATHS.includes(item.to))
  const moreActive = activeTo !== null && MORE_SHEET_PATHS.includes(activeTo)
  const { top } = signalPillSegments(signal)
  const tasksBadge = top.some((segment) => segment.count > 0)

  const tabClass = (active: boolean) =>
    cn(
      'relative flex h-full min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-[3px] text-[10.5px] leading-none focus-visible:outline-2 focus-visible:outline-ring',
      active ? 'font-semibold text-foreground' : 'font-medium text-soft-foreground',
    )

  return (
    <>
      {showNewTask ? (
        // Above the bar rather than inside it: `bottom-full` measures from the row's top edge, so
        // the 16px gap holds whatever safe-area inset the row is padding itself with.
        <Link
          to="/new"
          data-slot="mobile-new-task"
          className="absolute right-4 bottom-full z-30 mb-4 flex h-12 items-center gap-2 rounded-[24px] bg-foreground px-[18px] text-[14px] font-semibold text-background shadow-[0_8px_24px_#00000055] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <PlusIcon aria-hidden="true" className="size-[18px]" />
          New task
        </Link>
      ) : null}
      <nav aria-label="Views" data-slot="mobile-tab-bar" className="flex h-[54px] items-stretch">
        {tabs.map((item) => {
          const active = item.to === activeTo
          const Icon = item.icon
          const badge = item.to === '/' && tasksBadge
          return (
            <Link
              key={item.to}
              to={item.to}
              data-tab={item.to}
              aria-current={active ? 'page' : undefined}
              className={tabClass(active)}
            >
              <span className="relative">
                <Icon aria-hidden="true" className="size-[21px]" />
                {badge ? <SignalPill position="top" segments={top} className="-top-[6px] -right-[10px] border-sidebar" /> : null}
              </span>
              {item.label}
            </Link>
          )
        })}
        <button
          type="button"
          data-tab="more"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          data-active={moreActive ? 'true' : undefined}
          onClick={() => setMoreOpen(true)}
          className={tabClass(moreActive)}
        >
          <span className="relative">
            <EllipsisIcon aria-hidden="true" className="size-[21px]" />
          </span>
          More
        </button>
      </nav>
      <MoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        projectName={projectName}
        items={items}
        activeTo={activeTo}
        inboxCount={inboxCount}
        skillsUpdateAvailable={skillsUpdateAvailable}
      />
    </>
  )
}
